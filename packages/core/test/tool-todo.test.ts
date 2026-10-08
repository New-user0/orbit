import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Tool } from "@orbit/core/tool"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { TodoTool } from "../src/tool/plugin/todo"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { expectRegistryAsks, registerToolPlugin, toolTraits } from "./lib/tool"

const node = makeLocationNode({
  name: "test/todo-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(TodoTool.Plugin)),
  deps: [Tool.node],
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, node]), [Location.node.replace(tempLocationLayer)]),
)

describe("todo tool", () => {
  test("accepts a plan and summarizes progress for the model", () => {
    const input = Schema.decodeUnknownSync(TodoTool.Input)({
      todos: [
        { content: "Find the caller", status: "completed" },
        { content: "Add a retry helper", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    })
    expect(TodoTool.toModelContent(input.todos)).toBe("Plan updated: 1 of 3 done.")
  })

  test("rejects an unknown status", () => {
    expect(() =>
      Schema.decodeUnknownSync(TodoTool.Input)({ todos: [{ content: "Ship it", status: "blocked" }] }),
    ).toThrow()
  })

  it.effect("leaves its calls to the registry gate", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* expectRegistryAsks(registry, ["todo"])
    }),
  )

  it.effect("changes the session's plan, so it is neither read-only nor safe beside other calls", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      expect(yield* toolTraits(registry, "todo", { todos: [] })).toMatchObject({
        readOnly: false,
        concurrencySafe: false,
      })
    }),
  )
})
