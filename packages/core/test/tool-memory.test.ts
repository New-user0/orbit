import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Bus } from "@orbit/core/bus"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { MemoryTool } from "@orbit/core/tool/plugin/memory"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { readUpdate, state } from "./lib/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { allowAllPermission } from "./lib/permission"
import { executeTool, expectRegistryAsks, registerToolPlugin, toolIdentity, toolTraits } from "./lib/tool"

const node = makeLocationNode({
  name: "test/memory-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(MemoryTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Global.node, Location.node, InstructionDiscovery.node],
})
const call = (input: unknown) => ({
  ...toolIdentity,
  sessionID: Session.ID.make("ses_memory_test"),
  call: { type: "tool-call" as const, id: "call-memory", name: "Memory", input },
})
const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
  result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : ""

// Mirrors the activation order: the instruction files are added first, the memory plugin after them.
const afterFilesNode = makeLocationNode({
  name: "test/memory-tool-after-files",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(new InstructionDiscovery.File({ path: AbsolutePath.make("/repo/ORBIT.md"), content: "project rules" }))
      })
      yield* registerToolPlugin(MemoryTool.Plugin)
    }),
  ),
  deps: [Tool.node, FSUtil.node, Global.node, Location.node, InstructionDiscovery.node],
})

describe("memory tool", () => {
  it.live("renders the memory index after the project files, and the first save tells no change of order", () =>
    Effect.gen(function* () {
      const data = (yield* tmpdirScoped()).path
      yield* Effect.gen(function* () {
        const registry = yield* Tool.Service
        const discovery = yield* InstructionDiscovery.Service
        const before = state({ "core/instructions": [{ path: "/repo/ORBIT.md", content: "project rules" }] })
        yield* executeTool(registry, call({ action: "save", name: "notes", content: "# A note" }))
        const files = yield* discovery.list()
        expect(Array.isArray(files) && files.map((item) => path.basename(item.path))).toEqual(["ORBIT.md", "MEMORY.md"])
        const update = (yield* readUpdate(yield* discovery.load(), before)).text
        expect(update).toContain("MEMORY.md")
        expect(update).not.toContain("order of the instruction files changed")
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Tool.node, afterFilesNode, Bus.node, InstructionDiscovery.node]), [
            Location.node.replace(tempLocationLayer),
            Global.node.replace(Global.layerWith({ data })),
            Permission.node.replace(allowAllPermission),
          ]),
        ),
      )
    }),
  )


  it.live("saves memories, indexes them as instructions, and deletes them", () =>
    Effect.gen(function* () {
      const data = (yield* tmpdirScoped()).path
      yield* Effect.gen(function* () {
        const registry = yield* Tool.Service
        yield* expectRegistryAsks(registry, ["Memory"])
        for (const action of ["read", "list"])
          expect(yield* toolTraits(registry, "Memory", { action, name: "notes" })).toMatchObject({
            readOnly: true,
            concurrencySafe: true,
            destructive: false,
          })
        expect(yield* toolTraits(registry, "Memory", { action: "delete", name: "notes" })).toMatchObject({
          readOnly: false,
          concurrencySafe: false,
          destructive: true,
        })
        expect(yield* toolTraits(registry, "Memory", { action: "save", name: "notes", content: "x" })).toMatchObject({
          readOnly: false,
          concurrencySafe: false,
          destructive: false,
        })
        const discovery = yield* InstructionDiscovery.Service
        expect(text(yield* executeTool(registry, call({ action: "list" })))).toContain("No memories")

        yield* executeTool(
          registry,
          call({
            action: "save",
            name: "test-commands",
            content: "# Run tests with bun test from packages/core\nNot root.",
          }),
        )
        const index = text(yield* executeTool(registry, call({ action: "list" })))
        expect(index).toContain("- [test-commands](test-commands.md): Run tests with bun test from packages/core")
        expect(text(yield* executeTool(registry, call({ action: "read", name: "test-commands" })))).toContain(
          "Not root.",
        )
        const files = yield* discovery.list()
        expect(Array.isArray(files) && files.some((file) => file.content.includes("test-commands"))).toBe(true)

        yield* executeTool(registry, call({ action: "delete", name: "test-commands" }))
        expect(text(yield* executeTool(registry, call({ action: "list" })))).toContain("No memories")
        expect((yield* executeTool(registry, call({ action: "save", name: "Bad Name", content: "x" }))).status).toBe(
          "error",
        )
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Tool.node, node, Bus.node, InstructionDiscovery.node]), [
            Location.node.replace(tempLocationLayer),
            Global.node.replace(Global.layerWith({ data })),
            Permission.node.replace(allowAllPermission),
          ]),
        ),
      )
    }),
  )
})
