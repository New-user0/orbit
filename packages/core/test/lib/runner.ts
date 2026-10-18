import { describe, expect, test } from "bun:test"
import {
  AIError,
  CompactionPart,
  CompactionCheckpointResponse,
  HttpContext,
  LLMEvent,
  LLMRequest,
  Message,
  SystemPart,
  LanguageModel,
  ToolFailure,
  TransportError,
  InvalidProviderOutputError,
  InvalidRequestError,
  RateLimitError,
  UnknownProviderError,
} from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols/openai-chat"
import { AnthropicMessages, OpenAIResponses } from "@orbit/ai/protocols"
import { compileRequest } from "@orbit/ai/route/client"
import { TestLLM } from "@orbit/ai/testing"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Database } from "@orbit/core/database/database"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNodePlatform } from "@orbit/core/effect/app-node-platform"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Bus } from "@orbit/core/bus"
import { Event } from "@orbit/schema/event"
import { App } from "@orbit/core/app"
import { Permission } from "@orbit/core/permission"
import { EventTable } from "@orbit/core/event/sql"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { Form } from "@orbit/core/form"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Snapshot } from "@orbit/core/snapshot"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionCompaction } from "@orbit/core/session/compaction"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionModelTransport } from "@orbit/core/session/model-transport"
import { SessionProviderContext } from "@orbit/core/session/provider-context"
import { Money } from "@orbit/schema/money"
import type { SessionError } from "@orbit/schema/session-error"
import { StepFailedError } from "@orbit/core/session/error"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionRunCoordinator } from "@orbit/core/session/run-coordinator"
import { SessionRunner } from "@orbit/core/session/runner/index"
import { SessionRunnerLLM } from "@orbit/core/session/runner/llm"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionTurn } from "@orbit/core/session/turn"
import { ShellResult } from "@orbit/core/shell/result"
import { SessionOutput } from "@orbit/core/session/output"
import { SessionTurnEnd } from "@orbit/core/session/turn-end"
import { SessionReminders } from "@orbit/core/session/reminders"
import { SessionUsage } from "@orbit/core/session/usage"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { OptimizePlugin } from "@orbit/core/plugin/optimize"
import { IdentityPlugin } from "@orbit/core/plugin/identity"
import { QuestionTool } from "@orbit/core/tool/plugin/question"
import { Agent } from "@orbit/core/agent"
import { Config } from "@orbit/core/config"
import { Document, Info } from "@orbit/schema/config"
import { ConfigCompaction } from "@orbit/schema/config/compaction"
import { ConfigToolExecution } from "@orbit/schema/config/tool-execution"
import { Tool } from "@orbit/core/tool"
import { ToolTraits } from "@orbit/core/tool/traits"
import type { Info as ToolInfo } from "@orbit/schema/tool"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable, SessionTable } from "@orbit/core/session/sql"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { SessionStore } from "@orbit/core/session/store"
import { Instructions } from "@orbit/core/instructions/index"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { SessionSystemPrompt } from "@orbit/core/session/system-prompt"
import { ID, Model } from "@orbit/core/model"
import { Location } from "@orbit/core/location"
import { Provider } from "@orbit/core/provider"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { testEffect } from "./effect"
import { promptLocationNode } from "../fixture/prompt-location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Expected } from "./session-message"
import { permissionLayer } from "./permission"
import { overloaded } from "./provider-failure"
import { tempGlobalLayer } from "../fixture/global"
import { SessionContext } from "@orbit/core/session/context"
import { SessionHistory } from "@orbit/core/session/history"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"
import { noVcsSnapshot } from "./vcs-snapshot"
import { SessionTitle } from "@orbit/core/session/title"
import { Global } from "@orbit/util/global"
import fs from "fs/promises"
import path from "path"
import { agentHost, modelHost, host, noProviders } from "../plugin/host"
import { CodeModeInstructions } from "@orbit/core/codemode/instructions"
import { Token } from "@orbit/core/util/token"

const emptyCodeMode = `${CodeModeInstructions.render({ total: 0, shown: 0, namespaces: [] })}\n\n`
type ToolBarrier = {
  readonly count: number
  readonly started: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  active: number
  maxActive: number
}
const testLLM = TestLLM.layer({
  fallback: [],
  transformRequest: (request) =>
    LLMRequest.update(request, {
      system: request.system.map((part) => ({
        ...part,
        text: part.text.replace(emptyCodeMode, ""),
      })),
      tools: request.tools.filter((tool) => tool.name !== "Execute"),
    }),
})
type ModelLimit = { readonly context: number; readonly input?: number; readonly output: number }
const defaultModelLimit = { context: 200_000, output: 32_000 }
const modelLimits = new Map<string, ModelLimit>()
const testModel = (id: string, limit: ModelLimit = defaultModelLimit) => {
  modelLimits.set(id, limit)
  return LanguageModel.make({ id, provider: "fake", route: OpenAIChat.route })
}
const model = testModel("fake-model")
// A window whose compaction is native, sized so that one measured reply fills it.
const nativeWindowModel = (() => {
  modelLimits.set("native-window", { context: 11_000, output: 1_000 })
  return LanguageModel.make({ id: "native-window", provider: "openai", route: OpenAIResponses.route })
})()
// Every request of these tests offers the Code Mode tool, which `testLLM` takes out of the request it records, and the
// base prompt carries that tool's guidance line.
const defaultSystem = SessionSystemPrompt.make(["Execute"])
// A window for the compaction tests below: the base prompt, which every request counts, and `tokens` of room beside it.
// Their windows were 12,000 and 9,000 tokens when the base prompt was 1,048 tokens, so they keep 10,952 and 7,952.
const withPrompt = (tokens: number) => Token.estimate(defaultSystem) + tokens
const replacementModel = testModel("replacement")
const compactModel = testModel("compact", { context: 4_000, output: 50 })
const fullOutputModel = testModel("full-output", { context: 262_144, output: 262_144 })
const unknownContextModel = testModel("unknown-context", { context: 0, output: 32_000 })
const undersizedContextModel = testModel("undersized-context", { context: 1, output: 1_000 })
const recoveryModel = testModel("recovery", { context: 200_000, output: 1_000 })
const fittedOutputModel = testModel("fitted-output", { context: 100_000, output: 64_000 })
const smallWindowModel = testModel("small-window", { context: 64_000, output: 16_000 })
const largeOutputModel = testModel("large-output", { context: 1_000_000, output: 1_000_000 })
// A price of $0.50 per token, so one token in and one out cost $1. Limits on cost refuse a model that has none.
const resolvesModel: Effect.Effect<void, SessionRunnerModel.Error> = Effect.void

const makeRunnerState = (compaction?: SessionRunnerModel.Resolved["compaction"]) => {
  let toolBarrier: ToolBarrier | undefined
  const releaseTools = (barrier: ToolBarrier) =>
    Effect.sync(() => {
      if (toolBarrier === barrier) toolBarrier = undefined
    }).pipe(Effect.andThen(Deferred.succeed(barrier.release, undefined)), Effect.asVoid)
  return {
    currentModel: model,
    toolsEnabled: true,
    modelCost: [] as Model.Info["cost"],
    compaction,
    modelResolveHook: resolvesModel,
    systemBaseline: "Initial context",
    systemRemoved: false,
    systemUnavailable: false,
    systemLoadHook: Effect.void,
    skillBaselines: new Map<Agent.ID, string>(),
    authorizations: new Array<Tool.Context>(),
    executions: new Array<string>(),
    // The sessions that a drain made the scratchpad of, and how many model requests had been made by then.
    scratchpads: new Array<{ readonly sessionID: Session.ID; readonly requests: number }>(),
    // Busy periods the coordinator started and settled; one continuation must stay inside one of them.
    drains: { started: 0, settled: 0 },
    turnEnd: ((_input: SessionTurnEnd.Input) => Effect.succeed(undefined)) as SessionTurnEnd.Check["run"],
    holds: new Map<string, { readonly started: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }>(),
    hold(text: string) {
      const existing = this.holds.get(text)
      if (existing) return existing
      const created = { started: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() }
      this.holds.set(text, created)
      return created
    },
    configControl: undefined as Config.TestInterface | undefined,
    // The producer lists of the reminder node. A test sets them before it resumes; the node reads them on every step.
    reminders: { durable: [], derived: [] } as {
      durable: SessionReminders.Durable[]
      derived: SessionReminders.Derived[]
      minimal?: boolean
    },
    traitGate: Deferred.makeUnsafe<void>(),
    asking: Deferred.makeUnsafe<void>(),
    answer: Deferred.makeUnsafe<void>(),
    closedTransports: new Array<Session.ID>(),
    blockTools: (count = 1) =>
      Effect.acquireRelease(
        Effect.all({ started: Deferred.make<void>(), release: Deferred.make<void>() }).pipe(
          Effect.map((deferreds) => {
            const barrier = { count, ...deferreds, active: 0, maxActive: 0 }
            toolBarrier = barrier
            return barrier
          }),
        ),
        releaseTools,
      ).pipe(
        Effect.map((barrier) => ({
          started: Deferred.await(barrier.started),
          release: releaseTools(barrier),
          maxActive: Effect.sync(() => barrier.maxActive),
        })),
      ),
    awaitToolBarrier: Effect.suspend(() => {
      const barrier = toolBarrier
      if (!barrier) return Effect.void
      barrier.active++
      barrier.maxActive = Math.max(barrier.maxActive, barrier.active)
      return (barrier.active === barrier.count ? Deferred.succeed(barrier.started, undefined) : Effect.void).pipe(
        Effect.andThen(Deferred.await(barrier.release)),
        Effect.ensuring(Effect.sync(() => barrier.active--)),
      )
    }),
  }
}

class RunnerState extends Context.Service<RunnerState, ReturnType<typeof makeRunnerState>>()("test/SessionRunner") {}

const permission = permissionLayer({ assert: () => Effect.void })
// These tools stand in for leaves that ask for themselves, so the registry gate leaves them alone.
const transformTools = (registry: Tool.Interface, tools: Readonly<Record<string, ToolInfo>>, options?: Tool.Options) =>
  registry.transform((editor) =>
    Object.entries(tools).forEach(([name, tool]) =>
      editor.add({ ...tool, name, options: { authorizes: true, ...(options ?? tool.options) } }),
    ),
  )
// With `real` the scratchpad is the service itself on a temporary folder, as a person has it. Otherwise a stand-in names
// no folder, so that no request holds a path of this machine, and it records each drain that made one.
const makeLayer = (persist: boolean) =>
  Layer.unwrap(
    Effect.map(RunnerState, (state) => {
      const scratchpad: LayerNode.Replacements = [
        SessionScratchpad.node.replace(
          Layer.effect(
            SessionScratchpad.Service,
            Effect.gen(function* () {
              const llm = yield* TestLLM.Service
              return SessionScratchpad.Service.of({
                path: () => undefined,
                source: () => Instructions.empty,
                ensure: (session) =>
                  Effect.sync(
                    () => void state.scratchpads.push({ sessionID: session.id, requests: llm.requests.length }),
                  ),
              })
            }),
          ).pipe(Layer.provide(testLLM)),
        ),
      ]
      const modelTransport = Layer.succeed(
        SessionModelTransport.Service,
        SessionModelTransport.Service.of({
          bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
          close: (sessionID) => Effect.sync(() => state.closedTransports.push(sessionID)),
          closeAll: Effect.void,
        }),
      )
      const echo = Layer.effectDiscard(
        Tool.Service.use((registry) =>
          transformTools(
            registry,
            {
              echo: {
                name: "echo",
                description: "Echo text",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.Struct({ text: Schema.String }),
                traits: { concurrencySafe: true },
                execute: ({ text }, context) =>
                  Effect.gen(function* () {
                    state.authorizations.push(context)
                    state.executions.push(text)
                    yield* state.awaitToolBarrier
                    return { output: { text }, content: text }
                  }),
              },
              // A read-only call that a new user message may cancel.
              cancelable: {
                name: "cancelable",
                description: "Echo text, as a call a new user message cancels",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.Struct({ text: Schema.String }),
                traits: { concurrencySafe: true, interruptBehavior: "cancel" },
                execute: ({ text }) =>
                  Effect.gen(function* () {
                    state.executions.push(text)
                    yield* state.awaitToolBarrier
                    return { output: { text }, content: text }
                  }),
              },
              // Runs alone: the scheduler starts it only when nothing else runs.
              mutate: {
                name: "mutate",
                description: "Echo text, as a call that changes things",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.Struct({ text: Schema.String }),
                traits: { concurrencySafe: false },
                execute: ({ text }) =>
                  Effect.gen(function* () {
                    state.executions.push(text)
                    yield* state.awaitToolBarrier
                    return { output: { text }, content: text }
                  }),
              },
              // Finishes when the test lets it, so calls can finish in another order than they started.
              held: {
                name: "held",
                description: "Echo text once the test releases it",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.Struct({ text: Schema.String }),
                traits: { concurrencySafe: true },
                execute: ({ text }) =>
                  Effect.gen(function* () {
                    const hold = state.hold(text)
                    state.executions.push(text)
                    yield* Deferred.succeed(hold.started, undefined)
                    yield* Deferred.await(hold.release)
                    return { output: { text }, content: text }
                  }),
              },
              // Its concurrencySafe answer waits for the test, to show that a pending answer holds back later calls only.
              gated: {
                name: "gated",
                description: "Echo text, after its traits are known",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.Struct({ text: Schema.String }),
                traits: { concurrencySafe: () => Deferred.await(state.traitGate).pipe(Effect.as(true)) },
                execute: ({ text }) =>
                  Effect.gen(function* () {
                    state.executions.push(text)
                    yield* state.awaitToolBarrier
                    return { output: { text }, content: text }
                  }),
              },
              // Waits for an answer that is a decline: the calls queued behind it must not start.
              ask: {
                name: "ask",
                description: "Echo text after a permission",
                input: Schema.Struct({ text: Schema.String }),
                output: Schema.Struct({ text: Schema.String }),
                traits: { concurrencySafe: false },
                execute: ({ text }) =>
                  Effect.gen(function* () {
                    state.executions.push(text)
                    yield* Deferred.succeed(state.asking, undefined)
                    yield* Deferred.await(state.answer)
                    // The way `Permission.assert` surfaces a decline: as a defect that the model request recovers.
                    return yield* Effect.die(new Permission.DeclinedError())
                  }),
              },
              defect: {
                name: "defect",
                description: "Fail unexpectedly",
                input: Schema.Struct({}),
                output: Schema.Struct({}),
                traits: { concurrencySafe: true },
                execute: () => state.awaitToolBarrier.pipe(Effect.andThen(Effect.die("unexpected tool defect"))),
              },
              storefail: {
                name: "storefail",
                description: "Produce output that cannot be persisted",
                input: Schema.Struct({}),
                output: Schema.Struct({}),
                traits: { concurrencySafe: true },
                execute: () => Effect.succeed({ output: {} }),
              },
            },
            { codemode: false },
          ),
        ),
      )
      const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [Tool.node] })
      const models = Layer.mock(SessionRunnerModel.Service)({
        resolve: (session) =>
          state.modelResolveHook.pipe(
            Effect.map(() => {
              const selected = session.model?.id === "replacement" ? replacementModel : state.currentModel
              return SessionRunnerModel.resolved(selected, {
                capabilities: { tools: state.toolsEnabled, input: ["text", "image"], output: ["text"] },
                cost: state.modelCost,
                limit: modelLimits.get(String(selected.id)) ?? defaultModelLimit,
                variant: session.model?.variant,
                compaction: state.compaction,
              })
            }),
          ),
      })
      const systemContextKey = Instructions.Key.make("test/context")
      const systemContext = Layer.mock(InstructionBuiltIns.Service, {
        preferences: () => Effect.succeed(Instructions.empty),
        load: () =>
          Effect.sync(() =>
            Instructions.make({
              key: systemContextKey,
              codec: Schema.toCodecJson(Schema.String),
              read: state.systemLoadHook.pipe(
                Effect.andThen(
                  Effect.sync(() =>
                    state.systemUnavailable
                      ? Instructions.unavailable
                      : state.systemRemoved
                        ? Instructions.removed
                        : state.systemBaseline,
                  ),
                ),
              ),
              render: {
                initial: String,
                changed: (_previous, current) => current,
                removed: () => "System context source removed: test/context",
              },
            }),
          ),
      })
      const instructionContext = Layer.mock(InstructionDiscovery.Service, {
        project: true,
        global: true,
        load: () => Effect.succeed(Instructions.empty),
      })
      const skillInstructions = Layer.mock(SkillInstructions.Service, {
        load: (permissions) => {
          // `setup` tags each agent's ruleset with a `skill` rule naming that agent.
          const baseline = permissions
            .filter((rule) => rule.action === "skill")
            .map((rule) => state.skillBaselines.get(Agent.ID.make(rule.resource)))
            .findLast((text) => text !== undefined)
          return Effect.succeed(
            baseline === undefined
              ? Instructions.empty
              : Instructions.make({
                  key: Instructions.Key.make("test/skill-guidance"),
                  codec: Schema.toCodecJson(Schema.String),
                  read: Effect.succeed(baseline),
                  render: {
                    initial: String,
                    changed: (_previous, current) => current,
                    removed: () => "Skill guidance removed",
                  },
                }),
          )
        },
      })
      const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
        load: () => Effect.succeed(Instructions.empty),
      })
      const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
      const config = Config.testLayer([
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]).pipe(
        Layer.tap((context) =>
          Effect.sync(() => {
            state.configControl = Context.get(context, Config.Test)
          }),
        ),
      )
      const promptModels = Layer.mock(Model.Service, {
        get: () => Effect.undefined,
        all: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
        default: () => Effect.undefined,
        small: () => Effect.undefined,
      })
      const replacements: LayerNode.Replacements = [
        Snapshot.node.replace(Snapshot.noopLayer),
        LayerNodePlatform.llmClient.replace(TestLLM.clientLayer.pipe(Layer.provide(testLLM))),
        SessionRunnerModel.node.replace(models),
        InstructionBuiltIns.node.replace(systemContext),
        InstructionDiscovery.node.replace(instructionContext),
        ...scratchpad,
        noVcsSnapshot,
        Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
        SkillInstructions.node.replace(skillInstructions),
        ReferenceInstructions.node.replace(referenceInstructions),
        Permission.node.replace(permission),
        Config.node.replace(config),
        PluginSupervisor.node.replace(Layer.empty),
        Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
        SessionModelTransport.node.replace(modelTransport),
        SessionTurnEnd.node.replace(SessionTurnEnd.layerWith([{ name: "test", run: (input) => state.turnEnd(input) }])),
        SessionReminders.node.replace(SessionReminders.configured(state.reminders)),
      ]
      const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
        ...replacements,
        McpInstructions.node.replace(mcpInstructions),
      ])
      const execution = Layer.effect(
        SessionExecution.Service,
        Effect.gen(function* () {
          const sessionRunner = yield* SessionRunner.Service
          function drain(
            sessionID: Session.ID,
            force: boolean,
            continuation?: SessionRunner.Continuation,
          ): Effect.Effect<void, SessionRunner.RunError> {
            return sessionRunner
              .drain({ sessionID, force, continuation })
              .pipe(
                Effect.flatMap((result) =>
                  result._tag === "Complete" ? Effect.void : drain(sessionID, false, result.continuation),
                ),
              )
          }
          const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
            drain: (sessionID, force) =>
              Effect.sync(() => void state.drains.started++).pipe(
                Effect.andThen(drain(sessionID, force)),
                Effect.ensuring(Effect.sync(() => void state.drains.settled++)),
              ),
          })
          return SessionExecution.Service.of({
            active: coordinator.active,
            isActive: coordinator.isActive,
            resume: coordinator.run,
            wake: coordinator.wake,
            interrupt: (sessionID) => coordinator.interrupt(sessionID),
            awaitIdle: coordinator.awaitIdle,
          })
        }),
      ).pipe(Layer.provide(runnerLayer), Layer.orDie)
      return AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          Bus.node,
          Form.node,
          SessionProjector.node,
          SessionStore.node,
          SessionInbox.node,
          Agent.node,
          Model.node,
          Tool.node,
          PluginHooks.node,
          echoNode,
          SessionRunnerModel.node,
          InstructionBuiltIns.node,
          InstructionDiscovery.node,
          InstructionEntry.node,
          SkillInstructions.node,
          ReferenceInstructions.node,
          Config.node,
          Snapshot.node,
          SessionCompaction.node,
          LayerNodePlatform.llmClient,
          SessionContext.node,
          SessionScratchpad.node,
          SessionTitle.node,
          SessionRunnerLLM.node,
          SessionExecution.node,
          Session.node,
        ]),
        [
          ...replacements,
          Bus.node.replace(persist ? Bus.configured({ persist }) : Bus.configured()),
          LocationServiceMap.node.replace(promptLocationNode),
          Model.node.replace(promptModels),
          SessionExecution.node.replace(execution),
        ],
      )
    }),
  ).pipe(Layer.provideMerge(Layer.sync(RunnerState, makeRunnerState)), Layer.provideMerge(testLLM))
// Most scenarios read the event log, so they run on a persisting Bus. A CLI server builds its Bus without one, so the
// turn limits (whose inputs must not live in the log) also run on `productionLayer`.
const layer = makeLayer(true)
const it = testEffect(layer)
const sessionID = Session.ID.make("ses_runner_test")
const otherSessionID = Session.ID.make("ses_runner_other")

const insertSession = (id: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const sessionInbox = yield* SessionInbox.Service
  const agents = yield* Agent.Service
  const models = yield* Model.Service
  const hooks = yield* PluginHooks.Service
  const pluginHost = host({
    agent: agentHost(agents),
    model: modelHost(models),
    provider: noProviders,
    session: {
      hook: (name, callback) => hooks.register("session", name, callback),
      // These sessions have no parent and no fork, so no plugin takes them for a subagent.
      get: (input) => Effect.fail(new Session.NotFoundError({ sessionID: input.sessionID })),
    },
  })
  yield* Effect.forEach(OptimizePlugin.Plugins, (plugin) => plugin.effect(pluginHost), {
    discard: true,
  })
  yield* IdentityPlugin.Plugin.effect(pluginHost)
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    // Skill instructions receive only a ruleset, so tag each agent with a rule naming itself for the mock.
    for (const id of ["build", "reviewer"]) {
      editor.update(Agent.ID.make(id), (agent) => {
        agent.permissions.push({ action: "skill", resource: id, effect: "allow" })
      })
    }
  })
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
  const state = yield* RunnerState
  const session = yield* Session.Service
  const llm = yield* TestLLM.Service
  const admit = (text: string) => session.prompt({ sessionID, text, resume: false })
  const resume = session.resume(sessionID)
  return Object.assign(state, {
    db,
    bus,
    sessionInbox,
    session,
    llm,
    requests: llm.requests,
    admit,
    resume,
    context: session.context(sessionID),
    messages: session.messages({ sessionID }),
    inbox: session.inbox(sessionID),
    runPrompt: Effect.fnUntraced(function* (text: string) {
      const message = yield* admit(text)
      yield* resume
      return message
    }),
    // Pause coordinated Session.resume at its first model request, not a direct runner drain.
    resumePaused: Effect.gen(function* () {
      const gate = yield* llm.gate
      const run = yield* resume.pipe(Effect.forkChild)
      yield* gate.started
      return { finish: gate.release.pipe(Effect.andThen(Fiber.join(run))) }
    }),
  })
})

type Scenario = Effect.Success<typeof setup>
const scenarioOn =
  (on: typeof it) =>
  (name: string, body: (s: Scenario) => Effect.gen.Return<void, unknown, Layer.Success<typeof layer> | Scope.Scope>) =>
    on.effect(
      name,
      Effect.gen(function* () {
        const s = yield* setup
        return yield* body(s)
      }),
    )
const scenario = scenarioOn(it)

export {
  RunnerState,
  compactModel,
  fittedOutputModel,
  it,
  recoveryModel,
  undersizedContextModel,
  layer,
  model,
  nativeWindowModel,
  replacementModel,
  scenario,
  sessionID,
  setup,
  testLLM,
  transformTools,
}
export type { Scenario }
