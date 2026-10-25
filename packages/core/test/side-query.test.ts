import { beforeEach, expect } from "bun:test"
import { LLMEvent, LanguageModel, ToolDefinition, type LLMRequest } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { TestLLM } from "@orbit/ai/testing"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { EventTable } from "@orbit/core/event/sql"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instance } from "@orbit/core/instance/service"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Project } from "@orbit/core/project"
import { Provider } from "@orbit/core/provider"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { SessionReminders } from "@orbit/core/session/reminders"
import { SessionEvent } from "@orbit/core/session/event"
import { InstructionState } from "@orbit/core/session/instruction-state"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable, SessionUsageTable } from "@orbit/core/session/sql"
import { SessionStats } from "@orbit/core/session/stats"
import { SessionStore } from "@orbit/core/session/store"
import { SessionTurn } from "@orbit/core/session/turn"
import { SideQuery } from "@orbit/core/side-query"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { ToolOutput } from "@orbit/core/tool-output"
import { Event } from "@orbit/schema/event"
import { Money } from "@orbit/schema/money"
import { SessionEvent as SessionEventSchema } from "@orbit/schema/session-event"
import { eq } from "drizzle-orm"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Context, DateTime, Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { noMemory } from "./lib/memory"
import { noScratchpad } from "./lib/scratchpad"
import { noVcsSnapshot } from "./lib/vcs-snapshot"
import { stubSnapshot } from "./lib/tool"

const sessionID = SessionSchema.ID.make("ses_side_query_test")
const primary = LanguageModel.make({ id: "side-primary", provider: "test", route: OpenAIChat.route })
const smallLanguage = LanguageModel.make({ id: "side-small", provider: "test", route: OpenAIChat.route })
const pinnedLanguage = LanguageModel.make({ id: "side-pinned", provider: "test", route: OpenAIChat.route })
const languages = new Map([
  ["side-primary", primary],
  ["side-small", smallLanguage],
  ["side-pinned", pinnedLanguage],
])
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
  },
]

const catalog = (id: string) =>
  Model.Info.make({
    ...Model.Info.default(Provider.ID.make("test"), Model.ID.make(id)),
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: Model.VariantID.make("high") }, { id: Model.VariantID.make("none") }],
  })
const smallInfo = catalog("side-small")
const pinnedInfo = catalog("side-pinned")
const primaryInfo = catalog("side-primary")

let selections: Array<{ id: string | undefined; variant: string | undefined }> = []
let provided: string[] = []
let toolDefinitions: ToolDefinition[] = []

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) => {
    selections.push({ id: session.model?.id, variant: session.model?.variant })
    return Effect.succeed(
      SessionRunnerModel.resolved(languages.get(session.model?.id ?? "side-primary") ?? primary, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost,
        limit: { context: 200_000, output: 32_000 },
        variant: session.model?.variant,
      }),
    )
  },
})
const catalogModels = Layer.mock(Model.Service, {
  small: () => Effect.succeed(smallInfo),
  get: (_providerID, id) =>
    Effect.succeed(id === pinnedInfo.id ? pinnedInfo : id === primaryInfo.id ? primaryInfo : undefined),
})
const builtins = Layer.mock(InstructionBuiltIns.Service, {
  preferences: () => Effect.succeed(Instructions.empty),
  load: () =>
    Effect.succeed(
      Instructions.make({
        key: Instructions.Key.make("test/context"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.succeed("Session instructions"),
        render: { initial: String, changed: (_previous, current) => current },
      }),
    ),
})
const empty = Instructions.empty

const llm = TestLLM.testLayer()
const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Project.node,
        SessionProjector.node,
        SessionStore.node,
        Agent.node,
        SessionContext.node,
        SessionReminders.node,
        InstructionBuiltIns.node,
        PluginHooks.node,
        ToolOutput.node,
        llmClient,
      ]),
      [
        // The production node reads the Location for its language-server reminder; these tests have none.
        SessionReminders.node.replace(SessionReminders.configured(SessionReminders.production)),
        Bus.node.replace(Bus.configured({ persist: true })),
        llmClient.replace(llm),
        Model.node.replace(catalogModels),
        SessionRunnerModel.node.replace(models),
        InstructionBuiltIns.node.replace(builtins),
        noScratchpad,
        noMemory,
        noVcsSnapshot,
        InstructionDiscovery.node.replace(
          Layer.mock(InstructionDiscovery.Service, { project: true, global: true, load: () => Effect.succeed(empty) }),
        ),
        SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(empty) })),
        ReferenceInstructions.node.replace(
          Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(empty) }),
        ),
        McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(empty) })),
        PluginSupervisor.node.replace(Layer.empty),
        Tool.node.replace(
          Layer.mock(Tool.Service, {
            snapshot: () =>
              Effect.succeed(stubSnapshot({ definitions: toolDefinitions, execute: () => Effect.die("unused") })),
            transform: () => Effect.die("unused"),
          }),
        ),
        Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      ],
    ),
    llm,
  ),
)

beforeEach(() => {
  selections = []
  provided = []
  toolDefinitions = []
})

const setup = (config?: {
  readonly pinned?: boolean
  readonly pinnedMissing?: boolean
  readonly variant?: string
  readonly model?: string
  readonly activation?: Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const agents = yield* Agent.Service
    const projects = yield* Project.Service
    const context = yield* SessionContext.Service
    const reminders = yield* SessionReminders.Service
    const store = yield* SessionStore.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
      })
      editor.update(Agent.ID.make("side"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
        if (config?.pinned) agent.model = { providerID: Provider.ID.make("test"), id: Model.ID.make("side-pinned") }
        if (config?.pinnedMissing)
          agent.model = { providerID: Provider.ID.make("test"), id: Model.ID.make("side-missing") }
      })
    })
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
        slug: "side-query",
        directory: "/project",
        title: "Side query",
        version: "test",
        agent: Agent.ID.make("build"),
        model: { providerID: "test", id: config?.model ?? "side-primary", ...(config?.variant ? { variant: config.variant } : {}) },
      })
      .run()
      .pipe(Effect.orDie)
    yield* InstructionState.prepare(db, bus, yield* (yield* InstructionBuiltIns.Service).load(), sessionID)
    // The side query leaves the caller's Location behind: its model context exists only inside `provide`.
    const instances = Instance.Service.of({
      provide: (session) => {
        provided.push(session.id)
        return Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SessionContext.Service, context),
            Layer.succeed(SessionReminders.Service, reminders),
            Layer.mock(Plugin.Service, { awaitActivation: config?.activation ?? Effect.void }),
          ) as Layer.Layer<Instance.Services>,
        )
      },
    })
    const sideQuery = yield* Layer.build(SideQuery.layer).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.map((services) => Context.get(services, SideQuery.Service)),
    )
    return { db, bus, store, sideQuery }
  })

const usage = { inputTokens: 1000, nonCachedInputTokens: 1000, outputTokens: 100, visibleOutputTokens: 100 }
const answer = (text: string) =>
  TestLLM.complete(
    { reason: { normalized: "stop" }, usage },
    LLMEvent.textStart({ id: "t" }),
    LLMEvent.textDelta({ id: "t", text }),
    LLMEvent.textEnd({ id: "t" }),
  )
const call = (input: unknown) =>
  TestLLM.complete(
    { reason: { normalized: "tool-calls" }, usage },
    LLMEvent.toolCall({ id: "call_1", name: "side_query_result", input }),
  )

const base = {
  sessionID,
  purpose: "memory.recall",
  system: "Answer in one word.",
  prompt: "Which fruit?",
} as const

const userTexts = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )

it.effect("text() sends the small model of the primary provider with the minimal reasoning variant", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(answer("pear"))

    const result = yield* sideQuery.text(base)

    expect(result.text).toBe("pear")
    expect(result.model).toMatchObject({ providerID: "test", id: "side-small" })
    const requests = yield* test.requests()
    expect(String(requests.at(-1)?.model.id)).toBe("side-small")
    expect(requests.at(-1)?.tools).toEqual([])
    expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(["Answer in one word."])
    expect(userTexts(requests.at(-1))).toEqual(["Which fruit?"])
    expect(selections).toContainEqual({ id: "side-small", variant: "none" })
    expect(provided).toEqual([sessionID])
  }),
)

it.effect("agents.side.model overrides the choice and model:'primary' uses the session model", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup({ pinned: true })
    const test = yield* TestLLM.Test
    yield* test.push(answer("one"), answer("two"))

    const pinned = yield* sideQuery.text(base)
    const session = yield* sideQuery.text({ ...base, model: "primary" })

    expect(String(pinned.model.id)).toBe("side-pinned")
    expect(String(session.model.id)).toBe("side-primary")
    expect((yield* test.requests()).slice(-2).map((request) => String(request.model.id))).toEqual([
      "side-pinned",
      "side-primary",
    ])
  }),
)

it.effect("history:true sends the transcript and history:false sends only the caller's text", () =>
  Effect.gen(function* () {
    const { bus, sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    const earlier = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID: earlier,
      item: { type: "user", payload: { text: "Earlier question" }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: earlier })
    yield* test.push(answer("with"), answer("without"))

    yield* sideQuery.text({ ...base, history: true })
    yield* sideQuery.text(base)

    const [withHistory, without] = (yield* test.requests()).slice(-2)
    expect(userTexts(withHistory)).toEqual(["Earlier question", "Which fruit?"])
    expect(withHistory?.system.map((part) => part.text)).toContain("Session instructions")
    expect(withHistory?.system.map((part) => part.text)).toContain("Answer in one word.")
    expect(userTexts(without)).toEqual(["Which fruit?"])
    expect(without?.system.map((part) => part.text)).toEqual(["Answer in one word."])
  }),
)

const Fruit = Schema.Struct({ name: Schema.String, sweetness: Schema.Number })

it.effect("object() forces one tool call and decodes its input", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(call({ name: "pear", sweetness: 7 }))

    const result = yield* sideQuery.object({ ...base, schema: Fruit })

    expect(result.value).toEqual({ name: "pear", sweetness: 7 })
    expect(String(result.model.id)).toBe("side-small")
    const request = (yield* test.requests()).at(-1)
    expect(request?.tools.map((tool) => tool.name)).toEqual(["side_query_result"])
    expect(request?.toolChoice).toMatchObject({ type: "tool", name: "side_query_result" })
  }),
)

it.effect("object() reports malformed input, a missing call and a call to another tool as InvalidOutputError", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(
      call({ name: "pear", sweetness: "very" }),
      answer("pear, sweetness 7"),
      TestLLM.complete(
        { reason: { normalized: "tool-calls" } },
        LLMEvent.toolCall({ id: "call_2", name: "Bash", input: { name: "pear", sweetness: 7 } }),
      ),
    )

    const failures = yield* Effect.all([
      sideQuery.object({ ...base, schema: Fruit }).pipe(Effect.flip),
      sideQuery.object({ ...base, schema: Fruit }).pipe(Effect.flip),
      sideQuery.object({ ...base, schema: Fruit }).pipe(Effect.flip),
    ])

    expect(failures.map((failure) => failure._tag)).toEqual([
      "SideQuery.InvalidOutputError",
      "SideQuery.InvalidOutputError",
      "SideQuery.InvalidOutputError",
    ])
  }),
)

it.effect("a response that never arrives yields TimeoutError", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(answer("late"))
    const gate = yield* test.gate()
    const fiber = yield* sideQuery.text({ ...base, timeout: Duration.seconds(5) }).pipe(Effect.flip, Effect.forkChild)
    yield* gate.started
    yield* TestClock.adjust("6 seconds")

    const error = yield* Fiber.join(fiber)

    expect(error._tag).toBe("SideQuery.TimeoutError")
  }),
)

// FU-M2-017: a call the deadline cuts off was sent, so it was probably billed.
it.effect("a side query that times out after the request was sent records an estimated spend", () =>
  Effect.gen(function* () {
    const { db, sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(answer("late"))
    const gate = yield* test.gate()
    const fiber = yield* sideQuery.text({ ...base, timeout: Duration.seconds(5) }).pipe(Effect.flip, Effect.forkChild)
    yield* gate.started
    yield* TestClock.adjust("6 seconds")
    expect((yield* Fiber.join(fiber))._tag).toBe("SideQuery.TimeoutError")

    const rows = yield* db.select().from(SessionUsageTable).where(eq(SessionUsageTable.session_id, sessionID)).all().pipe(Effect.orDie)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "side_query", source: base.purpose })
    // The prompt is estimated and the reply is taken at the model's output limit, priced at the model's rates.
    expect(rows[0]!.tokens_input).toBeGreaterThan(0)
    expect(rows[0]!.tokens_output).toBe(32_000)
    expect(rows[0]!.cost).toBeGreaterThan(0)
    const spent = yield* SessionTurn.usage(db, sessionID, { seq: -1, time: DateTime.makeUnsafe(0) })
    expect(spent).toMatchObject({ unknown: 0, unknownTokens: 0 })
    expect(spent.cost).toBeCloseTo(rows[0]!.cost)
  }),
)

it.effect("a deadline that fires before the request is sent records nothing", () =>
  Effect.gen(function* () {
    const { db, sideQuery } = yield* setup({ activation: Effect.never })
    const fiber = yield* sideQuery.text({ ...base, timeout: Duration.seconds(5) }).pipe(Effect.flip, Effect.forkChild)
    yield* TestClock.adjust("6 seconds")
    expect((yield* Fiber.join(fiber))._tag).toBe("SideQuery.TimeoutError")

    expect(yield* db.select().from(SessionUsageTable).where(eq(SessionUsageTable.session_id, sessionID)).all().pipe(Effect.orDie)).toEqual([])
  }),
)

it.effect("a Session that does not exist yields UnavailableError without a request", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    const before = (yield* test.requests()).length

    const error = yield* sideQuery
      .text({ ...base, sessionID: SessionSchema.ID.make("ses_side_query_missing") })
      .pipe(Effect.flip)

    expect(error._tag).toBe("SideQuery.UnavailableError")
    expect(yield* test.requests()).toHaveLength(before)
  }),
)

it.effect("records session.side_query.recorded, raises the session cost and counts in stats", () =>
  Effect.gen(function* () {
    const { db, sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(answer("pear"), call({ name: "pear", sweetness: 1 }), call({ name: "pear", sweetness: "bad" }))

    yield* sideQuery.text({ ...base, purpose: "session.away_summary" })
    yield* sideQuery.object({ ...base, schema: Fruit })
    // The provider billed an unusable answer too, so it is recorded.
    yield* sideQuery.object({ ...base, schema: Fruit }).pipe(Effect.flip)

    const events = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    const recorded = events.filter(
      (row) =>
        row.type ===
        Event.versionedType(
          SessionEventSchema.SideQueryRecorded.type,
          SessionEventSchema.SideQueryRecorded.durable.version,
        ),
    )
    expect(recorded).toHaveLength(3)
    expect(recorded[0]?.data).toMatchObject({
      sessionID,
      purpose: "session.away_summary",
      tokens: { input: 1000, output: 100 },
    })
    expect(recorded[1]?.data).toMatchObject({ purpose: "memory.recall" })
    // (1000 * 1 + 100 * 2) / 1e6 per call.
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    expect(row?.cost).toBeCloseTo(0.0012 * 3, 10)
    expect(row?.tokens_input).toBe(3000)

    const stats = yield* SessionStats.get({
      from: 0,
      to: 86_400_000,
      timezone: "UTC",
      tools: "none",
    })
    expect(stats.cost).toBeCloseTo(0.0012 * 3, 10)
    expect(stats.tokens.input).toBe(3000)
  }),
)

it.effect("a session on a reasoning variant still runs the primary model at the minimal variant", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup({ variant: "high" })
    const test = yield* TestLLM.Test
    yield* test.push(answer("one"))

    const result = yield* sideQuery.text({ ...base, model: "primary" })

    expect(String(result.model.id)).toBe("side-primary")
    expect(String(result.model.variant)).toBe("none")
    expect(selections).toContainEqual({ id: "side-primary", variant: "none" })
  }),
)

it.effect("an agents.side.model that the catalog does not list falls back to the small model", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup({ pinnedMissing: true })
    const test = yield* TestLLM.Test
    yield* test.push(answer("one"))

    expect(String((yield* sideQuery.text(base)).model.id)).toBe("side-small")
  }),
)

it.effect("history:true sends the session's tool definitions and forbids calling them", () =>
  Effect.gen(function* () {
    toolDefinitions = [ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } })]
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(answer("text"), call({ name: "pear", sweetness: 7 }), answer("plain"))

    yield* sideQuery.text({ ...base, history: true })
    yield* sideQuery.object({ ...base, history: true, schema: Fruit })
    yield* sideQuery.text(base)

    const [text, object, plain] = (yield* test.requests()).slice(-3)
    expect(text?.tools.map((tool) => tool.name)).toEqual(["lookup"])
    expect(text?.toolChoice).toMatchObject({ type: "none" })
    expect(object?.tools.map((tool) => tool.name)).toEqual(["lookup", "side_query_result"])
    expect(object?.toolChoice).toMatchObject({ type: "tool", name: "side_query_result" })
    expect(plain?.tools).toEqual([])
    expect(plain?.toolChoice).toBeUndefined()
  }),
)

it.effect("the timeout covers the work before the provider call", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup({ activation: Effect.never })
    const fiber = yield* sideQuery.text({ ...base, timeout: Duration.seconds(5) }).pipe(Effect.flip, Effect.forkChild)
    yield* TestClock.adjust("6 seconds")

    expect((yield* Fiber.join(fiber))._tag).toBe("SideQuery.TimeoutError")
  }),
)

it.effect("a defect inside the query is an UnavailableError", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup({ activation: Effect.die(new Error("hook exploded")) })

    const error = yield* sideQuery.text(base).pipe(Effect.flip)

    expect(error._tag).toBe("SideQuery.UnavailableError")
    expect(error.message).not.toContain("hook exploded")
  }),
)

it.effect("an undecodable answer keeps the model's text out of the error message", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(call({ name: "SECRET-MODEL-TEXT", sweetness: "very" }))

    const error = yield* sideQuery.object({ ...base, schema: Fruit }).pipe(Effect.flip)

    expect(error._tag).toBe("SideQuery.InvalidOutputError")
    expect(error.message).toBe("The tool input failed schema decode")
    expect(error.message).not.toContain("SECRET-MODEL-TEXT")
    expect(error.cause).toBeDefined()
  }),
)

it.effect("text() reports a tool-call answer and a blank answer as InvalidOutputError", () =>
  Effect.gen(function* () {
    const { sideQuery } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(call({ name: "pear", sweetness: 7 }), answer(""), answer("  \n "))

    const failures = yield* Effect.all([
      sideQuery.text(base).pipe(Effect.flip),
      sideQuery.text(base).pipe(Effect.flip),
      sideQuery.text(base).pipe(Effect.flip),
    ])

    expect(failures.map((failure) => failure._tag)).toEqual([
      "SideQuery.InvalidOutputError",
      "SideQuery.InvalidOutputError",
      "SideQuery.InvalidOutputError",
    ])
  }),
)

const loadSelected = (variant?: string, model?: string) =>
  Effect.gen(function* () {
    const { store } = yield* setup({ ...(variant ? { variant } : {}), ...(model ? { model } : {}) })
    const context = yield* SessionContext.Service
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die("Missing fixture session")
    return yield* context.load({
      session,
      agent: { id: Agent.ID.make("build"), info: Agent.Info.default(Agent.ID.make("build")) },
      instructions: Instructions.empty,
      tools: { definitions: [] } as never,
    })
  })

it.effect("load sets the model without its reasoning variant when the session selected a variant", () =>
  Effect.gen(function* () {
    const loaded = yield* loadSelected("high")
    expect(String(loaded.model.ref.variant)).toBe("high")
    expect(String((yield* (loaded.unreasoned ?? Effect.succeed(undefined)))?.ref.variant)).toBe("none")
  }),
)

it.effect("load leaves the unreasoned model unset when the session selected no variant", () =>
  Effect.gen(function* () {
    const loaded = yield* loadSelected()
    expect(String(loaded.model.ref.variant)).toBe("default")
    expect(yield* (loaded.unreasoned ?? Effect.succeed(undefined))).toBeUndefined()
  }),
)

it.effect("load leaves the unreasoned model unset when the catalog does not list the session model", () =>
  Effect.gen(function* () {
    const loaded = yield* loadSelected("high", "side-small")
    expect(String(loaded.model.ref.variant)).toBe("high")
    expect(yield* (loaded.unreasoned ?? Effect.succeed(undefined))).toBeUndefined()
  }),
)
