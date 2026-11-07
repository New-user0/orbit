import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { Snapshot } from "@orbit/core/snapshot"
import { Money } from "@orbit/schema/money"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      Session.node,
      LocationServiceMap.node,
      Global.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Global.node.replace(tempGlobalLayer),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      offlineModels,
    ],
  ),
)

describe("Session.revert files", () => {
  it.live(
    "undoes and restores a file rename without losing either path",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        const original = path.join(directory, "old name.txt")
        const renamed = path.join(directory, "new name.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(directory)
          await Bun.write(original, "Preserve this content.\n")
          await Bun.write(path.join(directory, "unrelated.txt"), "Unrelated content.\n")
          await $`git init -q`.cwd(directory).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
        })

        const session = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const prompt = yield* session.prompt({ sessionID: created.id, text: "Rename the file", resume: false })
        yield* SessionInbox.promote(database.db, bus, created.id, "steer")

        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const snapshot = yield* Snapshot.Service
          const before = yield* snapshot.capture()
          if (!before) throw new Error("Initial snapshot missing")
          const assistantMessageID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: created.id,
            assistantMessageID,
            agent: Agent.defaultID,
            model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
            snapshot: before,
            started: 0,
          })
          // A revert puts back only what the session's file tools changed, so the rename is a recorded Patch move.
          const call = { sessionID: created.id, assistantMessageID, id: "call_move" }
          yield* bus.publish(SessionEvent.Tool.Input.Started, { ...call, name: "Patch" })
          yield* bus.publish(SessionEvent.Tool.Called, { ...call, input: {}, executed: true })
          yield* Effect.promise(() => fs.rename(original, renamed))
          yield* bus.publish(SessionEvent.Tool.Success, {
            ...call,
            content: [{ type: "text", text: "done" }],
            metadata: {
              files: [
                {
                  file: "new name.txt",
                  from: "old name.txt",
                  status: "modified",
                  additions: 0,
                  deletions: 0,
                  patch: "",
                },
              ],
            },
            executed: true,
          })
          const after = yield* snapshot.capture()
          if (!after) throw new Error("Renamed snapshot missing")
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: created.id,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            snapshot: after,
            files: yield* snapshot.files({ from: before, to: after }),
          })

          yield* Effect.promise(() => Bun.write(path.join(directory, "unrelated.txt"), "Keep this later edit.\n"))
          const reverted = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id })
          expect({
            original: yield* Effect.promise(() => Bun.file(original).exists()),
            renamed: yield* Effect.promise(() => Bun.file(renamed).exists()),
          }).toEqual({ original: true, renamed: false })
          expect(yield* Effect.promise(() => Bun.file(original).text())).toBe("Preserve this content.\n")
          expect(reverted.files?.map((file) => [file.file, file.status])).toEqual([
            ["new name.txt", "deleted"],
            ["old name.txt", "added"],
          ])
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "unrelated.txt")).text())).toBe(
            "Keep this later edit.\n",
          )

          yield* session.revert.clear(created.id)
          expect(yield* Effect.promise(() => Bun.file(original).exists())).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(renamed).text())).toBe("Preserve this content.\n")
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "unrelated.txt")).text())).toBe(
            "Keep this later edit.\n",
          )
          expect((yield* session.get(created.id)).revert).toBeUndefined()
        }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))
      }),
    // Real Location/plugin startup and Git snapshots can exceed five seconds under CI load.
    { timeout: 15_000 },
  )

  // clients-ux-5: the embedded host calls core's `revert.files`, not the HTTP route, so the code-only rewind is pinned
  // here too: a dry run names what would change, and the rewind removes the file a recorded Write created while a file
  // changed outside the file tools (the control) and the conversation stay as they are.
  it.live(
    "rewinds a prompt's file-tool edits, with a dry run first, and leaves other edits and the conversation",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        const written = path.join(directory, "written.txt")
        const other = path.join(directory, "other.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(directory)
          await Bun.write(other, "other one\n")
          await $`git init -q`.cwd(directory).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
        })

        const session = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const prompt = yield* session.prompt({ sessionID: created.id, text: "Write a file", resume: false })
        yield* SessionInbox.promote(database.db, bus, created.id, "steer")

        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const snapshot = yield* Snapshot.Service
          const before = yield* snapshot.capture()
          if (!before) throw new Error("Initial snapshot missing")
          const assistantMessageID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: created.id,
            assistantMessageID,
            agent: Agent.defaultID,
            model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
            snapshot: before,
            started: 0,
          })
          const call = { sessionID: created.id, assistantMessageID, id: "call_write" }
          yield* bus.publish(SessionEvent.Tool.Input.Started, { ...call, name: "Write" })
          yield* bus.publish(SessionEvent.Tool.Called, { ...call, input: {}, executed: true })
          yield* Effect.promise(async () => {
            await Bun.write(written, "one\ntwo\n")
            await Bun.write(other, "other two\n")
          })
          yield* bus.publish(SessionEvent.Tool.Success, {
            ...call,
            content: [{ type: "text", text: "done" }],
            metadata: {
              files: [{ file: "written.txt", status: "added", additions: 2, deletions: 0, patch: "" }],
            },
            executed: true,
          })
          const after = yield* snapshot.capture()
          if (!after) throw new Error("Written snapshot missing")
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: created.id,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            snapshot: after,
            files: yield* snapshot.files({ from: before, to: after }),
          })
          const messages = (yield* session.messages({ sessionID: created.id })).length

          const dry = yield* session.revert.files({ sessionID: created.id, messageID: prompt.id, dryRun: true })
          expect(dry).toEqual({
            canRewind: true,
            filesChanged: [path.join(yield* snapshot.root(), "written.txt")],
            insertions: 0,
            deletions: 2,
          })
          expect(yield* Effect.promise(() => Bun.file(written).exists())).toBe(true)

          expect(yield* session.revert.files({ sessionID: created.id, messageID: prompt.id })).toEqual({
            canRewind: true,
          })
          expect({
            written: yield* Effect.promise(() => Bun.file(written).exists()),
            other: yield* Effect.promise(() => Bun.file(other).text()),
            messages: (yield* session.messages({ sessionID: created.id })).length,
            revert: (yield* session.get(created.id)).revert,
          }).toEqual({ written: false, other: "other two\n", messages, revert: undefined })
        }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))

        // A checkpoint lives in the snapshot repository of the folder that took it. Once the session has moved to
        // another repository, the prompt has no checkpoint there: the rewind says so instead of handing that folder's
        // git a tree it does not hold, and the file in the first folder stays as it is.
        const elsewhere = path.join(tmp.path, "elsewhere")
        yield* Effect.promise(async () => {
          await fs.mkdir(elsewhere)
          await Bun.write(path.join(elsewhere, "other.txt"), "elsewhere\n")
          await $`git init -q`.cwd(elsewhere).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(elsewhere).quiet()
          await Bun.write(written, "again\n")
        })
        yield* bus.publish(SessionEvent.Moved, {
          sessionID: created.id,
          location: { directory: AbsolutePath.make(elsewhere) },
          projectID: created.projectID,
        })
        const moved = yield* session.revert
          .files({ sessionID: created.id, messageID: prompt.id })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
        expect(moved).toMatchObject({ _tag: "Session.RewindError", reason: "no-checkpoint" })
        expect(yield* Effect.promise(() => Bun.file(written).text())).toBe("again\n")
      }),
    { timeout: 15_000 },
  )

  // A revert compares the file-tool edits with a capture of the files taken first. When that capture fails (here the
  // snapshot repository's index is damaged, so git refuses it), a revert that asked for its files fails instead of
  // staging the conversation alone and reporting success; the file stays. The control is the same revert without its
  // files, which needs no capture and is staged.
  it.live(
    "fails a revert with its files when the capture before it fails, and stages one without its files",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        const written = path.join(directory, "written.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(directory)
          await Bun.write(path.join(directory, "other.txt"), "other\n")
          await $`git init -q`.cwd(directory).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
        })

        const session = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const global = yield* Global.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const prompt = yield* session.prompt({ sessionID: created.id, text: "Write a file", resume: false })
        yield* SessionInbox.promote(database.db, bus, created.id, "steer")

        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const snapshot = yield* Snapshot.Service
          const before = yield* snapshot.capture()
          if (!before) throw new Error("Initial snapshot missing")
          const assistantMessageID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: created.id,
            assistantMessageID,
            agent: Agent.defaultID,
            model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
            snapshot: before,
            started: 0,
          })
          const call = { sessionID: created.id, assistantMessageID, id: "call_write" }
          yield* bus.publish(SessionEvent.Tool.Input.Started, { ...call, name: "Write" })
          yield* bus.publish(SessionEvent.Tool.Called, { ...call, input: {}, executed: true })
          yield* Effect.promise(() => Bun.write(written, "one\n"))
          yield* bus.publish(SessionEvent.Tool.Success, {
            ...call,
            content: [{ type: "text", text: "done" }],
            metadata: { files: [{ file: "written.txt", status: "added", additions: 1, deletions: 0, patch: "" }] },
            executed: true,
          })
          const after = yield* snapshot.capture()
          if (!after) throw new Error("Written snapshot missing")
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: created.id,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            snapshot: after,
            files: yield* snapshot.files({ from: before, to: after }),
          })
        }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))

        yield* Effect.promise(async () => {
          const root = path.join(global.data, "snapshot")
          for (const project of await fs.readdir(root))
            for (const repository of await fs.readdir(path.join(root, project)))
              await fs.writeFile(path.join(root, project, repository, "index"), "not an index")
        })
        const failed = yield* session.revert
          .stage({ sessionID: created.id, messageID: prompt.id })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
        expect({
          failed: failed?._tag,
          written: yield* Effect.promise(() => Bun.file(written).text()),
          revert: (yield* session.get(created.id)).revert,
        }).toEqual({ failed: "Snapshot.Error", written: "one\n", revert: undefined })

        const staged = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id, files: false })
        expect({ staged, written: yield* Effect.promise(() => Bun.file(written).text()) }).toEqual({
          staged: { messageID: prompt.id, snapshot: undefined, files: [] },
          written: "one\n",
        })
      }),
    { timeout: 15_000 },
  )
})

// clients-ux-5 part 2: the rewind picker's "Conversation only" stages a revert without its files. When a revert with
// files is already staged (the picker's "Code and conversation", or /undo), moving the boundary earlier without files
// must leave the files as the staged revert left them, as a conversation rewind in the reference never touches code,
// and /redo must still put back everything the staged reverts changed.
describe("Session.revert conversation only over a staged revert", () => {
  it.live(
    "leaves the files a staged revert put back, and /redo still restores them",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        const file = path.join(directory, "a.txt")
        yield* repository(directory, { "a.txt": "base\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const first = yield* promptNow(created.id, "Write one")
        yield* recordStep(created.id, [{ name: "Write", files: ["a.txt"] }], () => Bun.write(file, "one\n"))
        const second = yield* promptNow(created.id, "Write two")
        yield* recordStep(created.id, [{ name: "Write", files: ["a.txt"] }], () => Bun.write(file, "two\n"))

        // "Code and conversation" at the second prompt: the file goes back to its content before that prompt.
        yield* session.revert.stage({ sessionID: created.id, messageID: second.id })
        expect(yield* text(file)).toBe("one\n")

        // "Conversation only" at the first prompt moves the boundary and leaves the file as it is.
        const moved = yield* session.revert.stage({ sessionID: created.id, messageID: first.id, files: false })
        expect(moved.messageID).toBe(first.id)
        expect(yield* text(file)).toBe("one\n")

        // /redo puts back what the staged reverts changed.
        yield* session.revert.clear(created.id)
        expect(yield* text(file)).toBe("two\n")
        expect((yield* session.get(created.id)).revert).toBeUndefined()
      }),
    { timeout: 30_000 },
  )
})

// A recorded name is the spelling of the folder its step ran in. Once the session has moved, the same name in the
// folder it is in now is another file, which a file tool there never touched: a rewind and an undo leave it, and
// still put back what a file tool changed in the folder they restore.
describe("Session.revert names from another folder", () => {
  it.live(
    "leaves a shell edit after a session move to another repository, and rewinds a Write made there",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const first = path.join(tmp.path, "first")
        const second = path.join(tmp.path, "second")
        yield* repository(first, { "x.txt": "base\n" })
        yield* repository(second, { "x.txt": "base\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(first) } })
        yield* promptNow(created.id, "Edit x")
        yield* recordStep(created.id, [{ name: "Write", files: ["x.txt"] }], () =>
          Bun.write(path.join(first, "x.txt"), "tool edit\n"),
        )
        yield* moveTo(created, second)
        const prompt = yield* promptNow(created.id, "Go on")
        yield* recordStep(created.id, [{ name: "Write", files: ["y.txt"] }], async () => {
          await Bun.write(path.join(second, "x.txt"), "shell edit\n")
          await Bun.write(path.join(second, "y.txt"), "written\n")
        })
        const files = () =>
          Effect.all({
            shell: text(path.join(second, "x.txt")),
            written: text(path.join(second, "y.txt")),
            first: text(path.join(first, "x.txt")),
          })

        yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id })
        expect(yield* files()).toEqual({ shell: "shell edit\n", written: undefined, first: "tool edit\n" })
        yield* session.revert.clear(created.id)
        expect(yield* files()).toEqual({ shell: "shell edit\n", written: "written\n", first: "tool edit\n" })

        const dry = yield* session.revert.files({ sessionID: created.id, messageID: prompt.id, dryRun: true })
        expect(dry.filesChanged?.map((file) => path.basename(file))).toEqual(["y.txt"])
        expect(yield* session.revert.files({ sessionID: created.id, messageID: prompt.id })).toEqual({
          canRewind: true,
        })
        expect(yield* files()).toEqual({ shell: "shell edit\n", written: undefined, first: "tool edit\n" })
      }),
    { timeout: 30_000 },
  )

  it.live(
    "leaves a shell edit in a worktree the session entered, and rewinds a Write made there",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const checkout = path.join(tmp.path, "checkout")
        const tree = path.join(tmp.path, "tree")
        yield* repository(checkout, { "x.txt": "base\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(checkout) } })
        yield* promptNow(created.id, "Edit x, then work in a worktree")
        yield* recordStep(
          created.id,
          [
            { name: "Write", files: ["x.txt"] },
            { name: "EnterWorktree", input: { name: "spike" } },
          ],
          async () => {
            await Bun.write(path.join(checkout, "x.txt"), "tool edit\n")
            await $`git worktree add -q -b spike ${tree}`.cwd(checkout).quiet()
          },
        )
        // What EnterWorktree's move becomes once the runner applies it.
        yield* moveTo(created, tree)
        const prompt = yield* promptNow(created.id, "Go on")
        yield* recordStep(created.id, [{ name: "Write", files: ["y.txt"] }], async () => {
          await Bun.write(path.join(tree, "x.txt"), "shell edit\n")
          await Bun.write(path.join(tree, "y.txt"), "written\n")
        })

        const dry = yield* session.revert.files({ sessionID: created.id, messageID: prompt.id, dryRun: true })
        expect(dry.filesChanged?.map((file) => path.basename(file))).toEqual(["y.txt"])
        yield* session.revert.files({ sessionID: created.id, messageID: prompt.id })
        expect(
          yield* Effect.all({
            shell: text(path.join(tree, "x.txt")),
            written: text(path.join(tree, "y.txt")),
            checkout: text(path.join(checkout, "x.txt")),
          }),
        ).toEqual({ shell: "shell edit\n", written: undefined, checkout: "tool edit\n" })
      }),
    { timeout: 30_000 },
  )

  it.live(
    "leaves a shell edit after ExitWorktree to a file a Write changed in the worktree, and keeps the checkout's own names",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const checkout = path.join(tmp.path, "checkout")
        const tree = path.join(tmp.path, "tree")
        yield* repository(checkout, { "x.txt": "base\n", "z.txt": "base\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(checkout) } })
        yield* promptNow(created.id, "Edit z, then work in a worktree")
        yield* recordStep(
          created.id,
          [
            { name: "Write", files: ["z.txt"] },
            { name: "EnterWorktree", input: {} },
          ],
          async () => {
            await Bun.write(path.join(checkout, "z.txt"), "tool edit\n")
            await $`git worktree add -q -b spike ${tree}`.cwd(checkout).quiet()
          },
        )
        yield* moveTo(created, tree)
        yield* promptNow(created.id, "Edit x there, then come back")
        yield* recordStep(
          created.id,
          [
            { name: "Write", files: ["x.txt"] },
            { name: "ExitWorktree", input: {} },
          ],
          () => Bun.write(path.join(tree, "x.txt"), "tool edit\n"),
        )
        // What ExitWorktree's move back becomes once the runner applies it.
        yield* moveTo(created, checkout)
        const prompt = yield* promptNow(created.id, "Go on")
        yield* recordStep(created.id, [], async () => {
          await Bun.write(path.join(checkout, "x.txt"), "shell edit\n")
          await Bun.write(path.join(checkout, "z.txt"), "shell edit\n")
        })

        const dry = yield* session.revert.files({ sessionID: created.id, messageID: prompt.id, dryRun: true })
        expect(dry.filesChanged?.map((file) => path.basename(file))).toEqual(["z.txt"])
        yield* session.revert.files({ sessionID: created.id, messageID: prompt.id })
        // z.txt was written by a file tool in this same folder before the session left it, so its name still counts.
        expect(
          yield* Effect.all({
            shell: text(path.join(checkout, "x.txt")),
            tool: text(path.join(checkout, "z.txt")),
            tree: text(path.join(tree, "x.txt")),
          }),
        ).toEqual({ shell: "shell edit\n", tool: "tool edit\n", tree: "tool edit\n" })
      }),
    { timeout: 30_000 },
  )

  // Before Write named its file in its result, a recorded Write carried only the path it was given. That path, in each
  // spelling an older session can hold, still lets a rewind remove the file; a Write that failed, another tool's call
  // that names no file, and a file changed outside the file tools are left.
  it.live(
    "rewinds a Write recorded before Write named its file, by the path it was given",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        yield* repository(directory, { "other.txt": "other one\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const prompt = yield* promptNow(created.id, "Write files")
        yield* recordStep(
          created.id,
          [
            { name: "Write", input: { file_path: "relative.txt", content: "one\n" } },
            { name: "Write", input: { file_path: path.join(directory, "absolute.txt"), content: "one\n" } },
            { name: "write", input: { path: "legacy.txt", content: "one\n" } },
            { name: "Write", input: { file_path: "failed.txt", content: "one\n" }, failed: true },
            { name: "Edit", input: { file_path: "edited.txt" } },
          ],
          () =>
            Promise.all(
              ["relative.txt", "absolute.txt", "legacy.txt", "failed.txt", "edited.txt"]
                .map((file) => Bun.write(path.join(directory, file), "one\n"))
                .concat(Bun.write(path.join(directory, "other.txt"), "other two\n")),
            ),
        )

        yield* session.revert.files({ sessionID: created.id, messageID: prompt.id })
        expect(
          yield* Effect.all({
            relative: text(path.join(directory, "relative.txt")),
            absolute: text(path.join(directory, "absolute.txt")),
            legacy: text(path.join(directory, "legacy.txt")),
            failed: text(path.join(directory, "failed.txt")),
            edited: text(path.join(directory, "edited.txt")),
            other: text(path.join(directory, "other.txt")),
          }),
        ).toEqual({
          relative: undefined,
          absolute: undefined,
          legacy: undefined,
          failed: "one\n",
          edited: "one\n",
          other: "other two\n",
        })
      }),
    { timeout: 30_000 },
  )

  // A staged revert takes its paths from the steps' stored lists, which an imported session fills as its file says
  // (class 5). A stored name only selects among the paths git reports as changed: an ignored file is in neither capture,
  // so a stored list and a Write that both name it delete nothing. The control is the Write's other file, which goes.
  it.live(
    "leaves an ignored file that a step's stored list and a Write name, and undoes the control",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        yield* repository(directory, { ".gitignore": "*.log\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const prompt = yield* promptNow(created.id, "Write files")
        yield* recordStep(
          created.id,
          [{ name: "Write", files: ["debug.log", "written.txt"] }],
          () =>
            Promise.all([
              Bun.write(path.join(directory, "debug.log"), "kept\n"),
              Bun.write(path.join(directory, "written.txt"), "one\n"),
            ]),
          ["debug.log"],
        )

        yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id })
        expect(
          yield* Effect.all({
            ignored: text(path.join(directory, "debug.log")),
            written: text(path.join(directory, "written.txt")),
          }),
        ).toEqual({ ignored: "kept\n", written: undefined })
      }),
    { timeout: 30_000 },
  )
})

// A step's trees live in the snapshot repository of the folder it ran in, and its paths are that folder's files. Each
// row is a history whose folder changed after the prompt that an undo, a rewind and a dry run go back to. The rewind and
// the dry run find no checkpoint there. The undo puts back only what a file tool changed in the folder the session is
// in now, from that folder's own trees, and leaves the shell edit and the other folder; a redo then brings it all back.
const switches = [
  {
    name: "to a prompt before EnterWorktree, from the worktree",
    build: (root: string) =>
      Effect.gen(function* () {
        const checkout = path.join(root, "checkout")
        const tree = path.join(root, "tree")
        yield* repository(checkout, { "x.txt": "base\n" })
        // A file the worktree does not get, so no tree of the checkout's is also one of the worktree's.
        yield* Effect.promise(() => Bun.write(path.join(checkout, "draft.txt"), "draft\n"))
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(checkout) } })
        const target = yield* promptNow(created.id, "Write z, then work in a worktree")
        yield* recordStep(
          created.id,
          [
            { name: "Write", files: ["z.txt"] },
            { name: "EnterWorktree", input: {} },
          ],
          async () => {
            await Bun.write(path.join(checkout, "z.txt"), "tool edit\n")
            await $`git worktree add -q -b spike ${tree}`.cwd(checkout).quiet()
          },
        )
        yield* moveTo(created, tree)
        yield* promptNow(created.id, "Go on")
        yield* recordStep(created.id, [{ name: "Write", files: ["y.txt"] }], async () => {
          await Bun.write(path.join(tree, "x.txt"), "shell edit\n")
          await Bun.write(path.join(tree, "y.txt"), "written\n")
        })
        return {
          sessionID: created.id,
          target: target.id,
          files: () =>
            Effect.all({
              checkout: text(path.join(checkout, "z.txt")),
              shell: text(path.join(tree, "x.txt")),
              written: text(path.join(tree, "y.txt")),
            }),
          undone: { checkout: "tool edit\n", shell: "shell edit\n", written: undefined },
        }
      }),
  },
  {
    name: "to a prompt before EnterWorktree, after ExitWorktree brought the session back",
    build: (root: string) =>
      Effect.gen(function* () {
        const checkout = path.join(root, "checkout")
        const tree = path.join(root, "tree")
        yield* repository(checkout, { "x.txt": "base\n", "z.txt": "base\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(checkout) } })
        const target = yield* promptNow(created.id, "Edit z, then work in a worktree")
        yield* recordStep(
          created.id,
          [
            { name: "Write", files: ["z.txt"] },
            { name: "EnterWorktree", input: {} },
          ],
          async () => {
            await Bun.write(path.join(checkout, "z.txt"), "tool edit\n")
            await $`git worktree add -q -b spike ${tree}`.cwd(checkout).quiet()
          },
        )
        yield* moveTo(created, tree)
        yield* promptNow(created.id, "Edit x there, then come back")
        yield* recordStep(
          created.id,
          [
            { name: "Write", files: ["x.txt"] },
            { name: "ExitWorktree", input: {} },
          ],
          () => Bun.write(path.join(tree, "x.txt"), "tool edit\n"),
        )
        yield* moveTo(created, checkout)
        yield* promptNow(created.id, "Go on")
        yield* recordStep(created.id, [], () => Bun.write(path.join(checkout, "x.txt"), "shell edit\n"))
        return {
          sessionID: created.id,
          target: target.id,
          files: () =>
            Effect.all({
              tool: text(path.join(checkout, "z.txt")),
              shell: text(path.join(checkout, "x.txt")),
              tree: text(path.join(tree, "x.txt")),
            }),
          undone: { tool: "base\n", shell: "shell edit\n", tree: "tool edit\n" },
        }
      }),
  },
  {
    name: "to a prompt before a session move to another repository",
    build: (root: string) =>
      Effect.gen(function* () {
        const first = path.join(root, "first")
        const second = path.join(root, "second")
        yield* repository(first, { "x.txt": "base\n" })
        // Different content, so no tree of one repository is also one of the other's.
        yield* repository(second, { "x.txt": "base\n", "second.txt": "second\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(first) } })
        const target = yield* promptNow(created.id, "Write a")
        yield* recordStep(created.id, [{ name: "Write", files: ["a.txt"] }], () =>
          Bun.write(path.join(first, "a.txt"), "written\n"),
        )
        yield* moveTo(created, second)
        yield* promptNow(created.id, "Go on")
        yield* recordStep(created.id, [{ name: "Write", files: ["y.txt"] }], async () => {
          await Bun.write(path.join(second, "x.txt"), "shell edit\n")
          await Bun.write(path.join(second, "y.txt"), "written\n")
        })
        return {
          sessionID: created.id,
          target: target.id,
          files: () =>
            Effect.all({
              first: text(path.join(first, "a.txt")),
              shell: text(path.join(second, "x.txt")),
              written: text(path.join(second, "y.txt")),
            }),
          undone: { first: "written\n", shell: "shell edit\n", written: undefined },
        }
      }),
  },
  {
    // The control: back in the first folder, its own trees and names count again, on both sides of the trip.
    name: "to a prompt before a move to another repository and back",
    build: (root: string) =>
      Effect.gen(function* () {
        const first = path.join(root, "first")
        const second = path.join(root, "second")
        yield* repository(first, { "x.txt": "base\n" })
        // Different content, so no tree of one repository is also one of the other's.
        yield* repository(second, { "x.txt": "base\n", "second.txt": "second\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(first) } })
        const target = yield* promptNow(created.id, "Write a")
        yield* recordStep(created.id, [{ name: "Write", files: ["a.txt"] }], () =>
          Bun.write(path.join(first, "a.txt"), "written\n"),
        )
        yield* moveTo(created, second)
        yield* promptNow(created.id, "Write y there")
        yield* recordStep(created.id, [{ name: "Write", files: ["y.txt"] }], () =>
          Bun.write(path.join(second, "y.txt"), "written\n"),
        )
        yield* moveTo(created, first)
        const back = yield* promptNow(created.id, "Write b")
        yield* recordStep(created.id, [{ name: "Write", files: ["b.txt"] }], async () => {
          await Bun.write(path.join(first, "x.txt"), "shell edit\n")
          await Bun.write(path.join(first, "b.txt"), "written\n")
        })
        const files = () =>
          Effect.all({
            a: text(path.join(first, "a.txt")),
            b: text(path.join(first, "b.txt")),
            shell: text(path.join(first, "x.txt")),
            second: text(path.join(second, "y.txt")),
          })
        return {
          sessionID: created.id,
          target: target.id,
          files,
          undone: { a: undefined, b: undefined, shell: "shell edit\n", second: "written\n" },
          // A prompt after the trip back has a checkpoint in this folder, so a rewind to it works.
          control: {
            messageID: back.id,
            dry: ["b.txt"],
            files: { a: "written\n", b: undefined, shell: "shell edit\n", second: "written\n" },
          },
        }
      }),
  },
  {
    // Committing an undo drops the messages after its prompt, but not the record of the move among them: the steps
    // before it still ran in the checkout, whose trees the worktree's git does not hold.
    name: "to a prompt before EnterWorktree, after an undo to a later prompt was committed in the worktree",
    build: (root: string) =>
      Effect.gen(function* () {
        const checkout = path.join(root, "checkout")
        const tree = path.join(root, "tree")
        yield* repository(checkout, { "x.txt": "base\n" })
        yield* Effect.promise(() => Bun.write(path.join(checkout, "draft.txt"), "draft\n"))
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(checkout) } })
        const target = yield* promptNow(created.id, "Write a")
        yield* recordStep(created.id, [{ name: "Write", files: ["a.txt"] }], () =>
          Bun.write(path.join(checkout, "a.txt"), "written\n"),
        )
        const entered = yield* promptNow(created.id, "Work in a worktree")
        yield* recordStep(created.id, [{ name: "EnterWorktree", input: {} }], () =>
          $`git worktree add -q -b spike ${tree}`.cwd(checkout).quiet(),
        )
        yield* moveTo(created, tree)
        yield* promptNow(created.id, "Write y")
        yield* recordStep(created.id, [{ name: "Write", files: ["y.txt"] }], () =>
          Bun.write(path.join(tree, "y.txt"), "written\n"),
        )
        yield* session.revert.stage({ sessionID: created.id, messageID: entered.id })
        // The next prompt commits the undo.
        yield* promptNow(created.id, "Write w")
        yield* recordStep(created.id, [{ name: "Write", files: ["w.txt"] }], async () => {
          await Bun.write(path.join(tree, "x.txt"), "shell edit\n")
          await Bun.write(path.join(tree, "w.txt"), "written\n")
        })
        return {
          sessionID: created.id,
          target: target.id,
          files: () =>
            Effect.all({
              checkout: text(path.join(checkout, "a.txt")),
              shell: text(path.join(tree, "x.txt")),
              written: text(path.join(tree, "w.txt")),
              committed: text(path.join(tree, "y.txt")),
            }),
          undone: { checkout: "written\n", shell: "shell edit\n", written: undefined, committed: undefined },
        }
      }),
  },
]

describe("Session.revert across a folder switch", () => {
  for (const row of switches)
    it.live(
      `undoes, rewinds and dry-runs ${row.name}`,
      () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          const history = yield* row.build(tmp.path)
          const session = yield* Session.Service
          const before = yield* history.files()

          const dry = yield* session.revert.files({
            sessionID: history.sessionID,
            messageID: history.target,
            dryRun: true,
          })
          const rewound = yield* session.revert
            .files({ sessionID: history.sessionID, messageID: history.target })
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
          expect({ dry: dry.canRewind, rewound, files: yield* history.files() }).toMatchObject({
            dry: false,
            rewound: { _tag: "Session.RewindError", reason: "no-checkpoint" },
            files: before,
          })

          yield* session.revert.stage({ sessionID: history.sessionID, messageID: history.target })
          expect(yield* history.files()).toEqual(history.undone)
          yield* session.revert.clear(history.sessionID)
          expect(yield* history.files()).toEqual(before)

          if (!("control" in history)) return
          const control = yield* session.revert.files({
            sessionID: history.sessionID,
            messageID: history.control.messageID,
            dryRun: true,
          })
          expect(control.filesChanged?.map((file) => path.basename(file))).toEqual(history.control.dry)
          yield* session.revert.files({ sessionID: history.sessionID, messageID: history.control.messageID })
          expect(yield* history.files()).toEqual(history.control.files)
        }),
      { timeout: 30_000 },
    )

  // A move commits a staged undo, as a prompt does: the undo's tree and paths belong to the folder the session leaves,
  // so a redo from the destination would hand its git another repository's tree. The undo stays, and the redo after the
  // move has nothing to bring back.
  it.live(
    "commits a staged undo when the session moves, so a redo there touches nothing",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const first = path.join(tmp.path, "first")
        const second = path.join(tmp.path, "second")
        yield* repository(first, { "x.txt": "base\n" })
        yield* repository(second, { "x.txt": "base\n", "second.txt": "second\n" })
        const session = yield* Session.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(first) } })
        const prompt = yield* promptNow(created.id, "Write a")
        yield* recordStep(created.id, [{ name: "Write", files: ["a.txt"] }], () =>
          Promise.all([
            Bun.write(path.join(first, "a.txt"), "written\n"),
            Bun.write(path.join(second, "a.txt"), "second\n"),
          ]),
        )
        yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id })
        yield* session.move({ sessionID: created.id, directory: AbsolutePath.make(second) })
        // What the queued move becomes once the runner applies it.
        yield* moveTo(created, second)
        yield* session.revert.clear(created.id)
        expect({
          revert: (yield* session.get(created.id)).revert,
          prompts: (yield* session.messages({ sessionID: created.id })).filter((message) => message.type === "user")
            .length,
          first: yield* text(path.join(first, "a.txt")),
          second: yield* text(path.join(second, "a.txt")),
        }).toEqual({ revert: undefined, prompts: 0, first: undefined, second: "second\n" })
      }),
    { timeout: 30_000 },
  )
})

const text = (file: string) =>
  Effect.promise(async () => ((await Bun.file(file).exists()) ? Bun.file(file).text() : undefined))

const repository = (directory: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    await fs.mkdir(directory, { recursive: true })
    await Promise.all(Object.entries(files).map(([file, content]) => Bun.write(path.join(directory, file), content)))
    await $`git init -q`.cwd(directory).quiet()
    await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
    await $`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm base`.cwd(directory).quiet()
  })

const promptNow = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const prompt = yield* session.prompt({ sessionID, text, resume: false })
    yield* SessionInbox.promote(database.db, bus, sessionID, "steer")
    return prompt
  })

const moveTo = (
  session: { readonly id: Session.ID; readonly projectID: Session.Info["projectID"] },
  directory: string,
) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Moved, {
      sessionID: session.id,
      location: { directory: AbsolutePath.make(directory) },
      projectID: session.projectID,
    })
  })

// One step in the folder the session is in now: its start capture, the tool calls it records, what it changes on disk
// and its end capture. `stored` adds names to the step's stored list of changed files, as an imported session can.
const recordStep = (
  sessionID: Session.ID,
  calls: ReadonlyArray<{
    readonly name: string
    readonly input?: Record<string, unknown>
    readonly files?: ReadonlyArray<string>
    readonly failed?: boolean
  }>,
  edit: () => Promise<unknown>,
  stored: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const bus = yield* Bus.Service
    const location = (yield* session.get(sessionID)).location
    yield* Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const snapshot = yield* Snapshot.Service
      const before = yield* snapshot.capture()
      if (!before) throw new Error("Start snapshot missing")
      const assistantMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: Agent.defaultID,
        model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
        snapshot: before,
        started: 0,
      })
      yield* Effect.forEach(calls, (call, index) =>
        Effect.gen(function* () {
          const identity = { sessionID, assistantMessageID, id: `call_${index}` }
          yield* bus.publish(SessionEvent.Tool.Input.Started, { ...identity, name: call.name })
          yield* bus.publish(SessionEvent.Tool.Called, { ...identity, input: call.input ?? {}, executed: true })
          const metadata = call.files
            ? {
                metadata: {
                  files: call.files.map((file) => ({
                    file,
                    status: "modified",
                    additions: 0,
                    deletions: 0,
                    patch: "",
                  })),
                },
              }
            : {}
          if (call.failed)
            return yield* bus.publish(SessionEvent.Tool.Failed, {
              ...identity,
              error: { type: "unknown", message: "failed" },
              ...metadata,
              executed: true,
            })
          yield* bus.publish(SessionEvent.Tool.Success, {
            ...identity,
            content: [{ type: "text", text: "done" }],
            ...metadata,
            executed: true,
          })
        }),
      )
      yield* Effect.promise(edit)
      const after = yield* snapshot.capture()
      if (!after) throw new Error("End snapshot missing")
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: "stop",
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        snapshot: after,
        files: [
          ...(yield* snapshot.files({ from: before, to: after })),
          ...stored.map((file) => RelativePath.make(file)),
        ],
      })
    }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
  })
