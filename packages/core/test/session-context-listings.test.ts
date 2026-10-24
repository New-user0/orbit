// The agent and skill listings among the sources of a session's baseline, on the real session context: which tools turn
// them on, which model's context window budgets the skill listing, and where the agent source sits.
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Agent } from "@orbit/core/agent"
import { AgentInstructions } from "@orbit/core/agent/instructions"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { Model } from "@orbit/core/model"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { SkillTool } from "@orbit/core/tool/plugin/skill"
import { SubagentTool } from "@orbit/core/tool/plugin/subagent"
import { WorkflowTool } from "@orbit/core/tool/plugin/workflow"
import { Project } from "@orbit/core/project"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Effect, Layer, Schema } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { noMemory } from "./lib/memory"
import { noScratchpad } from "./lib/scratchpad"
import { insertSession } from "./lib/session-row"
import { stubSnapshot } from "./lib/tool"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"

const id = SessionSchema.ID.make("ses_listings")
const seen = {
  tools: [] as string[],
  skills: [] as Array<{ contextWindow: number; enabled: boolean }>,
  agents: [] as Array<{ enabled: boolean }>,
  defaultWindow: undefined as number | undefined,
}

const window = (context: number | undefined) => (context === undefined ? undefined : { limit: { context } })

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      SessionContext.node,
      Location.node,
      Global.node,
    ]),
    [
      Global.node.replace(tempGlobalLayer),
      Location.node.replace(tempLocationLayer),
      Config.node.replace(Config.testLayer()),
      Model.node.replace(
        Layer.mock(Model.Service, {
          // Only the model named "known" has a window; the default model's window is set by each test.
          get: (_provider, model) => Effect.succeed(model === "known" ? (window(100_000) as never) : undefined),
          default: () => Effect.succeed(window(seen.defaultWindow) as never),
          available: () => Effect.succeed([]),
        }),
      ),
      SessionRunnerModel.node.replace(
        Layer.mock(SessionRunnerModel.Service)({
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "primary", provider: "test", route: OpenAIChat.route }),
                { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 1, output: 1 } },
              ),
            ),
        }),
      ),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, {
          project: false,
          global: false,
          load: () => Effect.succeed(Instructions.empty),
        }),
      ),
      SkillInstructions.node.replace(
        Layer.mock(SkillInstructions.Service, {
          load: (_permissions, options) => {
            seen.skills.push(options)
            // An empty source that keeps the real key, so the baseline order can be read.
            return Effect.succeed(
              Instructions.make<string>({
                key: Instructions.Key.make("core/skill-guidance"),
                codec: Schema.toCodecJson(Schema.String),
                read: Effect.succeed(Instructions.removed),
                render: { initial: () => "", changed: () => "", removed: () => "" },
              }),
            )
          },
        }),
      ),
      ReferenceInstructions.node.replace(
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })),
      PluginSupervisor.node.replace(Layer.empty),
      noScratchpad,
      noMemory,
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: () =>
            Effect.succeed(
              stubSnapshot({
                definitions: seen.tools.map((name) => ({ name })) as never,
                execute: () => Effect.die(new Error("unused")),
              }),
            ),
        }),
      ),
    ],
  ),
)

const setup = (model?: { providerID: string; id: string }, agent = "build", sid = id) =>
  Effect.gen(function* () {
    const here = yield* Location.Service
    const { db } = yield* Database.Service
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("helper"), (agent) => {
        agent.mode = "subagent"
        agent.description = "Helps"
      })
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      })
      editor.update(Agent.ID.make("plan"), (agent) => {
        agent.mode = "primary"
      })
      for (const name of ["general", "explore"])
        editor.update(Agent.ID.make(name), (agent) => {
          agent.mode = "subagent"
          agent.description = `The ${name} agent`
        })
    })
    yield* insertSession({ id: sid, directory: here.directory, agent })
    if (model) yield* db.update(SessionTable).set({ model }).where(eq(SessionTable.id, sid)).run().pipe(Effect.orDie)
    return yield* SessionContext.Service
  })

const reset = (tools: string[], defaultWindow?: number) => {
  seen.tools = tools
  seen.skills = []
  seen.agents = []
  seen.defaultWindow = defaultWindow
}

describe("the agent and skill listings of a session", () => {
  it.live("budget the skill listing against the window of the session's model, then the default model, then 200k", () =>
    Effect.gen(function* () {
      reset([SkillTool.name], 500_000)
      const known = yield* (yield* setup({ providerID: "p", id: "known" })).select(id)
      expect(known.instructions).toBeDefined()
      expect(seen.skills.at(-1)).toEqual({ contextWindow: 100_000, enabled: true })

      const context = yield* SessionContext.Service
      const { db } = yield* Database.Service
      yield* db.update(SessionTable).set({ model: { providerID: "p", id: "unknown" } }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)
      yield* context.select(id)
      expect(seen.skills.at(-1)?.contextWindow).toBe(500_000)

      seen.defaultWindow = undefined
      yield* context.select(id)
      expect(seen.skills.at(-1)?.contextWindow).toBe(200_000)

      // A catalog entry whose window is unknown reports 0, which is no window: the same fallback applies.
      seen.defaultWindow = 0
      yield* context.select(id)
      expect(seen.skills.at(-1)?.contextWindow).toBe(200_000)
    }),
  )

  const gates: ReadonlyArray<readonly [string, string[], boolean, boolean]> = [
    ["no listing tools", [], false, false],
    ["Skill only", [SkillTool.name], true, false],
    ["Agent only", [SubagentTool.name], false, true],
    ["Workflow only", [WorkflowTool.name], false, true],
  ]
  for (const [name, tools, skills, agents] of gates)
    it.live(`turns the listings on by the tools the request offers: ${name}`, () =>
      Effect.gen(function* () {
        reset(tools)
        const selected = yield* (yield* setup()).select(id)
        expect(seen.skills.at(-1)?.enabled).toBe(skills)
        const observed = yield* Instructions.read(selected.instructions)
        expect(observed.some((item) => item.key === "core/agent-guidance" && item.value !== Instructions.removed)).toBe(agents)
      }),
    )

  it.live("puts the agent source directly after the skill source in the baseline", () =>
    Effect.gen(function* () {
      reset([SubagentTool.name, SkillTool.name])
      const selected = yield* (yield* setup()).select(id)
      const keys = selected.instructions.map((source) => source.key)
      expect(keys.indexOf(Instructions.Key.make("core/agent-guidance"))).toBe(
        keys.indexOf(Instructions.Key.make("core/skill-guidance")) + 1,
      )
    }),
  )

  it.live("adds the agent source to the baseline of a session that can start agents", () =>
    Effect.gen(function* () {
      reset([SubagentTool.name])
      const context = yield* setup()
      const selected = yield* context.select(id)
      expect(selected.instructions.map((source) => source.key)).toContain(Instructions.Key.make("core/agent-guidance"))
      expect(AgentInstructions.NAME).toBe(SubagentTool.name)
    }),
  )

  // The Plan-mode filter is wired from the session's agent: listing only what Plan mode may start.
  it.live("lists only the agents Plan mode allows to a Plan session, and every agent to a Build session", () =>
    Effect.gen(function* () {
      reset([SubagentTool.name])
      // A session keeps its first listing, so each agent gets a session of its own.
      const listed = (agent: string) =>
        Effect.gen(function* () {
          const sid = SessionSchema.ID.make(`ses_listing_${agent}`)
          const selected = yield* (yield* setup(undefined, agent, sid)).select(sid)
          const observed = yield* Instructions.read(selected.instructions)
          return JSON.stringify(observed.find((item) => item.key === "core/agent-guidance")?.value)
        })
      const plan = yield* listed("plan")
      expect(plan).toContain(`"id":"explore"`)
      expect(plan).not.toContain(`"id":"general"`)
      expect(plan).not.toContain(`"id":"helper"`)
      const build = yield* listed("build")
      expect(build).toContain(`"id":"explore"`)
      expect(build).toContain(`"id":"general"`)
      expect(build).toContain(`"id":"helper"`)
    }),
  )
})
