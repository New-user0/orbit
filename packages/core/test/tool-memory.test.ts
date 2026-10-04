import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Bus } from "@orbit/core/bus"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Location } from "@orbit/core/location"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { MemoryTool } from "@orbit/core/tool/plugin/memory"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const node = makeLocationNode({
  name: "test/memory-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(MemoryTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Global.node, Location.node, InstructionDiscovery.node],
})
const call = (input: unknown) => ({
  ...toolIdentity,
  sessionID: Session.ID.make("ses_memory_test"),
  call: { type: "tool-call" as const, id: "call-memory", name: "memory", input },
})
const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
  result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : ""

describe("memory tool", () => {
  it.live("saves memories, indexes them as instructions, and deletes them", () =>
    Effect.gen(function* () {
      const data = (yield* tmpdirScoped()).path
      yield* Effect.gen(function* () {
        const registry = yield* Tool.Service
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
          ]),
        ),
      )
    }),
  )
})
