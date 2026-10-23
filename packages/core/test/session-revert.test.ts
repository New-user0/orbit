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
import { AbsolutePath } from "@orbit/core/schema"
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
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, Session.node, LocationServiceMap.node]),
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
})
