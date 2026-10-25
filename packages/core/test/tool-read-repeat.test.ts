import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { Image } from "@orbit/core/image"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInstructions } from "@orbit/core/session/instructions"
import { InstructionTriggers } from "@orbit/core/instruction-triggers"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin } from "./lib/tool"

const readToolNode = makeLocationNode({
  name: "test/read-repeat-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileLedger.node,
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    InstructionTriggers.node,
    InstructionDiscovery.node,
    FSUtil.node,
    Location.node,
  ],
})

// The real read, ledger, bus and file system: only the permission prompt is replaced.
const config = Config.testLayer()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      Location.node,
      FSUtil.node,
      FileAccess.node,
      ReadToolFileSystem.node,
      readToolNode,
      FileLedger.node,
      Tool.node,
      PluginHooks.node,
      ProjectTrust.node,
      SessionInstructions.node,
      InstructionTriggers.node,
      InstructionDiscovery.node,
      Global.node,
      Image.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Location.node.replace(tempLocationLayer),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      Config.node.replace(config),
      Image.node.replace(AppNodeBuilder.build(Image.node, [Config.node.replace(config)])),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: true })),
    ],
  ),
)

const readCall = (
  sessionID: Session.ID,
  id: string,
  file: string,
  page: ReadToolFileSystem.PageInput = {},
): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_repeat"),
  call: { type: "tool-call", id, name: "Read", input: { file_path: file, ...page } },
})

const text = (result: unknown) => JSON.stringify(result)

describe("Read repeat stubs", () => {
  const setup = Effect.gen(function* () {
    const location = yield* Location.Service
    const file = path.join(location.directory, "notes.txt")
    yield* Effect.promise(() => fs.writeFile(file, "one\ntwo\nthree\n"))
    const session = yield* Session.Service
    const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
    return { file, sessionID, registry: yield* Tool.Service, bus: yield* Bus.Service }
  })
  const unchanged = [{ type: "text", text: ReadTool.unchangedStub("notes.txt") }]

  it.live("answers an identical repeat read with the stub, and keeps the structured output", () =>
    Effect.gen(function* () {
      const { sessionID, registry } = yield* setup
      const first = yield* executeTool(registry, readCall(sessionID, "a", "notes.txt"))
      const second = yield* executeTool(registry, readCall(sessionID, "b", "notes.txt"))
      const third = yield* executeTool(registry, readCall(sessionID, "c", "notes.txt"))

      expect(first).toMatchObject({ status: "completed", metadata: { truncated: false } })
      expect(text(first)).toContain("1: one")
      expect(first).not.toHaveProperty("metadata.unchanged")
      expect(second).toMatchObject({
        status: "completed",
        content: unchanged,
        metadata: { truncated: false, unchanged: true },
        output: { type: "file", content: "one\ntwo\nthree\n" },
      })
      // A third identical read still gets the stub.
      expect(third).toMatchObject({ content: unchanged, metadata: { unchanged: true } })
    }),
  )

  it.live("gives full content for a different range, and again once the file changed", () =>
    Effect.gen(function* () {
      const { file, sessionID, registry } = yield* setup
      yield* executeTool(registry, readCall(sessionID, "a", "notes.txt"))

      const other = yield* executeTool(registry, readCall(sessionID, "b", "notes.txt", { offset: 2 }))
      expect(text(other)).toContain("2: two")
      expect(other).not.toHaveProperty("metadata.unchanged")
      const otherAgain = yield* executeTool(registry, readCall(sessionID, "c", "notes.txt", { offset: 2 }))
      expect(otherAgain).toMatchObject({ content: unchanged, metadata: { unchanged: true } })

      yield* Effect.promise(() => fs.writeFile(file, "one\nTWO\nthree\n"))
      const changed = yield* executeTool(registry, readCall(sessionID, "d", "notes.txt"))
      expect(text(changed)).toContain("2: TWO")
      expect(changed).not.toHaveProperty("metadata.unchanged")
    }),
  )

  it.live("keeps the sessions apart", () =>
    Effect.gen(function* () {
      const { sessionID, registry } = yield* setup
      const session = yield* Session.Service
      const location = yield* Location.Service
      const other = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      yield* executeTool(registry, readCall(sessionID, "a", "notes.txt"))
      expect(yield* executeTool(registry, readCall(other, "b", "notes.txt"))).not.toHaveProperty("metadata.unchanged")
    }),
  )

  it.live("gives full content after the session was compacted", () =>
    Effect.gen(function* () {
      const { sessionID, registry, bus } = yield* setup
      yield* executeTool(registry, readCall(sessionID, "a", "notes.txt"))
      expect(yield* executeTool(registry, readCall(sessionID, "b", "notes.txt"))).toMatchObject({ content: unchanged })

      yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
      yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary", recent: "" })

      const after = yield* executeTool(registry, readCall(sessionID, "c", "notes.txt"))
      expect(text(after)).toContain("1: one")
      expect(after).not.toHaveProperty("metadata.unchanged")
    }),
  )

  it.live(
    "Compaction.Ended clears marks and freshness, RevertEvent.Committed only the marks, Compaction.Failed nothing",
    () =>
      Effect.gen(function* () {
        const { file, sessionID, bus } = yield* setup
        const ledger = yield* FileLedger.Service
        yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: "boundary", description: "boundary" })
        const store = yield* SessionStore.Service
        const boundary = (yield* store.context(sessionID)).filter((message) => message.type === "synthetic")[0]!.id
        const mark = () => ledger.markRead(sessionID, file, "1:default", "digest")

        yield* ledger.recordRead(sessionID, file, { mtimeMs: 1 })
        yield* mark()
        expect(yield* mark()).toBe(true)
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: "manual",
          error: { type: "compaction.failed", message: "failed" },
        })
        expect(yield* mark()).toBe(true)
        yield* ledger.assertFresh(sessionID, file, "notes.txt", { mtimeMs: 1, digest: "x" })

        yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID, revert: { messageID: boundary, files: [] } })
        yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: boundary })
        expect(yield* mark()).toBe(false)
        // The revert kept freshness: the file is still the one the session read.
        yield* ledger.assertFresh(sessionID, file, "notes.txt", { mtimeMs: 1, digest: "x" })

        expect(yield* mark()).toBe(true)
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
        yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary", recent: "" })
        expect(yield* mark()).toBe(false)
        // A completed compaction forgot the read itself, so the file has to be read again before it is changed.
        expect((yield* ledger.assertFresh(sessionID, file, "notes.txt").pipe(Effect.flip)).code).toBe("file.unread")
      }),
  )

  // context-memory-3: a clearing leaves old read results out of what the model is sent, so a repeat read must show the
  // text again. The marks hold the path the read resolved, which the result does not, so every mark of the session goes;
  // freshness stays, because the file did not change.
  it.live("Context.Cleared forgets the repeat-read marks and keeps freshness", () =>
    Effect.gen(function* () {
      const { file, sessionID, bus } = yield* setup
      const ledger = yield* FileLedger.Service
      const location = yield* Location.Service
      const other = (yield* (yield* Session.Service).create({
        location: Location.Ref.make({ directory: location.directory }),
      })).id
      const mark = (id: Session.ID) => ledger.markRead(id, file, "1:default", "digest")

      yield* ledger.recordRead(sessionID, file, { mtimeMs: 1 })
      yield* mark(sessionID)
      yield* mark(other)
      expect(yield* mark(sessionID)).toBe(true)

      yield* bus.publish(SessionEvent.ContextCleared, {
        sessionID,
        trigger: "idle",
        tools: [{ assistantMessageID: SessionMessage.ID.make("msg_gone"), id: "call_gone" }],
      })

      expect(yield* mark(sessionID)).toBe(false)
      // Another session's marks are its own.
      expect(yield* mark(other)).toBe(true)
      // Freshness stays: an edit after a clearing needs no new read.
      yield* ledger.assertFresh(sessionID, file, "notes.txt", { mtimeMs: 1, digest: "x" })
    }),
  )

  it.live("never stubs a directory listing", () =>
    Effect.gen(function* () {
      const { sessionID, registry } = yield* setup
      const location = yield* Location.Service
      const first = yield* executeTool(registry, readCall(sessionID, "a", location.directory))
      const second = yield* executeTool(registry, readCall(sessionID, "b", location.directory))
      expect(first).toMatchObject({ status: "completed" })
      expect(second).not.toHaveProperty("metadata.unchanged")
      expect(text(second)).toContain("notes.txt")
    }),
  )
})
