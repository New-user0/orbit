import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Permission } from "@orbit/core/permission"
import { PlanMode } from "@orbit/core/plan-mode"
import { AgentPlugin } from "@orbit/core/plugin/agent"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionStore } from "@orbit/core/session/store"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { agentHost, host } from "./plugin/host"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")
const custom = Agent.ID.make("custom")

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node, Session.node, Agent.node]), [
    Location.node.replace(tempLocationLayer),
    Global.node.replace(tempGlobalLayer),
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)

describe("PlanMode.previousAgent", () => {
  it.effect("is the agent the session last entered Plan mode from", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const created = yield* sessions.create({ location, agent: build })

      yield* sessions.switchAgent({ sessionID: created.id, agent: plan })
      expect(yield* PlanMode.previousAgent(store, created.id)).toBe(build)

      yield* sessions.switchAgent({ sessionID: created.id, agent: custom })
      yield* sessions.switchAgent({ sessionID: created.id, agent: plan })
      expect(yield* PlanMode.previousAgent(store, created.id)).toBe(custom)
      // The Session service reads the same history.
      expect(yield* PlanMode.previousAgent(sessions, created.id)).toBe(custom)
    }),
  )

  it.effect("skips selecting Plan again while already in it", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const created = yield* sessions.create({ location, agent: custom })

      yield* sessions.switchAgent({ sessionID: created.id, agent: plan })
      yield* sessions.switchAgent({ sessionID: created.id, agent: plan })

      expect(yield* sessions.messages({ sessionID: created.id, type: "agent-switched", order: "asc" })).toMatchObject([
        { agent: plan, previous: custom },
        { agent: plan, previous: plan },
      ])
      expect(yield* PlanMode.previousAgent(store, created.id)).toBe(custom)
    }),
  )

  it.effect("has no previous agent without a recorded entry into Plan mode", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service

      const started = yield* sessions.create({ location, agent: plan })
      expect(yield* PlanMode.previousAgent(store, started.id)).toBeUndefined()

      // Leaving Plan mode is not entering it.
      yield* sessions.switchAgent({ sessionID: started.id, agent: build })
      expect(yield* PlanMode.previousAgent(store, started.id)).toBeUndefined()

      // The session had no agent selected when it entered, so the history cannot name one.
      const unselected = yield* sessions.create({ location })
      yield* sessions.switchAgent({ sessionID: unselected.id, agent: plan })
      expect(yield* PlanMode.previousAgent(store, unselected.id)).toBeUndefined()
    }),
  )

  it.effect("only reads the session it is asked about", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const planning = yield* sessions.create({ location, agent: custom })
      const other = yield* sessions.create({ location, agent: build })

      yield* sessions.switchAgent({ sessionID: planning.id, agent: plan })

      expect(yield* PlanMode.previousAgent(store, planning.id)).toBe(custom)
      expect(yield* PlanMode.previousAgent(store, other.id)).toBeUndefined()
    }),
  )
})

describe("PlanMode.readOnlyAgents", () => {
  it.effect("are built-in subagents whose default permissions cannot edit files, run commands, or start agents", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))

      expect(PlanMode.readOnlyAgents.size).toBeGreaterThan(0)
      yield* Effect.forEach(PlanMode.readOnlyAgents, (id) =>
        Effect.gen(function* () {
          const info = yield* agents.get(Agent.ID.make(id))
          expect(info?.mode).toBe("subagent")
          expect(Permission.evaluate("edit", "src/index.ts", info?.permissions ?? []).effect).toBe("deny")
          expect(Permission.evaluate("shell", "touch notes.txt", info?.permissions ?? []).effect).toBe("deny")
          expect(Permission.evaluate("subagent", "general", info?.permissions ?? []).effect).toBe("deny")
        }),
      )
    }),
  )
})
