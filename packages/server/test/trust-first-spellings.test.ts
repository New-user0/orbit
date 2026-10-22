import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { Global } from "@orbit/util/global"
import { startServer } from "./fixture/server"

// A door that takes a folder besides its Location (a destination, a working folder, a parent for worktrees, a file to
// write) reads it once from a folder of its own: the session's for a move and a session's terminal, the Location's for a
// command, a terminal, a file and an MCP server, the project's for a worktree. The folder it checks is the folder it then
// acts in, so a spelling that the server's own folder would read differently cannot pass the check for one folder and act
// in another (class 3). Each door is asked with every spelling of a folder that is not trusted, and refuses it naming the
// folder as it really is, leaving nothing there; then with every spelling of a trusted folder, where it acts.

const untrusted = { trust: { implicit: false } }

type Body = {
  readonly _tag?: string
  readonly directory?: string
  readonly data?: { readonly id: string; readonly location: { readonly directory: string } }
  readonly project?: { readonly id: string }
}
type Server = { readonly base: string; readonly headers: Record<string, string> }
// What a door answered, and the session it was asked about where it acts on one.
type Acted = { readonly answer: { readonly status: number; readonly body?: Body }; readonly id?: string }

function request(server: Server, method: string, route: string, input: { directory?: string; body?: unknown } = {}) {
  const url = new URL(route, server.base)
  if (input.directory !== undefined) url.searchParams.set("location[directory]", input.directory)
  return fetch(url, {
    method,
    headers: { ...server.headers, "content-type": "application/json" },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  }).then(async (response) => ({
    status: response.status,
    body: (await response.json().catch(() => undefined)) as Body | undefined,
  }))
}

const grant = (server: Server, directory: string) =>
  request(server, "POST", "/api/location/trust", { directory, body: { trust: true, persist: false } })

const refusedFor = (directory: string) => ({
  status: 403,
  body: expect.objectContaining({ _tag: "UntrustedFolderError", directory }),
})

// Folders below the home folder, so that each has a `~` spelling: a trusted repository, a folder nothing trusts and a
// second trusted folder, each reachable through a link in the repository as well. A junction on Windows needs no
// privilege. The two targets have an accented letter in their names, in Unicode's composed form, so that a name sent in
// the decomposed form is read as the same folder.
const names = { other: "othér", trusted: "trustéd" }
const layout = Effect.gen(function* () {
  const made = yield* Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(Global.Path.home, "orbit-spellings-"))),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  )
  const real = yield* Effect.promise(() => fs.realpath(made))
  const folders = {
    config: path.join(real, "config"),
    repo: path.join(real, "repo"),
    other: path.join(real, names.other),
    trusted: path.join(real, names.trusted),
  }
  yield* Effect.promise(async () => {
    for (const folder of Object.values(folders)) await fs.mkdir(folder, { recursive: true })
    await $`git init -q`.cwd(folders.repo).quiet()
    await $`git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init`
      .cwd(folders.repo)
      .quiet()
    const kind = process.platform === "win32" ? "junction" : "dir"
    await fs.symlink(folders.other, path.join(folders.repo, "into-other"), kind)
    await fs.symlink(folders.trusted, path.join(folders.repo, "into-trusted"), kind)
  })
  // Every way a request can name `target`, read from the repository. The `~` spelling starts from the home folder as the
  // server reads it, and the Git Bash one is a Windows spelling only.
  const spellings = (name: "other" | "trusted") => {
    const target = folders[name]
    const drive = /^([A-Za-z]):\\(.*)$/.exec(target)
    return [
      ["absolute", target],
      ["relative", path.relative(folders.repo, target)],
      ["home", `~/${path.relative(Global.Path.home, path.join(made, names[name])).replaceAll("\\", "/")}`],
      ["link", path.join(folders.repo, `into-${name}`)],
      ["decomposed", target.normalize("NFD")],
      ...(process.platform === "win32" && drive
        ? [["git bash", `/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`]]
        : []),
    ] as const
  }
  return { folders, spellings }
})

const settle = async (check: () => Promise<boolean>, limit = 15_000) => {
  const deadline = Date.now() + limit
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(100)
  return check()
}
const exists = (file: string) => Bun.file(file).exists()
const marker = (name: string) => `CLONE-${name.replaceAll(" ", "-")}`
// A program that leaves a marker in the folder it starts in.
const leaves = (name: string) => [
  process.execPath,
  "-e",
  `require("fs").writeFileSync(${JSON.stringify(marker(name))}, "ran")`,
]

it.live(
  "every door that takes a folder reads it from its own base, refuses an untrusted one however it is spelled, and acts in a trusted one",
  () =>
    Effect.gen(function* () {
      const fixture = yield* layout
      const folders = fixture.folders
      // A session's terminal runs in a daemon of its own; naming one that is not there makes a terminal that gets past the
      // check fail at once with the daemon's error.
      const previous = process.env.ORBIT_PTY_BIN
      process.env.ORBIT_PTY_BIN = path.join(folders.config, "missing-orbit-pty")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ORBIT_PTY_BIN
          if (previous !== undefined) process.env.ORBIT_PTY_BIN = previous
        }),
      )
      const server = yield* startServer(folders.config, untrusted)
      yield* Effect.promise(async () => {
        expect((await grant(server, folders.repo)).status).toBe(200)
        expect((await grant(server, folders.trusted)).status).toBe(200)
        const projectID = (await request(server, "GET", "/api/location", { directory: folders.repo })).body?.project?.id
        const session = async () =>
          (await request(server, "POST", "/api/session", { body: { location: { directory: folders.repo } } })).body
            ?.data?.id ?? ""
        const where = async (id: string) =>
          (await request(server, "GET", `/api/session/${id}`)).body?.data?.location.directory ?? ""
        // Each door, asked to act in `value` under the name `name`, with what it leaves behind when it acts.
        const doors: Record<string, (value: string, name: string) => Promise<Acted>> = {
          "session.move": async (value: string) => {
            const id = await session()
            const answer = await request(server, "POST", `/api/session/${id}/move`, { body: { directory: value } })
            return { answer, id }
          },
          "mcp.add": async (value: string, name: string) => ({
            answer: await request(server, "PUT", `/api/experimental/mcp/add-${name.replaceAll(" ", "-")}`, {
              directory: folders.repo,
              body: { config: { type: "local", command: leaves(`mcp-${name}`), cwd: value } },
            }),
          }),
          "worktree.create": async (value: string, name: string) => ({
            answer: await request(server, "POST", "/api/worktree", {
              body: { projectID, directory: value, name: `wt-${name.replaceAll(" ", "-")}` },
            }),
          }),
          "shell.create": async (value: string, name: string) => ({
            answer: await request(server, "POST", "/api/shell", {
              directory: folders.repo,
              body: { command: `echo ran > ${marker(`shell-${name}`)}`, cwd: value },
            }),
          }),
          "pty.create": async (value: string) => ({
            answer: await request(server, "POST", "/api/pty", {
              directory: folders.repo,
              body: { command: process.execPath, args: ["--version"], cwd: value },
            }),
          }),
          "persistentPty.create": async (value: string) => ({
            answer: await request(server, "POST", `/api/experimental/session/${await session()}/terminal`, {
              body: { args: [], cwd: value, title: "Terminal", env: {} },
            }),
          }),
          "fs.write": async (value: string, name: string) => {
            const url = new URL("/api/experimental/fs/write", server.base)
            url.searchParams.set("location[directory]", folders.repo)
            url.searchParams.set("path", `${value}/${marker(`write-${name}`)}`)
            const response = await fetch(url, {
              method: "POST",
              headers: { ...server.headers, "content-type": "application/octet-stream" },
              body: "written",
            })
            return { answer: { status: response.status, body: (await response.json()) as Body } }
          },
        }

        // Refused, naming the folder as it really is, whatever the spelling, and a session that was to move stays put.
        for (const [door, act] of Object.entries(doors))
          for (const [spelling, value] of fixture.spellings("other")) {
            const result = await act(value, spelling)
            expect({ door, spelling, answer: result.answer }).toEqual({
              door,
              spelling,
              answer: refusedFor(folders.other),
            })
            if (result.id !== undefined) expect(await where(result.id)).toBe(folders.repo)
          }
        // A name with a null byte, which no file system takes, is refused as a bad request.
        for (const [door, act] of Object.entries(doors))
          expect({ door, status: (await act(`${folders.trusted}\0x`, "null byte")).answer.status }).toEqual({
            door,
            status: 400,
          })
        // A terminal for a session that is not known has no folder to read a relative name from, so it takes only an
        // absolute one; the absolute one gets past the check and fails only for want of a daemon.
        const unknown = (cwd: string) =>
          request(server, "POST", "/api/experimental/session/ses_unknown_terminal/terminal", {
            body: { args: [], cwd, title: "Terminal", env: {} },
          }).then((answer) => answer.status)
        expect(await unknown(path.relative(folders.repo, folders.trusted))).toBe(400)
        expect(await unknown(folders.trusted)).toBe(503)
        await Bun.sleep(1_000)
        // Nothing ran, was written or was made in the untrusted folder.
        expect(await fs.readdir(folders.other)).toEqual([])
        expect(await fs.readdir(folders.trusted)).toEqual([])

        // The trusted control: each door acts in the folder, however it is spelled.
        const acted = {
          "session.move": async (_: string, result: Acted) =>
            settle(async () => (await fs.realpath(await where(result.id ?? "")).catch(() => "")) === folders.trusted),
          "mcp.add": (name: string) => settle(() => exists(path.join(folders.trusted, marker(`mcp-${name}`)))),
          "worktree.create": (name: string) =>
            exists(path.join(folders.trusted, `wt-${name.replaceAll(" ", "-")}`, ".git")),
          "shell.create": (name: string) => settle(() => exists(path.join(folders.trusted, marker(`shell-${name}`)))),
          "pty.create": async () => true,
          "persistentPty.create": async () => true,
          "fs.write": (name: string) => exists(path.join(folders.trusted, marker(`write-${name}`))),
        } as Record<string, (name: string, result: Acted) => Promise<boolean>>
        // A session's terminal gets past the check and fails only for want of a daemon.
        const status = { "persistentPty.create": 503, "session.move": 204, "mcp.add": 204 } as Record<string, number>
        for (const [door, act] of Object.entries(doors))
          for (const [spelling, value] of fixture.spellings("trusted")) {
            const result = await act(value, spelling)
            expect({ door, spelling, status: result.answer.status }).toEqual({
              door,
              spelling,
              status: status[door] ?? 200,
            })
            expect({ door, spelling, acted: await acted[door]?.(spelling, result) }).toEqual({
              door,
              spelling,
              acted: true,
            })
          }
      })
    }),
  120_000,
)

it.live(
  "a local MCP server whose config names a working folder that is not trusted waits for it, however it is spelled, and starts there once it is",
  () =>
    Effect.gen(function* () {
      const fixture = yield* layout
      const folders = fixture.folders
      const servers = Object.fromEntries(
        (["other", "trusted"] as const).flatMap((name) =>
          fixture
            .spellings(name)
            .map(([spelling, value]) => [
              `${name}-${spelling.replaceAll(" ", "-")}`,
              { type: "local", command: leaves(`config-${spelling}`), cwd: value },
            ]),
        ),
      )
      // And one whose working folder is a name no file system takes, and one in a linked worktree of the repository, whose
      // decision is its main checkout's, as for a Location there.
      const unnamed = { type: "local", command: leaves("config-null-byte"), cwd: `${folders.trusted}\0x` }
      const linked = path.join(path.dirname(folders.repo), "linked")
      yield* Effect.promise(async () => {
        await $`git worktree add -q ${linked}`.cwd(folders.repo).quiet()
        const extra = {
          "null-byte": unnamed,
          linked: { type: "local", command: leaves("config-linked"), cwd: linked },
        }
        await Bun.write(path.join(folders.repo, "orbit.json"), JSON.stringify({ mcp: { servers: { ...servers, ...extra } } }))
      })
      const server = yield* startServer(folders.config, untrusted)
      yield* Effect.promise(async () => {
        expect((await grant(server, folders.repo)).status).toBe(200)
        expect((await grant(server, folders.trusted)).status).toBe(200)
        const statuses = async () => {
          const answer = await fetch(
            new URL(`/api/mcp?location[directory]=${encodeURIComponent(folders.repo)}`, server.base),
            {
              headers: server.headers,
            },
          )
          const body = (await answer.json()) as {
            readonly data: readonly { readonly name: string; readonly status: { status: string; error?: string } }[]
          }
          return Object.fromEntries(body.data.map((entry) => [entry.name, entry.status]))
        }
        // The trusted control starts in the trusted folder, however its working folder is spelled.
        for (const [spelling] of fixture.spellings("trusted"))
          expect({
            spelling,
            started: await settle(() => exists(path.join(folders.trusted, marker(`config-${spelling}`)))),
          }).toEqual({
            spelling,
            started: true,
          })
        // The others wait, naming the folder they wait for, and leave nothing there.
        const waiting = await statuses()
        for (const [spelling] of fixture.spellings("other"))
          expect({ spelling, status: waiting[`other-${spelling.replaceAll(" ", "-")}`] }).toEqual({
            spelling,
            status: {
              status: "failed",
              error: `Waiting for ${folders.other}, its working folder, to be trusted before it starts.`,
            },
          })
        expect(await fs.readdir(folders.other)).toEqual([])
        expect(await settle(() => exists(path.join(linked, marker("config-linked"))))).toBe(true)
        // That one does not start and does not wait.
        expect(waiting["null-byte"]).toEqual({
          status: "failed",
          error: "Its working folder is not a name a file system takes.",
        })

        // Once that folder is trusted, each starts there.
        expect((await grant(server, folders.other)).status).toBe(200)
        for (const [spelling] of fixture.spellings("other"))
          expect({
            spelling,
            started: await settle(() => exists(path.join(folders.other, marker(`config-${spelling}`)))),
          }).toEqual({
            spelling,
            started: true,
          })
      })
    }),
  120_000,
)
