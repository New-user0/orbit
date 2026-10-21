import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { Session } from "@orbit/schema/session"
import { startServer } from "./fixture/server"

// trust-first: nothing from a project folder loads or runs until the person trusts the folder, and no session starts or
// takes more work in a folder that is not trusted. These servers never trust a folder on their own, as the background
// service and an SDK host that sets nothing do, so a folder is trusted only when a request grants it.
const untrusted = { trust: { implicit: false } }

// A clone that brings something of every kind a config directory can supply, each named so a listing shows whether it was
// read: a project document with a harmless field, an agent, a command and a skill.
const layout = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-trust-first-")))
  const root = yield* Effect.promise(() => fs.realpath(tmp.path))
  const folders = {
    config: path.join(root, "config"),
    repo: path.join(root, "repo"),
    other: path.join(root, "other"),
  }
  yield* Effect.promise(async () => {
    await fs.mkdir(folders.config, { recursive: true })
    await fs.mkdir(folders.other, { recursive: true })
    await Bun.write(path.join(folders.repo, "orbit.json"), JSON.stringify({ username: "clone-user" }))
    await Bun.write(
      path.join(folders.repo, ".orbit", "agents", "clone-agent.md"),
      "---\ndescription: CLONE-AGENT from the repository\n---\nYou are the clone's agent.\n",
    )
    await Bun.write(
      path.join(folders.repo, ".orbit", "commands", "clone-command.md"),
      "---\ndescription: CLONE-COMMAND from the repository\n---\nDo what the clone says.\n",
    )
    await Bun.write(
      path.join(folders.repo, ".orbit", "skills", "clone-skill", "SKILL.md"),
      "---\nname: clone-skill\ndescription: CLONE-SKILL from the repository\n---\nThe clone's skill.\n",
    )
  })
  return folders
})

// A server on a port, or the same routes in process (`ServerFetch`), which is what an SDK host runs.
type Server = {
  readonly base: string
  readonly headers: Record<string, string>
  readonly fetch?: (request: Request) => Promise<Response>
}

// The fields of an answer that these tests read.
type Body = {
  readonly _tag?: string
  readonly directory?: string
  readonly data?: { readonly id: string; readonly location: { readonly directory: string } }
  readonly project?: { readonly id: string }
}

// One request against the server, answered with its status and body, for asserting the error a route answers with.
function request(server: Server, method: string, route: string, input: { directory?: string; body?: unknown } = {}) {
  const url = new URL(route, server.base)
  if (input.directory !== undefined) url.searchParams.set("location[directory]", input.directory)
  const sent = new Request(url, {
    method,
    headers: { ...server.headers, "content-type": "application/json" },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  return (server.fetch ?? fetch)(sent).then(async (response) => ({
    status: response.status,
    body: (await response.json().catch(() => undefined)) as Body | undefined,
  }))
}

const grant = (server: Server, directory: string) =>
  request(server, "POST", "/api/location/trust", { directory, body: { trust: true, persist: false } })
const revoke = (server: Server, directory: string) =>
  request(server, "POST", "/api/location/trust", { directory, body: { trust: false } })
const createSession = (server: Server, directory: string) =>
  request(server, "POST", "/api/session", { directory, body: { location: { directory } } })

// What every refusal of an untrusted folder looks like: a typed error that names the folder, so a client can ask the
// person about that folder and no other (class 13).
const refusedFor = (directory: string) => ({
  status: 403,
  body: expect.objectContaining({ _tag: "UntrustedFolderError", directory }),
})

it.live("an untrusted folder starts no session, and the same request starts one once the folder is trusted", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect(await createSession(server, folders.repo)).toEqual(refusedFor(folders.repo))
      // Nothing was stored for the refused request.
      const listed = await request(server, "GET", "/api/session", { directory: folders.repo })
      expect(listed.status).toBe(200)
      expect(listed.body).toEqual(expect.objectContaining({ data: [] }))

      // The trusted control: the same request, after the grant.
      expect((await grant(server, folders.repo)).status).toBe(200)
      const created = await createSession(server, folders.repo)
      expect(created.status).toBe(200)
      expect(created.body?.data?.location.directory).toBe(folders.repo)
    })
  }),
)

it.live("a session whose folder is no longer trusted takes no more work, though its history can still be read", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect((await grant(server, folders.repo)).status).toBe(200)
      const created = await createSession(server, folders.repo)
      expect(created.status).toBe(200)
      const id = created.body?.data?.id
      expect((await revoke(server, folders.repo)).body).toMatchObject({ trusted: false })

      // Every route that admits work or runs something in the session's folder, one row each.
      const rows = [
        ["prompt", "POST", `/api/session/${id}/prompt`, { text: "hi", resume: false }],
        ["command", "POST", `/api/session/${id}/command`, { name: "clone-command", text: "" }],
        ["skill", "POST", `/api/experimental/session/${id}/skill`, { id: "clone-skill", resume: false }],
        ["synthetic", "POST", `/api/session/${id}/synthetic`, { text: "hi", resume: false }],
        ["shell", "POST", `/api/session/${id}/shell`, { command: "echo hi" }],
        ["compact", "POST", `/api/session/${id}/compact`, {}],
        ["fork", "POST", `/api/session/${id}/fork`, {}],
        // These ask the model from the session's context, or read the folder's instruction files.
        ["generate", "POST", `/api/session/${id}/generate`, { prompt: "hi" }],
        ["title", "PATCH", `/api/session/${id}`, { title: "" }],
        ["instructions", "GET", `/api/experimental/session/${id}/instructions`, undefined],
        // A terminal for the session starts a program in its folder.
        ["terminal", "POST", `/api/experimental/session/${id}/terminal`, { args: [], cwd: folders.repo, title: "Terminal", env: {} }],
      ] as const
      for (const [name, method, route, body] of rows)
        expect({ name, ...(await request(server, method, route, { body })) }).toEqual({
          name,
          ...refusedFor(folders.repo),
        })

      // Reading what the session already holds is the person's own data, not the folder's, so it still answers.
      expect((await request(server, "GET", `/api/session/${id}`)).status).toBe(200)
    })
  }),
)

it.live("a session is not moved into a folder that is not trusted", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect((await grant(server, folders.other)).status).toBe(200)
      const created = await createSession(server, folders.other)
      expect(created.status).toBe(200)
      const id = created.body?.data?.id

      expect(await request(server, "POST", `/api/session/${id}/move`, { body: { directory: folders.repo } })).toEqual(
        refusedFor(folders.repo),
      )
      const after = await request(server, "GET", `/api/session/${id}`)
      expect(after.body?.data?.location.directory).toBe(folders.other)
    })
  }),
)

it.live("no terminal starts in an untrusted folder", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect(
        await request(server, "POST", "/api/pty", {
          directory: folders.repo,
          body: { command: process.execPath, args: ["--version"] },
        }),
      ).toEqual(refusedFor(folders.repo))
    })
  }),
)

it.live("a terminal starts once the folder is trusted: the control for the row above", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect((await grant(server, folders.repo)).status).toBe(200)
      const started = await request(server, "POST", "/api/pty", {
        directory: folders.repo,
        body: { command: process.execPath, args: ["--version"] },
      })
      expect(started.status).toBe(200)
    })
  }),
)

it.live("no MCP server is connected and no file is written for an untrusted folder, and both run once it is trusted", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    const target = path.join(folders.repo, "CLONE-WRITE.txt")
    const write = () => {
      const url = new URL("/api/experimental/fs/write", server.base)
      url.searchParams.set("location[directory]", folders.repo)
      url.searchParams.set("path", target)
      return fetch(url, {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/octet-stream" },
        body: "written",
      }).then(async (response) => ({ status: response.status, body: (await response.json()) as Body }))
    }
    yield* Effect.promise(async () => {
      expect(await request(server, "POST", "/api/experimental/mcp/clone-server/connect", { directory: folders.repo })).toEqual(
        refusedFor(folders.repo),
      )
      expect(await write()).toEqual(refusedFor(folders.repo))
      expect(await Bun.file(target).exists()).toBe(false)

      // The trusted control: past the gate, an unknown server is not found, and the file is written.
      expect((await grant(server, folders.repo)).status).toBe(200)
      expect(
        (await request(server, "POST", "/api/experimental/mcp/clone-server/connect", { directory: folders.repo })).status,
      ).toBe(404)
      expect((await write()).status).toBe(200)
      expect(await Bun.file(target).text()).toBe("written")
    })
  }),
)

it.live("an untrusted folder's plugins are not imported, and a grant imports them", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const marker = path.join(path.dirname(folders.repo), "CLONE-PLUGIN.txt")
    yield* Effect.promise(() =>
      Bun.write(
        path.join(folders.repo, ".orbit", "plugins", "clone-plugin.ts"),
        `export default { id: "clone-plugin", async setup() { await Bun.write(${JSON.stringify(marker)}, "CLONE-PLUGIN") } }\n`,
      ),
    )
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      // Listing the agents waits for the Location's plugins to be active.
      expect((await request(server, "GET", "/api/agent", { directory: folders.repo })).status).toBe(200)
      expect(await Bun.file(marker).exists()).toBe(false)

      expect((await grant(server, folders.repo)).status).toBe(200)
      expect((await request(server, "POST", "/api/location/reload")).status).toBe(204)
      expect((await request(server, "GET", "/api/agent", { directory: folders.repo })).status).toBe(200)
      expect(await Bun.file(marker).text()).toBe("CLONE-PLUGIN")
    })
  }),
)

// Class 9: the refusal names the folder, and a clone picks its own name. Windows forbids these characters in a name.
const linux = process.platform === "win32" ? it.live.skip : it.live
linux("the refusal names a folder whose name acts on a terminal without its control characters", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const hostile = path.join(path.dirname(folders.repo), "inner\u001b]0;owned\u0007")
    yield* Effect.promise(() => fs.mkdir(hostile))
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      const refused = await createSession(server, hostile)
      expect(refused.status).toBe(403)
      const message = (refused.body as { message?: string } | undefined)?.message ?? ""
      expect(message).toContain("inner")
      expect(message).toContain("is not trusted")
      expect(message).not.toContain("\u001b")
      expect(message).not.toContain("\u0007")
    })
  }),
)

it.live(
  "a worktree is neither made nor removed for an untrusted folder, and the refusal names the folder to trust",
  () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.promise(async () => {
        for (const args of [
          ["init", "--quiet"],
          [
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=test",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "init",
          ],
        ])
          expect(Bun.spawnSync(["git", ...args], { cwd: folders.repo }).exitCode).toBe(0)
      })
      const server = yield* startServer(folders.config, untrusted)
      yield* Effect.promise(async () => {
        const location = await request(server, "GET", "/api/location", { directory: folders.repo })
        expect(location.status).toBe(200)
        const projectID = location.body?.project?.id

        expect(await request(server, "POST", "/api/worktree", { body: { projectID } })).toEqual(
          refusedFor(folders.repo),
        )
        expect(
          await request(server, "DELETE", "/api/worktree", {
            body: { projectID, directory: path.join(folders.other, "copy"), force: false },
          }),
        ).toEqual(refusedFor(folders.repo))
        // Refreshing the list loads the folder's worktree strategies and runs git there, so it waits for a grant too.
        expect(await request(server, "POST", "/api/worktree/refresh", { body: { projectID } })).toEqual(
          refusedFor(folders.repo),
        )
        // The trusted control for the refresh: it runs once the folder is trusted.
        expect((await grant(server, folders.repo)).status).toBe(200)
        expect((await request(server, "POST", "/api/worktree/refresh", { body: { projectID } })).status).toBe(204)
      })
    }),
)

it.live("an untrusted folder's config, agents, commands and skills are not loaded at all, and a grant loads them", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    const read = (directory: string) =>
      Promise.all(
        ["/api/config", "/api/agent", "/api/command", "/api/skill"].map((route) =>
          request(server, "GET", route, { directory }).then((response) => JSON.stringify(response.body)),
        ),
      )
    yield* Effect.promise(async () => {
      const [config, agents, commands, skills] = await read(folders.repo)
      // Not one entry from the folder: not a document cut down to its harmless fields, not a directory marked untrusted.
      expect(config).not.toContain(path.join(folders.repo, "orbit.json").replaceAll("\\", "\\\\"))
      expect(config).not.toContain("clone-user")
      expect(agents).not.toContain("CLONE-AGENT")
      expect(commands).not.toContain("CLONE-COMMAND")
      expect(skills).not.toContain("CLONE-SKILL")
      // Nothing was read, so the status has nothing to list as held back either.
      const status = await request(server, "GET", "/api/location/trust", { directory: folders.repo })
      expect(status.body).toMatchObject({ trusted: false, withheld: [] })

      // The trusted control: the same folder, after the grant and the reload a grant is followed by.
      expect((await grant(server, folders.repo)).status).toBe(200)
      expect((await request(server, "POST", "/api/location/reload")).status).toBe(204)
      const after = await read(folders.repo)
      expect(after[0]).toContain("clone-user")
      expect(after[1]).toContain("CLONE-AGENT")
      expect(after[2]).toContain("CLONE-COMMAND")
      expect(after[3]).toContain("CLONE-SKILL")
    })
  }),
)

// A session that was working when its server stopped is resumed by the next server, and that server checks the
// session's own folder before it does (class 3): a grant for the process alone is gone with the process. A stored grant
// outlives it, and that row is the trusted control.
for (const persist of [false, true])
  it.live(
    persist
      ? "a session that was working when the server stopped is resumed by the next server in a folder still trusted"
      : "a session that was working when the server stopped is not resumed by the next server in a folder no longer trusted",
    () =>
      Effect.gen(function* () {
        const folders = yield* layout
        const database = path.join(path.dirname(folders.config), "orbit.db")
        // A model that takes every request and never answers, so the first server stops mid-step.
        const requests: string[] = []
        const llm = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            requests.push(new URL(request.url).pathname)
            return new Response(new ReadableStream({ start() {} }), {
              headers: { "content-type": "text/event-stream" },
            })
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => llm.stop(true)))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(folders.config, "orbit.json"),
            JSON.stringify({
              model: "test/test-model",
              providers: {
                test: {
                  name: "Test",
                  package: "aisdk:@ai-sdk/openai-compatible",
                  settings: { apiKey: "test-key", baseURL: `http://127.0.0.1:${llm.port}/v1` },
                  models: {
                    "test-model": {
                      name: "Test Model",
                      capabilities: { tools: true, input: ["text"], output: ["text"] },
                      cost: { input: 0, output: 0 },
                      limit: { context: 100_000, output: 10_000 },
                    },
                  },
                },
              },
            }),
          ),
        )
        // In process, as an SDK host runs it: these routes resume claimed sessions when they boot, as the background
        // service does.
        const start = () =>
          ServerFetch.make({
            app: { version: "test-version" },
            database: { path: database },
            config: { directory: folders.config },
            managed: { directory: path.join(folders.config, "managed-missing") },
            fs: { filewatcher: false },
            models: { fetch: false },
            trust: { implicit: false },
          }).pipe(Effect.map((handler): Server => ({ base: "http://orbit.local", headers: {}, fetch: handler })))

        // The first server: a grant, a session, and a prompt that is mid-step when the server stops.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* start()
            yield* Effect.promise(async () => {
              const granted = await request(server, "POST", "/api/location/trust", {
                directory: folders.repo,
                body: { trust: true, persist },
              })
              expect(granted.status).toBe(200)
              const created = await createSession(server, folders.repo)
              expect(created.status).toBe(200)
              const id = created.body?.data?.id
              const prompted = await request(server, "POST", `/api/session/${id}/prompt`, { body: { text: "hi" } })
              expect(prompted.status).toBe(200)
              const deadline = Date.now() + 20_000
              while (requests.length === 0 && Date.now() < deadline) await Bun.sleep(50)
              expect(requests.length).toBeGreaterThan(0)
            })
          }),
        )
        const before = requests.length

        // The second server over the same database resumes the session only where the folder is still trusted.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* start()
            yield* Effect.promise(async () => {
              const status = await request(server, "GET", "/api/location/trust", { directory: folders.repo })
              expect(status.body).toMatchObject({ trusted: persist })
              const deadline = Date.now() + 10_000
              while (requests.length === before && Date.now() < deadline) await Bun.sleep(100)
              if (persist) expect(requests.length).toBeGreaterThan(before)
              else expect(requests.length).toBe(before)
            })
          }),
        )
      }),
    60_000,
  )

it.live("a grant for a folder covers the folders below it, as the reference's walk up the parents does", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const parent = folders.other
    const child = path.join(parent, "nested", "project")
    yield* Effect.promise(() => fs.mkdir(child, { recursive: true }))
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      const before = await request(server, "GET", "/api/location/trust", { directory: child })
      expect(before.body).toMatchObject({ directory: child, trusted: false })

      expect(
        (await request(server, "POST", "/api/location/trust", { directory: parent, body: { trust: true } })).status,
      ).toBe(200)
      const after = await request(server, "GET", "/api/location/trust", { directory: child })
      expect(after.body).toMatchObject({ directory: child, trusted: true, source: "saved" })
      // And a session starts there without a question of its own.
      expect((await createSession(server, child)).status).toBe(200)
    })
  }),
)

// A child session is created at its parent's folder, whatever folder the request names, so that is the folder that has to
// be trusted (class 3).
it.live("a child session is decided by its parent's folder, not by the folder the request names", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect((await grant(server, folders.repo)).status).toBe(200)
      expect((await grant(server, folders.other)).status).toBe(200)
      const parent = await createSession(server, folders.repo)
      expect(parent.status).toBe(200)
      expect((await revoke(server, folders.repo)).body).toMatchObject({ trusted: false })
      const child = (directory: string) =>
        request(server, "POST", "/api/session", {
          directory,
          body: { parentID: parent.body?.data?.id, location: { directory } },
        })
      expect(await child(folders.other)).toEqual(refusedFor(folders.repo))
      // The control: once the parent's folder is trusted again, the same request creates the child there.
      expect((await grant(server, folders.repo)).status).toBe(200)
      const created = await child(folders.other)
      expect(created.status).toBe(200)
      expect(created.body?.data?.location.directory).toBe(folders.repo)
    })
  }),
)

// Where a session is created is decided for the folder its Location's trust is decided for, the project's main checkout,
// so a linked worktree of a trusted repository starts one, and a revoke of that checkout stops it (class 3).
it.live("a linked worktree is decided by its main checkout when a session is created there", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const worktree = path.join(folders.other, "linked")
    yield* Effect.promise(async () => {
      await $`git init -q`.cwd(folders.repo).quiet()
      await $`git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init`.cwd(folders.repo).quiet()
      await $`git worktree add -q --detach ${worktree}`.cwd(folders.repo).quiet()
    })
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect(await createSession(server, worktree)).toEqual(refusedFor(folders.repo))
      expect((await grant(server, folders.repo)).status).toBe(200)
      expect((await createSession(server, worktree)).status).toBe(200)
    })
  }),
)

it.live("no shell command or session terminal starts in an untrusted folder, and both get past the check once it is trusted", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const marker = path.join(folders.repo, "CLONE-SHELL-RAN")
    // A terminal runs in a daemon of its own. Naming one that is not there makes a terminal that gets past the check fail
    // at once with the daemon's error, where it would otherwise start one.
    const previous = process.env.ORBIT_PTY_BIN
    process.env.ORBIT_PTY_BIN = path.join(folders.other, "missing-orbit-pty")
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.ORBIT_PTY_BIN
        if (previous !== undefined) process.env.ORBIT_PTY_BIN = previous
      }),
    )
    const server = yield* startServer(folders.config, untrusted)
    const shell = () =>
      request(server, "POST", "/api/shell", { directory: folders.repo, body: { command: "echo ran > CLONE-SHELL-RAN" } })
    const terminal = (sessionID: string, cwd: string) =>
      request(server, "POST", `/api/experimental/session/${sessionID}/terminal`, {
        body: { args: [], cwd, title: "Terminal", env: {} },
      })
    const unavailable = { status: 503, body: expect.objectContaining({ _tag: "ServiceUnavailableError" }) }
    yield* Effect.promise(async () => {
      // A session is made only in a trusted folder, so this one is made before its folder's grant ends.
      expect((await grant(server, folders.repo)).status).toBe(200)
      const id = (await createSession(server, folders.repo)).body?.data?.id ?? ""
      expect((await revoke(server, folders.repo)).body).toMatchObject({ trusted: false })
      expect((await grant(server, folders.other)).status).toBe(200)

      expect(await shell()).toEqual(refusedFor(folders.repo))
      // A terminal for no known session is decided by the folder it starts in.
      expect(await terminal("ses_unknown", folders.repo)).toEqual(refusedFor(folders.repo))
      // One for a session works for that session, so its folder decides, wherever the terminal is asked to start.
      expect(await terminal(id, folders.other)).toEqual(refusedFor(folders.repo))
      await Bun.sleep(1_000)
      expect(await Bun.file(marker).exists()).toBe(false)

      // The trusted control: the command runs and leaves its marker, and each terminal fails only for want of a daemon.
      expect((await grant(server, folders.repo)).status).toBe(200)
      expect((await shell()).status).toBe(200)
      const deadline = Date.now() + 15_000
      while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(100)
      expect(await Bun.file(marker).exists()).toBe(true)
      expect(await terminal("ses_unknown", folders.repo)).toEqual(unavailable)
      expect(await terminal(id, folders.other)).toEqual(unavailable)
    })
  }),
  60_000,
)

// A model server that keeps what each request carried, so a row can show what a folder supplied reached the model.
const recordingModel = Effect.acquireRelease(
  Effect.sync(() => {
    const bodies: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: unknown }
        bodies.push(JSON.stringify(body))
        const events = [
          { choices: [{ index: 0, delta: { role: "assistant", content: body.tools ? "done" : "Generated" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
        return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    return { bodies, server }
  }),
  (llm) => Effect.promise(() => llm.server.stop(true)),
)

const modelConfig = (port: number | undefined) => ({
  model: "test/test-model",
  providers: {
    test: {
      name: "Test",
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1` },
      models: {
        "test-model": {
          name: "Test Model",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: { input: 0, output: 0 },
          limit: { context: 100_000, output: 10_000 },
        },
      },
    },
  },
})

// What the export route answers with, which the import route takes back.
type Exported = { readonly data: { readonly info: Record<string, unknown>; readonly messages: readonly unknown[] } }

it.live(
  "a session is not imported into an untrusted folder, and a folder's instruction files and output style reach the model only once it is trusted",
  () =>
    Effect.gen(function* () {
      const folders = yield* layout
      const llm = yield* recordingModel
      yield* Effect.promise(async () => {
        await Bun.write(path.join(folders.config, "orbit.json"), JSON.stringify(modelConfig(llm.server.port)))
        await Bun.write(
          path.join(folders.repo, "orbit.json"),
          JSON.stringify({ username: "clone-user", output_style: "clone-style" }),
        )
        await Bun.write(
          path.join(folders.repo, ".orbit", "output-styles", "clone-style.md"),
          "---\nname: clone-style\n---\nCLONE-STYLE: answer as the clone says.\n",
        )
        await Bun.write(path.join(folders.repo, "AGENTS.md"), "CLONE-AGENTS-MD: the repository's instructions.\n")
        await Bun.write(
          path.join(folders.other, "AGENTS.md"),
          "CLONE-IMPORTED-INSTRUCTION: the other folder's instructions.\n",
        )
      })
      const server = yield* startServer(folders.config, untrusted)
      yield* Effect.promise(async () => {
        // The control for the folder's own files: once it is trusted, its instruction file is read for a session there,
        // and that file and its output style reach the model.
        expect((await grant(server, folders.repo)).status).toBe(200)
        expect((await request(server, "POST", "/api/location/reload")).status).toBe(204)
        const created = await createSession(server, folders.repo)
        expect(created.status).toBe(200)
        const id = created.body?.data?.id
        const preview = await request(server, "GET", `/api/experimental/session/${id}/instructions`)
        expect(preview.status).toBe(200)
        expect(JSON.stringify(preview.body)).toContain("CLONE-AGENTS-MD")
        expect((await request(server, "POST", `/api/session/${id}/generate`, { body: { prompt: "hi" } })).status).toBe(
          200,
        )
        expect(llm.bodies.join("")).toContain("CLONE-AGENTS-MD")
        expect(llm.bodies.join("")).toContain("CLONE-STYLE")

        // The same session imported into a folder that is not trusted: refused, nothing stored, the model not asked.
        const exported = (await request(server, "GET", `/api/experimental/session/${id}/export`))
          .body as unknown as Exported
        const imported = Session.ID.create()
        const importInto = (directory: string) =>
          request(server, "POST", "/api/experimental/session/import", {
            body: {
              info: { ...exported.data.info, id: imported },
              messages: exported.data.messages,
              location: { directory },
            },
          })
        const asked = llm.bodies.length
        expect(await importInto(folders.other)).toEqual(refusedFor(folders.other))
        expect((await request(server, "GET", `/api/session/${imported}`)).status).toBe(404)
        expect(llm.bodies.length).toBe(asked)

        // The trusted control: the import lands once the folder is trusted, and that folder's instructions are read.
        expect((await grant(server, folders.other)).status).toBe(200)
        expect((await importInto(folders.other)).status).toBe(200)
        expect(
          (await request(server, "POST", `/api/session/${imported}/generate`, { body: { prompt: "hi" } })).status,
        ).toBe(200)
        expect(llm.bodies.slice(asked).join("")).toContain("CLONE-IMPORTED-INSTRUCTION")
      })
    }),
  60_000,
)
