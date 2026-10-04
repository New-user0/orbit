import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { KV } from "@orbit/core/kv"
import { Location } from "@orbit/core/location"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { TaskTools } from "@orbit/core/tool/plugin/tasks"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const node = makeLocationNode({
  name: "test/task-tools-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(TaskTools.Plugin)),
  deps: [Tool.node, KV.node],
})
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, node]), [Location.node.replace(tempLocationLayer)]),
)
const sessionID = Session.ID.make("ses_tasks_test")
const call = (name: string, input: unknown, session = sessionID) => ({
  ...toolIdentity,
  sessionID: session,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})
const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
  result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : ""

describe("task tools", () => {
  it.effect("create tasks with dependencies, update and delete them, and keep sessions apart", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* executeTool(registry, call("task_create", { subject: "Add the schema" }))
      const second = yield* executeTool(registry, call("task_create", { subject: "Wire the API", blockedBy: ["1"] }))
      expect(text(second)).toContain("#2 [pending] Wire the API (blocked by #1)")
      expect(second.metadata).toEqual({
        todos: [
          { content: "Add the schema", status: "pending" },
          { content: "Wire the API", status: "pending" },
        ],
      })

      expect((yield* executeTool(registry, call("task_create", { subject: "x", blockedBy: ["9"] }))).status).toBe(
        "error",
      )

      const early = yield* executeTool(registry, call("task_update", { id: "2", status: "in_progress" }))
      expect(text(early)).toContain("still blocked by #1")
      yield* executeTool(registry, call("task_update", { id: "1", status: "completed" }))
      const listed = yield* executeTool(registry, call("task_list", {}))
      expect(text(listed)).toContain("#1 [completed] Add the schema\n#2 [in_progress] Wire the API")

      const deleted = yield* executeTool(registry, call("task_update", { id: "1", status: "deleted" }))
      expect(text(deleted)).toContain("#2 [in_progress] Wire the API")
      expect(text(deleted)).not.toContain("blocked by #1")

      expect(text(yield* executeTool(registry, call("task_list", {}, Session.ID.make("ses_other"))))).toContain(
        "No tasks yet.",
      )
    }),
  )
})
