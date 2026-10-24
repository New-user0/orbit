import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { expect, setDefaultTimeout } from "bun:test"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { Provider } from "@orbit/core/provider"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionMessage } from "@orbit/core/session/message"
import { Snapshot } from "@orbit/core/snapshot"
import { Location } from "@orbit/schema/location"
import { Money } from "@orbit/schema/money"
import { AbsolutePath } from "@orbit/schema/schema"
import { Session } from "@orbit/schema/session"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { Effect, Layer } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// clients-ux-5: code-only rewind. `POST /api/session/:id/revert/files` puts back, as they were when a prompt's work
// began, the files that the session's own file tools (Edit, Write, Patch, NotebookEdit) changed: a shell command's or a
// person's edit to another file is left alone, and the conversation is not touched. `dryRun` says what a restore would
// change without changing it. The steps here are driven the way the runner records them (a start and an end checkpoint
// around the tool calls and their recorded files), without a model; the checkpoints are real git snapshots.

setDefaultTimeout(60_000)

type Status = "added" | "modified" | "deleted"
type Recorded = { readonly file: string; readonly status: Status; readonly from?: string }
type ToolCall = { readonly name: string; readonly files: ReadonlyArray<Recorded> }
type Step = {
  readonly tools?: ReadonlyArray<ToolCall>
  readonly edit?: () => Promise<unknown>
  // A step that recorded no checkpoint, as a step does while snapshots cannot be taken.
  readonly unrecorded?: boolean
}
type Turn = { readonly prompt: SessionMessage.ID; readonly steps: ReadonlyArray<Step>; readonly idle: boolean }
type Body = Record<string, unknown> & { readonly data?: unknown; readonly _tag?: string }

const usage = { cost: Money.USD.zero, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }

// One server whose execution delivers each prompt and runs the steps a test queued for it, in the session's Location.
const setup = (trust: { implicit: boolean } = { implicit: true }) =>
  Effect.gen(function* () {
    const script = {
      location: undefined as Location.Ref | undefined,
      busy: false,
      turns: [] as Turn[],
      assistants: [] as SessionMessage.ID[],
    }
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const locations = yield* LocationServiceMap.Service
        const run = (sessionID: Session.ID, turn: Turn) =>
          Effect.gen(function* () {
            yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: turn.prompt })
            const plugins = yield* Plugin.Service
            yield* plugins.awaitActivation
            const snapshot = yield* Snapshot.Service
            for (const step of turn.steps) {
              const before = step.unrecorded ? undefined : yield* snapshot.capture()
              const assistantMessageID = SessionMessage.ID.create()
              script.assistants.push(assistantMessageID)
              yield* bus.publish(SessionEvent.Step.Started, {
                sessionID,
                assistantMessageID,
                agent: Agent.defaultID,
                model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
                snapshot: before,
                started: 0,
              })
              const calls = (step.tools ?? []).map((tool, index) => ({ ...tool, id: `call_${index}` }))
              for (const call of calls) {
                yield* bus.publish(SessionEvent.Tool.Input.Started, {
                  sessionID,
                  assistantMessageID,
                  id: call.id,
                  name: call.name,
                })
                yield* bus.publish(SessionEvent.Tool.Called, {
                  sessionID,
                  assistantMessageID,
                  id: call.id,
                  input: {},
                  executed: true,
                })
              }
              if (step.edit) yield* Effect.promise(step.edit)
              for (const call of calls)
                yield* bus.publish(SessionEvent.Tool.Success, {
                  sessionID,
                  assistantMessageID,
                  id: call.id,
                  content: [{ type: "text", text: "done" }],
                  metadata: {
                    files: call.files.map((file) => ({
                      file: file.file,
                      status: file.status,
                      additions: 0,
                      deletions: 0,
                      patch: "",
                      ...(file.from === undefined ? {} : { from: file.from }),
                    })),
                  },
                  executed: true,
                })
              const after = step.unrecorded ? undefined : yield* snapshot.capture()
              yield* bus.publish(SessionEvent.Step.Ended, {
                sessionID,
                assistantMessageID,
                finish: "stop",
                ...usage,
                snapshot: after,
                files: before && after ? yield* snapshot.files({ from: before, to: after }) : undefined,
              })
            }
            if (turn.idle) yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
          }).pipe(Effect.provide(locations.get(script.location!)), Effect.orDie)
        return SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          isActive: () => Effect.sync(() => script.busy),
          resume: () => Effect.void,
          wake: (sessionID) =>
            Effect.gen(function* () {
              while (script.turns.length > 0) yield* run(sessionID, script.turns.shift()!)
            }),
          interrupt: () => Effect.succeed(false),
          awaitIdle: () => Effect.void,
        })
      }),
    )
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test-version" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
        trust,
      },
      {
        overrides: [
          SessionExecution.node.replace(
            makeGlobalNode({
              service: SessionExecution.Service,
              layer: execution,
              deps: [Bus.node, LocationServiceMap.node],
            }),
          ),
        ],
      },
    )
    const request = (method: string, route: string, body?: unknown, directory?: string) =>
      Effect.promise(async () => {
        const url = new URL(route, "http://orbit.local")
        if (directory !== undefined) url.searchParams.set("location[directory]", directory)
        const response = await handler(
          new Request(url, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: (await response.json().catch(() => undefined)) as Body | undefined }
      })
    // A session in `directory`, and a function that sends one prompt and runs the steps given for it.
    const session = (directory: string) =>
      Effect.gen(function* () {
        script.location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
        const created = yield* request("POST", "/api/session", { location: { directory } }, directory)
        expect(created.status).toBe(200)
        const sessionID = Session.ID.make((created.body?.data as { id: string }).id)
        const prompt = (steps: ReadonlyArray<Step>, idle = true) =>
          Effect.gen(function* () {
            const id = SessionMessage.ID.create()
            script.turns.push({ prompt: id, steps, idle })
            const sent = yield* request("POST", `/api/session/${sessionID}/prompt`, { id, text: `prompt ${id}` })
            expect(sent.status).toBe(200)
            return id
          })
        const rewind = (messageID: string, dryRun?: boolean) =>
          request("POST", `/api/session/${sessionID}/revert/files`, {
            messageID,
            ...(dryRun === undefined ? {} : { dryRun }),
          })
        return { sessionID, prompt, rewind }
      })
    return { script, request, session }
  })

// A git repository with the given files, real so that paths compare with what the server answers.
const repository = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-rewind-")))
    const root = yield* Effect.promise(() => fs.realpath(tmp.path))
    const repo = path.join(root, "repo")
    yield* Effect.promise(async () => {
      await fs.mkdir(repo, { recursive: true })
      for (const [file, content] of Object.entries(files)) await Bun.write(path.join(repo, file), content)
      await $`git init -q`.cwd(repo).quiet()
      await $`git -c core.fsmonitor=false add .`.cwd(repo).quiet()
    })
    return { root, repo }
  })

const read = (file: string) =>
  Effect.promise(() =>
    fs.readFile(file, "utf8").then(
      (text) => text.replaceAll("\r\n", "\n"),
      () => undefined,
    ),
  )
const write = (file: string, content: string) => () => Bun.write(file, content)
const edited = (file: string): ToolCall => ({ name: "Edit", files: [{ file, status: "modified" }] })
const created = (file: string): ToolCall => ({ name: "Write", files: [{ file, status: "added" }] })

it.live(
  "restores the session's file-tool edits to a prompt's checkpoint and leaves shell edits and the conversation",
  () =>
    Effect.gen(function* () {
      const server = yield* setup()
      const { repo } = yield* repository({
        "tracked.txt": "one\n",
        "old.txt": "old\n",
        "shell.txt": "shell one\n",
        "earlier.txt": "early one\n",
      })
      const at = (file: string) => path.join(repo, file)
      const session = yield* server.session(repo)
      yield* session.prompt([{ tools: [edited("earlier.txt")], edit: write(at("earlier.txt"), "early two\n") }])
      const second = yield* session.prompt([
        {
          tools: [
            edited("tracked.txt"),
            created("a.txt"),
            created("empty.txt"),
            { name: "Patch", files: [{ file: "moved.txt", status: "modified", from: "old.txt" }] },
            // A call of another tool that names a file (a subagent's, say) is not a file tool's: its file stays.
            { name: "Agent", files: [{ file: "shell.txt", status: "modified" }] },
          ],
          edit: async () => {
            await Bun.write(at("tracked.txt"), "two\n")
            await Bun.write(at("a.txt"), "a\n")
            await Bun.write(at("empty.txt"), "")
            await fs.rename(at("old.txt"), at("moved.txt"))
            await Bun.write(at("moved.txt"), "moved\n")
            // A shell command's edit in the same step: not a file tool's, so a rewind leaves it.
            await Bun.write(at("shell.txt"), "shell two\n")
          },
        },
      ])
      // A file the session's tools edited before the checkpoint, changed by hand since: it is tracked, so it goes back.
      yield* Effect.promise(write(at("earlier.txt"), "early manual\n"))
      const disk = Effect.gen(function* () {
        return {
          tracked: yield* read(at("tracked.txt")),
          a: yield* read(at("a.txt")),
          empty: yield* read(at("empty.txt")),
          old: yield* read(at("old.txt")),
          moved: yield* read(at("moved.txt")),
          earlier: yield* read(at("earlier.txt")),
          shell: yield* read(at("shell.txt")),
        }
      })
      const before = yield* disk

      const dry = yield* session.rewind(second, true)
      expect(dry.status).toBe(200)
      const preview = dry.body?.data as {
        canRewind: boolean
        filesChanged: string[]
        insertions: number
        deletions: number
      }
      // A zero-byte file made after the checkpoint counts as a change, though it has no lines.
      expect({ ...preview, filesChanged: preview.filesChanged.toSorted() }).toEqual({
        canRewind: true,
        filesChanged: ["a.txt", "earlier.txt", "empty.txt", "moved.txt", "old.txt", "tracked.txt"].map(at),
        insertions: 3,
        deletions: 4,
      })
      // A dry run changes nothing.
      expect(yield* disk).toEqual(before)

      const done = yield* session.rewind(second)
      expect(done).toMatchObject({ status: 200, body: { data: { canRewind: true } } })
      expect(yield* disk).toEqual({
        tracked: "one\n",
        a: undefined,
        empty: undefined,
        old: "old\n",
        moved: undefined,
        earlier: "early two\n",
        shell: "shell two\n",
      })
      // Code only: no conversation revert is staged.
      const info = yield* server.request("GET", `/api/session/${session.sessionID}`)
      expect((info.body?.data as { revert?: unknown }).revert).toBeUndefined()
      // Nothing differs any more, so a second dry run would change nothing.
      expect(yield* session.rewind(second, true)).toEqual({
        status: 200,
        body: { data: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } },
      })
    }),
)

it.live("answers a message that is not a prompt, a prompt without a checkpoint and a folder without snapshots", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { root, repo } = yield* repository({ "tracked.txt": "one\n" })
    const session = yield* server.session(repo)
    // Two steps, so the first step's message has a step with a checkpoint after it, as a prompt does.
    yield* session.prompt([
      { tools: [edited("tracked.txt")], edit: write(path.join(repo, "tracked.txt"), "two\n") },
      { tools: [edited("tracked.txt")] },
    ])
    expect(yield* session.rewind(SessionMessage.ID.create(), true)).toMatchObject({
      status: 404,
      body: { _tag: "MessageNotFoundError" },
    })
    // Only a prompt has a checkpoint: another message of the session is answered as one without a checkpoint.
    expect(yield* session.rewind(server.script.assistants[0]!, true)).toEqual({
      status: 200,
      body: { data: { canRewind: false, error: expect.any(String) } },
    })
    expect(yield* session.rewind(server.script.assistants[0]!)).toMatchObject({
      status: 409,
      body: { _tag: "RewindFilesError", reason: "no-checkpoint" },
    })
    const unrecorded = yield* session.prompt([
      { tools: [edited("tracked.txt")], edit: write(path.join(repo, "tracked.txt"), "three\n"), unrecorded: true },
    ])
    expect(yield* session.rewind(unrecorded, true)).toEqual({
      status: 200,
      body: { data: { canRewind: false, error: expect.any(String) } },
    })
    expect(yield* session.rewind(unrecorded)).toMatchObject({
      status: 409,
      body: { _tag: "RewindFilesError", reason: "no-checkpoint" },
    })
    expect(yield* read(path.join(repo, "tracked.txt"))).toBe("three\n")

    // A folder that is not a git repository takes no snapshots, so nothing can be rewound there.
    const plain = path.join(root, "plain")
    yield* Effect.promise(() => fs.mkdir(plain, { recursive: true }))
    const other = yield* server.session(plain)
    const prompt = yield* other.prompt([{ tools: [created("a.txt")], edit: write(path.join(plain, "a.txt"), "a\n") }])
    expect(yield* other.rewind(prompt, true)).toEqual({
      status: 200,
      body: { data: { canRewind: false, error: expect.any(String) } },
    })
    expect(yield* other.rewind(prompt)).toMatchObject({
      status: 409,
      body: { _tag: "RewindFilesError", reason: "disabled" },
    })
    expect(yield* read(path.join(plain, "a.txt"))).toBe("a\n")
  }),
)

it.live("refuses a busy session with 409 and writes nothing", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { repo } = yield* repository({ "tracked.txt": "one\n" })
    const session = yield* server.session(repo)
    const prompt = yield* session.prompt([
      { tools: [edited("tracked.txt")], edit: write(path.join(repo, "tracked.txt"), "two\n") },
    ])
    server.script.busy = true
    for (const dryRun of [true, false])
      expect(yield* session.rewind(prompt, dryRun)).toMatchObject({ status: 409, body: { _tag: "SessionBusyError" } })
    expect(yield* read(path.join(repo, "tracked.txt"))).toBe("two\n")
    // The control: once the session is idle, the same request restores the file.
    server.script.busy = false
    expect((yield* session.rewind(prompt)).status).toBe(200)
    expect(yield* read(path.join(repo, "tracked.txt"))).toBe("one\n")
  }),
)

it.live("undoes only the file-tool edits when /undo stages a conversation revert with its files", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { repo } = yield* repository({ "shell.txt": "shell one\n" })
    const session = yield* server.session(repo)
    const prompt = yield* session.prompt([
      {
        tools: [created("a.txt")],
        edit: async () => {
          await Bun.write(path.join(repo, "a.txt"), "a\n")
          await Bun.write(path.join(repo, "shell.txt"), "shell two\n")
        },
      },
    ])
    const staged = yield* server.request("POST", `/api/session/${session.sessionID}/revert/stage`, {
      messageID: prompt,
    })
    expect(staged.status).toBe(200)
    expect({
      a: yield* read(path.join(repo, "a.txt")),
      shell: yield* read(path.join(repo, "shell.txt")),
    }).toEqual({ a: undefined, shell: "shell two\n" })
  }),
)

it.live("does not restore through a folder that became a link after the checkpoint, and restores the control", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { root, repo } = yield* repository({ "dir/x.txt": "x one\n", "tracked.txt": "one\n" })
    const outside = path.join(root, "outside")
    const session = yield* server.session(repo)
    const prompt = yield* session.prompt([
      {
        tools: [edited("dir/x.txt"), edited("tracked.txt")],
        edit: async () => {
          await Bun.write(path.join(repo, "dir", "x.txt"), "x two\n")
          await Bun.write(path.join(repo, "tracked.txt"), "two\n")
        },
      },
    ])
    yield* Effect.promise(async () => {
      await fs.mkdir(outside, { recursive: true })
      await Bun.write(path.join(outside, "x.txt"), "outside\n")
      await fs.rename(path.join(repo, "dir"), path.join(root, "moved-dir"))
      await fs.symlink(outside, path.join(repo, "dir"), process.platform === "win32" ? "junction" : "dir")
    })
    // The dry run lists only what the restore will write: not the file behind the link.
    expect(yield* session.rewind(prompt, true)).toMatchObject({
      status: 200,
      body: { data: { canRewind: true, filesChanged: [path.join(repo, "tracked.txt")] } },
    })
    expect((yield* session.rewind(prompt)).status).toBe(200)
    expect({
      outside: yield* read(path.join(outside, "x.txt")),
      link: yield* Effect.promise(() => fs.lstat(path.join(repo, "dir")).then((info) => info.isSymbolicLink())),
      tracked: yield* read(path.join(repo, "tracked.txt")),
    }).toEqual({ outside: "outside\n", link: true, tracked: "one\n" })
  }),
)

// The file a tool edited can itself become a link (a junction on Windows) after the checkpoint, through a shell command
// or a script of the repository. Git would write the file by removing the junction's target files on Windows, or
// replace the link elsewhere; the rewind leaves the link and the outside folder, and restores the control.
it.live("does not restore over a file whose name became a link to an outside folder, and restores the control", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { root, repo } = yield* repository({ "leaf.txt": "leaf one\n", "tracked.txt": "one\n" })
    const outside = path.join(root, "outside")
    const session = yield* server.session(repo)
    const prompt = yield* session.prompt([
      {
        tools: [edited("leaf.txt"), edited("tracked.txt")],
        edit: async () => {
          await Bun.write(path.join(repo, "leaf.txt"), "leaf two\n")
          await Bun.write(path.join(repo, "tracked.txt"), "two\n")
        },
      },
    ])
    yield* Effect.promise(async () => {
      await fs.mkdir(outside, { recursive: true })
      await Bun.write(path.join(outside, "victim.txt"), "outside\n")
      await fs.rm(path.join(repo, "leaf.txt"))
      await fs.symlink(outside, path.join(repo, "leaf.txt"), process.platform === "win32" ? "junction" : "dir")
    })
    expect(yield* session.rewind(prompt, true)).toMatchObject({
      status: 200,
      body: { data: { canRewind: true, filesChanged: [path.join(repo, "tracked.txt")] } },
    })
    expect((yield* session.rewind(prompt)).status).toBe(200)
    expect({
      victim: yield* read(path.join(outside, "victim.txt")),
      link: yield* Effect.promise(() => fs.lstat(path.join(repo, "leaf.txt")).then((info) => info.isSymbolicLink())),
      tracked: yield* read(path.join(repo, "tracked.txt")),
    }).toEqual({ victim: "outside\n", link: true, tracked: "one\n" })
  }),
)

// Two prompts sent while a step runs are delivered together, as steers, and the step that follows works for both. The
// earlier prompt's checkpoint is that step's start, as a staged revert of the same prompt picks it.
it.live("rewinds the earlier of two prompts delivered together to the checkpoint of the step after them", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { repo } = yield* repository({ "tracked.txt": "one\n" })
    const session = yield* server.session(repo)
    const first = yield* session.prompt([], false)
    yield* session.prompt([{ tools: [edited("tracked.txt")], edit: write(path.join(repo, "tracked.txt"), "two\n") }])
    expect(yield* session.rewind(first, true)).toEqual({
      status: 200,
      body: { data: { canRewind: true, filesChanged: [path.join(repo, "tracked.txt")], insertions: 1, deletions: 1 } },
    })
    expect(yield* session.rewind(first)).toEqual({ status: 200, body: { data: { canRewind: true } } })
    expect(yield* read(path.join(repo, "tracked.txt"))).toBe("one\n")
  }),
)

// trust-first keeps a session from starting in a folder that is not trusted, but trust can be ended later. A rewind then
// reads the folder's git and writes its files, so it is refused before either, with the typed refusal every session
// route gives (classes 1 and 13); granting trust again is the control.
it.live("refuses a rewind once the folder's trust has ended, and restores once it is trusted again", () =>
  Effect.gen(function* () {
    const server = yield* setup({ implicit: false })
    const { repo } = yield* repository({ "tracked.txt": "one\n" })
    const trust = (value: boolean) =>
      server.request("POST", "/api/location/trust", value ? { trust: true, persist: false } : { trust: false }, repo)
    expect((yield* trust(true)).status).toBe(200)
    const session = yield* server.session(repo)
    const prompt = yield* session.prompt([{ tools: [created("a.txt")], edit: write(path.join(repo, "a.txt"), "a\n") }])
    expect((yield* trust(false)).status).toBe(200)
    for (const dryRun of [true, false])
      expect(yield* session.rewind(prompt, dryRun)).toMatchObject({
        status: 403,
        body: { _tag: "UntrustedFolderError", directory: repo },
      })
    expect(yield* read(path.join(repo, "a.txt"))).toBe("a\n")
    expect((yield* trust(true)).status).toBe(200)
    expect((yield* session.rewind(prompt)).status).toBe(200)
    expect(yield* read(path.join(repo, "a.txt"))).toBeUndefined()
  }),
)

// An imported session's steps are whatever its file says (class 5). A checkpoint ID that git would read as an option
// (`--output=<file>` makes `git diff` write that file) is not a tree: the import keeps the message without it, so the
// session's diff, its rewind and its staged revert never hand it to git. The marker is the file git would write.
it.live("keeps a forged checkpoint ID of an imported session away from git", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { root, repo } = yield* repository({ "tracked.txt": "one\n" })
    const session = yield* server.session(repo)
    yield* session.prompt([{ tools: [edited("tracked.txt")], edit: write(path.join(repo, "tracked.txt"), "two\n") }])
    const exported = yield* server.request("GET", `/api/experimental/session/${session.sessionID}/export`)
    expect(exported.status).toBe(200)
    const data = exported.body?.data as {
      info: Record<string, unknown>
      messages: Array<Record<string, unknown> & { id: string; type: string; snapshot?: Record<string, unknown> }>
    }
    const marker = path.join(root, "forged.marker")
    const ids = new Map(data.messages.map((message) => [message.id, SessionMessage.ID.create()]))
    const imported = Session.ID.create()
    const answer = yield* server.request("POST", "/api/experimental/session/import", {
      info: { ...data.info, id: imported },
      messages: data.messages.map((message) => ({
        ...message,
        id: ids.get(message.id),
        ...(message.type === "assistant" && message.snapshot
          ? { snapshot: { ...message.snapshot, start: `--output=${marker}` } }
          : {}),
      })),
      location: { directory: repo },
    })
    expect(answer.status).toBe(200)
    const prompt = ids.get(data.messages.find((message) => message.type === "user")!.id)!
    const diff = yield* server.request("GET", `/api/session/${imported}/diff?from=${prompt}`)
    const rewind = yield* server.request("POST", `/api/session/${imported}/revert/files`, {
      messageID: prompt,
      dryRun: true,
    })
    const staged = yield* server.request("POST", `/api/session/${imported}/revert/stage`, { messageID: prompt })
    expect({
      diff: diff.status,
      rewind: rewind.body?.data,
      staged: staged.status,
      marker: yield* Effect.promise(() => Bun.file(marker).exists()),
    }).toEqual({
      diff: 200,
      rewind: { canRewind: false, error: expect.any(String) },
      staged: 200,
      marker: false,
    })
  }),
)

// FU-M1-083: a turn spans a whole busy period, so a prompt steered in while the session was busy shared the earlier
// prompt's diff. `scope=prompt` ranges from a prompt to the next prompt and counts only the session's file-tool edits,
// which is what the rewind picker shows beside each prompt; the default turn range is unchanged.
it.live("diffs one prompt's own file-tool edits with scope=prompt, a steered prompt included", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { repo } = yield* repository({ "zero.txt": "zero one\n", "shell.txt": "shell one\n" })
    const session = yield* server.session(repo)
    yield* session.prompt([{ tools: [edited("zero.txt")], edit: write(path.join(repo, "zero.txt"), "zero two\n") }])
    const first = yield* session.prompt(
      [
        {
          tools: [created("a.txt")],
          edit: async () => {
            await Bun.write(path.join(repo, "a.txt"), "a\n")
            await Bun.write(path.join(repo, "shell.txt"), "shell two\n")
          },
        },
      ],
      false,
    )
    const steered = yield* session.prompt([{ tools: [created("b.txt")], edit: write(path.join(repo, "b.txt"), "b\n") }])
    const files = (query: string) =>
      server
        .request("GET", `/api/session/${session.sessionID}/diff?${query}&context=0`)
        .pipe(
          Effect.map((answer) => (answer.body?.data as Array<{ file: string }>).map((file) => file.file).toSorted()),
        )
    expect({
      first: yield* files(`from=${first}&scope=prompt`),
      steered: yield* files(`from=${steered}&scope=prompt`),
      turn: yield* files(`from=${first}`),
    }).toEqual({ first: ["a.txt"], steered: ["b.txt"], turn: ["a.txt", "b.txt", "shell.txt"] })
  }),
)

// Builder's rows beside the spec's: a checkpoint of the right shape that git cannot read answers the fixed `failed`
// sentence (class 9: no git output reaches the answer), an import keeps the well-formed fields of a step and drops only
// the malformed ones (class 7), and a prompt-scoped diff takes no `to`.
it.live("answers a checkpoint git cannot read as failed, and keeps the well-formed fields of an imported step", () =>
  Effect.gen(function* () {
    const server = yield* setup()
    const { repo } = yield* repository({ "tracked.txt": "one\n" })
    const session = yield* server.session(repo)
    const prompt = yield* session.prompt([
      { tools: [edited("tracked.txt")], edit: write(path.join(repo, "tracked.txt"), "two\n") },
    ])
    const ranged = yield* server.request(
      "GET",
      `/api/session/${session.sessionID}/diff?from=${prompt}&scope=prompt&to=${prompt}`,
    )
    expect(ranged).toMatchObject({ status: 400, body: { _tag: "InvalidRequestError", field: "to" } })
    const exported = yield* server.request("GET", `/api/experimental/session/${session.sessionID}/export`)
    const data = exported.body?.data as {
      info: Record<string, unknown>
      messages: Array<Record<string, unknown> & { id: string; type: string; snapshot?: Record<string, unknown> }>
    }
    const ids = new Map(data.messages.map((message) => [message.id, SessionMessage.ID.create()]))
    const imported = Session.ID.create()
    const missing = "0".repeat(40)
    const answer = yield* server.request("POST", "/api/experimental/session/import", {
      info: { ...data.info, id: imported },
      messages: data.messages.map((message) => ({
        ...message,
        id: ids.get(message.id),
        ...(message.type === "assistant" && message.snapshot
          ? {
              snapshot: {
                start: missing,
                end: "-x",
                files: ["tracked.txt", "../outside.txt", "a\\b", "./x", "/abs.txt"],
              },
            }
          : {}),
      })),
      location: { directory: repo },
    })
    expect(answer.status).toBe(200)
    const again = yield* server.request("GET", `/api/experimental/session/${imported}/export`)
    const step = (again.body?.data as typeof data).messages.find((message) => message.type === "assistant")
    expect(step?.snapshot).toEqual({ start: missing, files: ["tracked.txt"] })
    const user = ids.get(data.messages.find((message) => message.type === "user")!.id)!
    const rewind = (dryRun: boolean) =>
      server.request("POST", `/api/session/${imported}/revert/files`, { messageID: user, dryRun })
    const dry = yield* rewind(true)
    expect(dry).toEqual({ status: 200, body: { data: { canRewind: false, error: expect.any(String) } } })
    const real = yield* rewind(false)
    expect(real).toMatchObject({ status: 409, body: { _tag: "RewindFilesError", reason: "failed" } })
    expect((real.body as { message: string }).message).toBe((dry.body?.data as { error: string }).error)
    expect(yield* read(path.join(repo, "tracked.txt"))).toBe("two\n")
  }),
)
