import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { FSUtil } from "@orbit/util/fs-util"
import { Form } from "@orbit/core/form"
import { Location } from "@orbit/core/location"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { PlanModeTools } from "@orbit/core/tool/plugin/plan-mode"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_plan_mode_test")

const harness = (home: string, decisions: string[]) => {
  const switches: string[] = []
  const asked: Form.CreateInput[] = []
  const node = makeLocationNode({
    name: "test/plan-mode-tool-plugin",
    layer: Layer.effectDiscard(registerToolPlugin(PlanModeTools.Plugin)),
    deps: [Tool.node, Session.node, Form.node, FSUtil.node, Global.node],
  })
  const layer = AppNodeBuilder.build(LayerNode.group([Tool.node, node]), [
    Location.node.replace(tempLocationLayer),
    Global.node.replace(Global.layerWith({ home })),
    Session.node.replace(
      Layer.mock(Session.Service, {
        switchAgent: (input) => Effect.sync(() => void switches.push(input.agent)),
        revert: {
          stage: () => Effect.die("unused"),
          clear: () => Effect.die("unused"),
          commit: () => Effect.die("unused"),
        },
      }),
    ),
    Form.node.replace(
      Layer.mock(Form.Service, {
        ask: (input) =>
          Effect.sync(() => {
            asked.push(input)
            return { status: "answered" as const, answer: { decision: decisions.shift() ?? "" } }
          }),
      }),
    ),
  ])
  return { switches, asked, layer }
}

const call = (name: string, input: unknown, agent: string) => ({
  ...toolIdentity,
  agent: Agent.ID.make(agent),
  sessionID,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

describe("plan mode tools", () => {
  it.live("enters Plan mode, takes feedback, and returns to the previous agent once the plan is approved", () =>
    Effect.gen(function* () {
      const home = (yield* tmpdirScoped()).path
      const test = harness(home, ["Split step 2 in two", "Approve the plan and start"])
      yield* Effect.gen(function* () {
        const registry = yield* Tool.Service

        const outside = yield* executeTool(registry, call("exit_plan_mode", { plan: "# Plan" }, "general"))
        expect(outside.status).toBe("error")

        const entered = yield* executeTool(registry, call("enter_plan_mode", {}, "general"))
        expect(entered.status).toBe("completed")
        expect(test.switches).toEqual(["plan"])

        const revised = yield* executeTool(registry, call("exit_plan_mode", { plan: "# Plan\n1. a" }, "plan"))
        expect(revised.output).toEqual({ approved: false, feedback: "Split step 2 in two" })
        expect(test.switches).toEqual(["plan"])

        const approved = yield* executeTool(registry, call("exit_plan_mode", { plan: "# Plan\n1. a\n2. b" }, "plan"))
        expect(approved.output).toEqual({ approved: true })
        expect(test.switches).toEqual(["plan", "general"])
        expect(test.asked[1]?.fields[0]).toMatchObject({ description: "# Plan\n1. a\n2. b" })
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(home, ".orbit", "plan", `${sessionID}.md`), "utf8")),
        ).toBe("# Plan\n1. a\n2. b")
      }).pipe(Effect.provide(test.layer))
    }),
  )
})
