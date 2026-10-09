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
import { Database } from "@orbit/core/database/database"
import { Form } from "@orbit/core/form"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Permission } from "@orbit/core/permission"
import { PlanMode } from "@orbit/core/plan-mode"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { PlanModeTools } from "@orbit/core/tool/plugin/plan-mode"
import { promptLocationNode } from "./fixture/prompt-location"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { allowAllPermission } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, expectRegistryAsks, registerToolPlugin, toolIdentity, toolTraits } from "./lib/tool"

const sessionID = Session.ID.make("ses_plan_mode_test")
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")
const general = Agent.ID.make("general")
const custom = Agent.ID.make("custom")
const APPROVE = "Approve the plan and start"

/**
 * One server process: the real Session, SessionStore and Agent over a database file, plus the Plan mode tools.
 * Building another one over the same file after this one finishes is a restart, so only what reached disk carries
 * over: the session history does, the agents registered in memory do not.
 */
const server = (input: { home: string; database: string; decisions: string[] }) => {
  const asked: Form.CreateInput[] = []
  const node = makeLocationNode({
    name: "test/plan-mode-tool-plugin",
    layer: Layer.effectDiscard(registerToolPlugin(PlanModeTools.Plugin)),
    deps: [Tool.node, Session.node, Form.node, FSUtil.node, Global.node, Agent.node],
  })
  const layer = AppNodeBuilder.build(LayerNode.group([Tool.node, SessionStore.node, Session.node, Agent.node, node]), [
    Location.node.replace(tempLocationLayer),
    Global.node.replace(Global.layerWith({ home: input.home })),
    Database.node.replace(Database.configured({ path: input.database })),
    // Plan mode needs the durable history of a virtual project, not model execution.
    Project.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Permission.node.replace(allowAllPermission),
    Form.node.replace(
      Layer.mock(Form.Service, {
        ask: (form) =>
          Effect.sync(() => {
            asked.push(form)
            return { status: "answered" as const, answer: { decision: input.decisions.shift() ?? "" } }
          }),
      }),
    ),
  ])
  return { asked, layer }
}

/** Runs a Plan mode tool the way the runner does: as the agent the session resolves to, the default when it has none. */
const callTool = Effect.fn("callTool")(function* (name: string, input: unknown) {
  const sessions = yield* Session.Service
  const agents = yield* Agent.Service
  const registry = yield* Tool.Service
  const session = yield* sessions.get(sessionID)
  return yield* executeTool(registry, {
    ...toolIdentity,
    agent: (yield* agents.select(session.agent)).id,
    sessionID,
    call: { type: "tool-call" as const, id: `call-${name}`, name, input },
  })
})

/** What `default_agent` in config does: the agent a session with no agent selected runs as. */
const configureDefault = Effect.fn("configureDefault")(function* (id: Agent.ID) {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(id, () => {})
    editor.default(id)
  })
})

const disk = Effect.fn("disk")(function* () {
  const tmp = yield* tmpdirScoped()
  return { home: path.join(tmp.path, "home"), database: path.join(tmp.path, "orbit.sqlite") }
})

describe("plan mode tools", () => {
  it.live("declares that both tools wait for the person and are not read-only", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      yield* Effect.gen(function* () {
        const registry = yield* Tool.Service
        yield* expectRegistryAsks(registry, ["EnterPlanMode", "ExitPlanMode"])
        for (const name of ["EnterPlanMode", "ExitPlanMode"])
          expect(yield* toolTraits(registry, name)).toMatchObject({ readOnly: false, requiresUserInteraction: true })
      }).pipe(Effect.provide(server({ ...paths, decisions: [] }).layer))
    }),
  )

  it.live("enters Plan mode, takes feedback, and returns to the previous agent once the plan is approved", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      const test = server({ ...paths, decisions: ["Split step 2 in two", APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* sessions.create({ id: sessionID, location, agent: general })

        const outside = yield* callTool("ExitPlanMode", { plan: "# Plan" })
        expect(outside.status).toBe("error")

        const entered = yield* callTool("EnterPlanMode", {})
        expect(entered.status).toBe("completed")
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: plan })

        const revised = yield* callTool("ExitPlanMode", { plan: "# Plan\n1. a" })
        expect(revised.output).toEqual({ approved: false, feedback: "Split step 2 in two" })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: plan })

        const approved = yield* callTool("ExitPlanMode", { plan: "# Plan\n1. a\n2. b" })
        expect(approved.output).toEqual({ approved: true })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: general })
        expect(test.asked[1]?.fields[0]).toMatchObject({ description: "# Plan\n1. a\n2. b" })
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(paths.home, ".orbit", "plan", `${sessionID}.md`), "utf8")),
        ).toBe("# Plan\n1. a\n2. b")
      }).pipe(Effect.provide(test.layer))
    }),
  )

  it.live("returns to the agent the session planned from after the server restarts", () =>
    Effect.gen(function* () {
      const paths = yield* disk()

      const first = server({ ...paths, decisions: [] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* sessions.create({ id: sessionID, location, agent: custom })
        expect((yield* callTool("EnterPlanMode", {})).status).toBe("completed")
      }).pipe(Effect.provide(first.layer))

      // A new process: a new plugin instance with no memory of the first one.
      const second = server({ ...paths, decisions: [APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: plan })
        expect(yield* sessions.messages({ sessionID, type: "agent-switched" })).toMatchObject([
          { agent: plan, previous: custom },
        ])

        const approved = yield* callTool("ExitPlanMode", { plan: "# Plan" })
        expect(approved.output).toEqual({ approved: true })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: custom })
      }).pipe(Effect.provide(second.layer))
    }),
  )

  it.live("returns to whichever agent each planning round started from", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      const test = server({ ...paths, decisions: [APPROVE, APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* sessions.create({ id: sessionID, location, agent: build })

        yield* callTool("EnterPlanMode", {})
        yield* callTool("ExitPlanMode", { plan: "# First" })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: build })

        yield* sessions.switchAgent({ sessionID, agent: custom })
        yield* callTool("EnterPlanMode", {})
        yield* callTool("ExitPlanMode", { plan: "# Second" })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: custom })
      }).pipe(Effect.provide(test.layer))
    }),
  )

  it.live("returns to the default agent when a session in Plan mode has no entry in its history", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      const test = server({ ...paths, decisions: [APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        // Started in Plan mode, so no agent switch was ever recorded. No default is configured, so it is build.
        yield* sessions.create({ id: sessionID, location, agent: plan })
        expect(yield* sessions.messages({ sessionID, type: "agent-switched" })).toEqual([])

        const approved = yield* callTool("ExitPlanMode", { plan: "# Plan" })
        expect(approved.output).toEqual({ approved: true })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: build })
      }).pipe(Effect.provide(test.layer))
    }),
  )

  it.live("returns to the configured default agent when a session started in Plan mode", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      const test = server({ ...paths, decisions: [APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* configureDefault(custom)
        yield* sessions.create({ id: sessionID, location, agent: plan })
        expect(yield* sessions.messages({ sessionID, type: "agent-switched" })).toEqual([])

        const approved = yield* callTool("ExitPlanMode", { plan: "# Plan" })
        expect(approved.output).toEqual({ approved: true })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: custom })
      }).pipe(Effect.provide(test.layer))
    }),
  )

  it.live("returns to the configured default agent when the session had no agent selected", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      const test = server({ ...paths, decisions: [APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* configureDefault(custom)
        // No agent selected: the runner runs this session as the configured default, so the tool is called as it.
        yield* sessions.create({ id: sessionID, location })
        expect((yield* callTool("EnterPlanMode", {})).status).toBe("completed")
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: plan })
        // The history cannot say where the session came from, because the session row had no agent to record.
        expect(yield* PlanMode.previousAgent(sessions, sessionID)).toBeUndefined()

        const approved = yield* callTool("ExitPlanMode", { plan: "# Plan" })
        expect(approved.output).toEqual({ approved: true })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: custom })
      }).pipe(Effect.provide(test.layer))
    }),
  )

  it.live("leaves Plan mode for build when Plan mode is itself the configured default agent", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      const test = server({ ...paths, decisions: [APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* configureDefault(plan)
        // No agent selected, so the runner starts this session in Plan mode.
        yield* sessions.create({ id: sessionID, location })

        const approved = yield* callTool("ExitPlanMode", { plan: "# Plan" })
        expect(approved.output).toEqual({ approved: true })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: build })
      }).pipe(Effect.provide(test.layer))
    }),
  )

  it.live("prefers the agent the session planned from over the configured default agent", () =>
    Effect.gen(function* () {
      const paths = yield* disk()
      const test = server({ ...paths, decisions: [APPROVE] })
      yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        yield* configureDefault(custom)
        yield* sessions.create({ id: sessionID, location, agent: general })
        yield* callTool("EnterPlanMode", {})

        const approved = yield* callTool("ExitPlanMode", { plan: "# Plan" })
        expect(approved.output).toEqual({ approved: true })
        expect(yield* sessions.get(sessionID)).toMatchObject({ agent: general })
      }).pipe(Effect.provide(test.layer))
    }),
  )
})
