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
import { FileMutation } from "@orbit/core/file-mutation"
import { Formatter } from "@orbit/core/formatter"
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
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { NotebookEditTool } from "@orbit/core/tool/plugin/notebook-edit"
import { PatchTool } from "@orbit/core/tool/plugin/patch"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { transformEnvironmentFiles } from "./fixture/environment"
import { canLinkFile } from "./fixture/symlink"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin } from "./lib/tool"

/**
 * The real Read, Edit, Write, Patch and NotebookEdit over one real FileLedger, Bus and file system. Only the permission
 * prompt (denied on request), the formatter (off) and a counter on whole-file reads are replaced.
 */
const deps = [
  Config.node,
  Environment.node,
  FileLedger.node,
  FileMutation.node,
  Formatter.node,
  Tool.node,
  ReadToolFileSystem.node,
  FileAccess.node,
  Image.node,
  Permission.node,
  SessionInstructions.node,
  FSUtil.node,
  Location.node,
]
const pluginNode = (
  name: string,
  plugin: Parameters<typeof registerToolPlugin>[0],
  overrides: Parameters<typeof registerToolPlugin>[1] = {},
) => makeLocationNode({ name, layer: Layer.effectDiscard(registerToolPlugin(plugin, overrides)), deps })

const state = { denied: new Set<string>(), wholeReads: [] as string[] }

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
      pluginNode("test/matrix-read", ReadTool.Plugin),
      pluginNode("test/matrix-edit", EditTool.Plugin),
      pluginNode("test/matrix-write", WriteTool.Plugin),
      pluginNode("test/matrix-notebook", NotebookEditTool.Plugin),
      pluginNode("test/matrix-patch", PatchTool.Plugin),
      FileLedger.node,
      FileMutation.node,
      Tool.node,
      PluginHooks.node,
      ProjectTrust.node,
      SessionInstructions.node,
      Global.node,
      Image.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Location.node.replace(tempLocationLayer),
      Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
      Environment.node.replace(
        transformEnvironmentFiles((files) => ({
          read: (target, range) =>
            files.read(target, range).pipe(
              // Only a read with no range loads the whole file; the ledger's stat-like read asks for no bytes.
              Effect.tap(() =>
                Effect.sync(() => {
                  if (range === undefined) state.wholeReads.push(target)
                }),
              ),
            ),
        })),
      ),
      Permission.node.replace(
        permissionLayer({
          assert: (input) =>
            state.denied.has(input.action)
              ? Effect.fail(
                  new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
                )
              : Effect.void,
        }),
      ),
      Config.node.replace(config),
      Image.node.replace(AppNodeBuilder.build(Image.node, [Config.node.replace(config)])),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: true })),
    ],
  ),
)

const call = (sessionID: Session.ID, id: string, name: string, input: unknown) => ({
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_matrix"),
  call: { type: "tool-call" as const, id, name, input },
})
const unchanged = (result: unknown) => (result as { metadata?: { unchanged?: boolean } }).metadata?.unchanged === true
const errorType = (result: unknown) => (result as { error?: { type?: string } }).error?.type

const notebook = (source: string) =>
  JSON.stringify(
    {
      cells: [{ cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: [source] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  ) + "\n"
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

// Each mutating tool, a file it can change, the call that changes it, and the call that changes it back.
const tools = [
  {
    name: "Edit",
    file: "notes.txt",
    initial: "one\ntwo\nthree\n",
    changed: "one\nTWO\nthree\n",
    run: (file: string) => ({ file_path: file, old_string: "two", new_string: "TWO" }),
    back: (file: string) => ({ file_path: file, old_string: "TWO", new_string: "two" }),
    external: "one\nzzz\nthree\n",
  },
  {
    name: "Write",
    file: "notes.txt",
    initial: "one\ntwo\nthree\n",
    changed: "one\nTWO\nthree\n",
    run: (file: string) => ({ file_path: file, content: "one\nTWO\nthree\n" }),
    back: (file: string) => ({ file_path: file, content: "one\ntwo\nthree\n" }),
    external: "one\nzzz\nthree\n",
  },
  {
    name: "Patch",
    file: "notes.txt",
    initial: "one\ntwo\nthree\n",
    changed: "one\nTWO\nthree\n",
    run: (file: string) => ({ patchText: `*** Begin Patch\n*** Update File: ${file}\n@@\n-two\n+TWO\n*** End Patch` }),
    back: (file: string) => ({ patchText: `*** Begin Patch\n*** Update File: ${file}\n@@\n-TWO\n+two\n*** End Patch` }),
    external: "one\nzzz\nthree\n",
  },
  {
    name: "NotebookEdit",
    file: "nb.ipynb",
    initial: notebook("a"),
    changed: notebook("b"),
    run: (file: string) => ({ notebook_path: file, mode: "replace", cellId: "calc", source: "b" }),
    back: (file: string) => ({ notebook_path: file, mode: "replace", cellId: "calc", source: "a" }),
    external: notebook("zzz"),
  },
] as const

const setup = (tool: (typeof tools)[number] = tools[0]) =>
  Effect.gen(function* () {
    state.denied.clear()
    state.wholeReads.length = 0
    const location = yield* Location.Service
    const file = path.join(location.directory, tool.file)
    yield* Effect.promise(() => fs.writeFile(file, tool.initial))
    const session = yield* Session.Service
    const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
    const registry = yield* Tool.Service
    const run = (id: string, name: string, input: unknown) => executeTool(registry, call(sessionID, id, name, input))
    const later = (seconds = 5_000) =>
      Effect.promise(() =>
        fs.utimes(file, new Date(Date.now() + seconds * 1000), new Date(Date.now() + seconds * 1000)),
      )
    return { file, name: tool.file, sessionID, registry, bus: yield* Bus.Service, run, later, location }
  })

describe("Read repeat stubs and the freshness of the edit tools", () => {
  describe.each(tools)("$name", (tool) => {
    it.live("passes a file that was only touched after a whole read", () =>
      Effect.gen(function* () {
        const { name, file, run, later } = yield* setup(tool)
        yield* run("r", "Read", { file_path: name })
        yield* later()
        expect(yield* run("t", tool.name, tool.run(name))).toMatchObject({ status: "completed" })
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(tool.changed)
        // The tool recorded its final text, so a second touch and a second change still pass.
        yield* later(9_000)
        expect(yield* run("t2", tool.name, tool.back(name))).toMatchObject({ status: "completed" })
      }),
    )

    it.live("refuses a real external change after the read, and writes nothing", () =>
      Effect.gen(function* () {
        const { name, file, run, later } = yield* setup(tool)
        yield* run("r", "Read", { file_path: name })
        // Different bytes, so only a different file can explain the newer time.
        const external = tool.external
        yield* Effect.promise(() => fs.writeFile(file, external))
        yield* later()
        expect(errorType(yield* run("t", tool.name, tool.run(name)))).toBe("file.stale")
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(external)
      }),
    )

    it.live("refuses an unread file before it loads any of the file", () =>
      Effect.gen(function* () {
        const { name, run } = yield* setup(tool)
        expect(errorType(yield* run("t", tool.name, tool.run(name)))).toBe("file.unread")
        expect(state.wholeReads).toEqual([])
      }),
    )

    it.live("answers the next read in full after its own change, and stubs the one after", () =>
      Effect.gen(function* () {
        const { name, run } = yield* setup(tool)
        yield* run("r1", "Read", { file_path: name })
        expect(unchanged(yield* run("r2", "Read", { file_path: name }))).toBe(true)
        // Change the file and change it back: the text is the one the model was shown, so only forgetting the mark makes the next read full.
        expect(yield* run("t", tool.name, tool.run(name))).toMatchObject({ status: "completed" })
        expect(yield* run("t2", tool.name, tool.back(name))).toMatchObject({ status: "completed" })
        expect(unchanged(yield* run("r3", "Read", { file_path: name }))).toBe(false)
        expect(unchanged(yield* run("r4", "Read", { file_path: name }))).toBe(true)
      }),
    )

    it.live("needs a new read after the session was compacted, and not after a failed compaction", () =>
      Effect.gen(function* () {
        const { name, sessionID, run, bus } = yield* setup(tool)
        yield* run("r", "Read", { file_path: name })
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: "manual",
          error: { type: "compaction.failed", message: "failed" },
        })
        expect(unchanged(yield* run("r2", "Read", { file_path: name }))).toBe(true)

        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
        yield* bus.publish(SessionEvent.Compaction.Ended, { sessionID, reason: "manual", text: "summary", recent: "" })
        expect(errorType(yield* run("t", tool.name, tool.run(name)))).toBe("file.unread")
        // Reading it again makes it changeable again.
        yield* run("r3", "Read", { file_path: name })
        expect(yield* run("t2", tool.name, tool.run(name))).toMatchObject({ status: "completed" })
      }),
    )
  })

  it.live(
    "answers an identical repeat read with the stub for text and a notebook, and stays out of its way for a different range",
    () =>
      Effect.gen(function* () {
        const nb = tools[3]
        const { name, run } = yield* setup(nb)
        yield* run("r1", "Read", { file_path: name })
        expect(unchanged(yield* run("r2", "Read", { file_path: name }))).toBe(true)
        expect(unchanged(yield* run("r3", "Read", { file_path: name }))).toBe(true)
      }),
  )

  it.live("never skips the permission check with a stub", () =>
    Effect.gen(function* () {
      const { name, run } = yield* setup()
      yield* run("r1", "Read", { file_path: name })
      expect(unchanged(yield* run("r2", "Read", { file_path: name }))).toBe(true)
      state.denied.add("Read")
      const denied = yield* run("r3", "Read", { file_path: name })
      expect(denied.status).toBe("error")
      expect(unchanged(denied)).toBe(false)
    }),
  )

  it.live("never stubs an image or a PDF", () =>
    Effect.gen(function* () {
      const { location, run } = yield* setup()
      yield* Effect.promise(() => fs.writeFile(path.join(location.directory, "pixel.png"), png))
      yield* Effect.promise(() => fs.writeFile(path.join(location.directory, "doc.pdf"), "%PDF-1.4\n%%EOF\n"))
      for (const file of ["pixel.png", "doc.pdf"]) {
        const first = yield* run(`a-${file}`, "Read", { file_path: file })
        const second = yield* run(`b-${file}`, "Read", { file_path: file })
        expect(first.status).toBe("completed")
        expect(second.status).toBe("completed")
        expect(unchanged(first)).toBe(false)
        expect(unchanged(second)).toBe(false)
        expect(second.content).toEqual(first.content)
      }
    }),
  )

  it.live("keeps one slot per file: A, B, A is full for the third; omitted and explicit ranges follow their keys", () =>
    Effect.gen(function* () {
      const { name, run } = yield* setup()
      const read = (id: string, page: object = {}) => run(id, "Read", { file_path: name, ...page })
      yield* read("a1")
      yield* read("b1", { offset: 2 })
      expect(unchanged(yield* read("a2"))).toBe(false)
      expect(unchanged(yield* read("a3"))).toBe(true)
      // An omitted offset is offset 1; an omitted limit is not the limit 2000.
      expect(unchanged(yield* read("c1", { offset: 1 }))).toBe(true)
      expect(unchanged(yield* read("c2", { limit: 2000 }))).toBe(false)
      expect(unchanged(yield* read("c3", { limit: 2000 }))).toBe(true)
      expect(unchanged(yield* read("c4"))).toBe(false)
    }),
  )

  it.live("answers a content change in full even when the time is restored, and a touch with the stub", () =>
    Effect.gen(function* () {
      const { name, file, run } = yield* setup()
      const before = yield* Effect.promise(() => fs.stat(file))
      yield* run("a", "Read", { file_path: name })
      yield* Effect.promise(() => fs.writeFile(file, "one\nTWO\nthree\n"))
      yield* Effect.promise(() => fs.utimes(file, before.atime, before.mtime))
      expect(unchanged(yield* run("b", "Read", { file_path: name }))).toBe(false)
      yield* Effect.promise(() => fs.utimes(file, new Date(Date.now() + 9_000_000), new Date(Date.now() + 9_000_000)))
      expect(unchanged(yield* run("c", "Read", { file_path: name }))).toBe(true)
    }),
  )

  it.live("answers a directory listing and an out-of-range offset in full or with an error, every time", () =>
    Effect.gen(function* () {
      const { name, run, location } = yield* setup()
      for (const id of ["a", "b"]) {
        expect(unchanged(yield* run(`d-${id}`, "Read", { file_path: location.directory }))).toBe(false)
        expect((yield* run(`o-${id}`, "Read", { file_path: name, offset: 99 })).status).toBe("error")
      }
    }),
  )

  // Read through a link records the target's time; the patch tool checks the link path with no snapshot of its own.
  const linked = canLinkFile ? it.live : it.live.skip
  linked("patches through a link: a newer link is no change, an unseen change to the target is", () =>
    Effect.gen(function* () {
      const { file, location, run } = yield* setup()
      const link = path.join(location.directory, "link.txt")
      yield* Effect.promise(() => fs.symlink(file, link))
      const patch = (from: string, to: string) => ({
        patchText: `*** Begin Patch\n*** Update File: link.txt\n@@\n-${from}\n+${to}\n*** End Patch`,
      })
      const stamp = (seconds: number, own: boolean) =>
        Effect.promise(() =>
          (own ? fs.lutimes : fs.utimes)(own ? link : file, new Date(seconds * 1000), new Date(seconds * 1000)),
        )

      yield* stamp(1_000, false)
      yield* run("r", "Read", { file_path: "link.txt" })
      yield* stamp(Date.now() / 1000 + 5_000, true)
      expect(yield* run("p1", "Patch", patch("two", "TWO"))).toMatchObject({ status: "completed" })

      yield* run("r2", "Read", { file_path: "link.txt" })
      yield* stamp(100, true)
      yield* Effect.promise(() => fs.writeFile(file, "one\nexternal\nthree\n"))
      yield* stamp(Date.now() / 1000 + 9_000, false)
      expect(errorType(yield* run("p2", "Patch", patch("external", "x")))).toBe("file.stale")
    }),
  )

  it.live("forgets the marks for a committed revert and for forgetReads, and keeps the other session apart", () =>
    Effect.gen(function* () {
      const { name, sessionID, run, bus, location } = yield* setup()
      const ledger = yield* FileLedger.Service
      yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: "boundary", description: "boundary" })
      const boundary = (yield* (yield* SessionStore.Service).context(sessionID)).filter(
        (message) => message.type === "synthetic",
      )[0]!.id

      yield* run("a", "Read", { file_path: name })
      expect(unchanged(yield* run("b", "Read", { file_path: name }))).toBe(true)
      yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID, revert: { messageID: boundary, files: [] } })
      yield* bus.publish(SessionEvent.RevertEvent.Committed, { sessionID, to: boundary })
      expect(unchanged(yield* run("c", "Read", { file_path: name }))).toBe(false)

      expect(unchanged(yield* run("d", "Read", { file_path: name }))).toBe(true)
      yield* ledger.forgetReads(sessionID)
      expect(unchanged(yield* run("e", "Read", { file_path: name }))).toBe(false)

      const session = yield* Session.Service
      const other = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      expect(unchanged(yield* executeTool(yield* Tool.Service, call(other, "f", "Read", { file_path: name })))).toBe(
        false,
      )
    }),
  )
})
