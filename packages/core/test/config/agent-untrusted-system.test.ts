import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { ConfigAgentPlugin } from "@orbit/core/config/plugin/agent"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { AgentPlugin } from "@orbit/core/plugin/agent"
import { trustedProject } from "../fixture/project-trust"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node, ManagedPolicy.node])),
    trustedProject,
  ),
)

const decodeInfo = Schema.decodeUnknownSync(Info)

const document = (input: unknown, scope: "user" | "project") => {
  const result = ConfigNormalize.normalize(input)
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return new Document({ type: "document", scope, info: decodeInfo(result.encoded) })
}

const untrusted = (input: unknown) =>
  ConfigTrust.stamp(document(input, "project"), { roots: ["/nowhere"], directory: "/nowhere" })

const run = (entries: Entry[]) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provide(Config.testLayer(entries)),
    )
    return agents
  })

// Class 8: an agent's own `system` makes the session skip the person's `system_prompt`, so an untrusted document that
// sets it on an agent that exists would put the repository's text in `system[0]`.
// Mutation: drop the `document.trusted === false && exists` guard on `item.system` and every untrusted row but the
// new-agent row fails.
describe("agents.<id>.system from a folder that is not trusted", () => {
  const user = () => document({ agents: { build: { system: "USER BUILD" }, mine: { system: "USER MINE" } } }, "user")
  const rows = [
    ["an agent of the person's own", "mine", "USER MINE"],
    ["an agent the person tuned", "build", "USER BUILD"],
    ["an agent Orbit ships", "general", undefined],
  ] as const

  for (const [name, id, expected] of rows) {
    it.live(`keeps the earlier prompt of ${name}`, () =>
      Effect.gen(function* () {
        const before = yield* (yield* run([user()])).get(Agent.ID.make(id))
        const agents = yield* run([user(), untrusted({ agents: { [id]: { system: "REPO TEXT" } } })])
        const agent = yield* agents.get(Agent.ID.make(id))
        expect(agent?.system).toBe(before?.system)
        if (expected !== undefined) expect(agent?.system).toBe(expected)
      }),
    )
  }

  it.live("control: a trusted project's value applies", () =>
    Effect.gen(function* () {
      const agents = yield* run([user(), document({ agents: { build: { system: "REPO TEXT" } } }, "project")])
      expect((yield* agents.get(Agent.ID.make("build")))?.system).toBe("REPO TEXT")
    }),
  )

  it.live("an agent that is new keeps its own prompt", () =>
    Effect.gen(function* () {
      const agents = yield* run([user(), untrusted({ agents: { fresh: { system: "REPO NEW" } } })])
      expect((yield* agents.get(Agent.ID.make("fresh")))?.system).toBe("REPO NEW")
    }),
  )
})
