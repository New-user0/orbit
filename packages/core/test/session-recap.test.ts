// clients-ux-27: the away summary. A recap is one call on the small model with the last 30 messages of the
// Session, an empty system prompt, no tools and the recap instruction as the last user message. It is recorded as
// `session.recap.recorded`, projected as a `recap` message, never lowered into a model request, and written at most
// once per user turn, however many clients ask.
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
import { SessionRecap } from "@orbit/core/session/recap"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SideQuery } from "@orbit/core/side-query"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { Event } from "@orbit/schema/event"
import { Money } from "@orbit/schema/money"
import { Shell } from "@orbit/schema/shell"
import { SessionEvent as SessionEventSchema } from "@orbit/schema/session-event"
import { eq } from "drizzle-orm"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Context, Effect, Fiber, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { noScratchpad } from "./lib/scratchpad"
import { noVcsSnapshot } from "./lib/vcs-snapshot"
import { stubSnapshot } from "./lib/tool"

const sessionID = SessionSchema.ID.make("ses_recap_test")
const primary = LanguageModel.make({ id: "recap-primary", provider: "test", route: OpenAIChat.route })
const smallLanguage = LanguageModel.make({ id: "recap-small", provider: "test", route: OpenAIChat.route })
const pinnedLanguage = LanguageModel.make({ id: "recap-pinned", provider: "test", route: OpenAIChat.route })
const languages = new Map([
  ["recap-primary", primary],
  ["recap-small", smallLanguage],
  ["recap-pinned", pinnedLanguage],
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
const smallInfo = catalog("recap-small")
const pinnedInfo = catalog("recap-pinned")
const primaryInfo = catalog("recap-primary")

let selections: Array<{ id: string | undefined; variant: string | undefined }> = []
let toolDefinitions: ToolDefinition[] = []
// Whether the provider has a small model. Without one, SideQuery falls back to the primary model; a recap does not.
let small: Model.Info | undefined = smallInfo

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) => {
    selections.push({ id: session.model?.id, variant: session.model?.variant })
    return Effect.succeed(
      SessionRunnerModel.resolved(languages.get(session.model?.id ?? "recap-primary") ?? primary, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost,
        limit: { context: 200_000, output: 32_000 },
        variant: session.model?.variant,
      }),
    )
  },
})
const catalogModels = Layer.mock(Model.Service, {
  small: () => Effect.succeed(small),
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
        llmClient,
      ]),
      [
        SessionReminders.node.replace(SessionReminders.configured(SessionReminders.production)),
        Bus.node.replace(Bus.configured({ persist: true })),
        llmClient.replace(llm),
        Model.node.replace(catalogModels),
        SessionRunnerModel.node.replace(models),
        InstructionBuiltIns.node.replace(builtins),
        noScratchpad,
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
  toolDefinitions = []
  small = smallInfo
})

const setup = (config?: { readonly pinned?: boolean }) =>
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
        if (config?.pinned) agent.model = { providerID: Provider.ID.make("test"), id: Model.ID.make("recap-pinned") }
      })
    })
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
        slug: "recap",
        directory: "/project",
        title: "Recap",
        version: "test",
        agent: Agent.ID.make("build"),
        model: { providerID: "test", id: "recap-primary" },
      })
      .run()
      .pipe(Effect.orDie)
    yield* InstructionState.prepare(db, bus, yield* (yield* InstructionBuiltIns.Service).load(), sessionID)
    const instances = Instance.Service.of({
      provide: () =>
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SessionContext.Service, context),
            Layer.succeed(SessionReminders.Service, reminders),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
          ) as Layer.Layer<Instance.Services>,
        ),
    })
    const sideQuery = yield* Layer.build(SideQuery.layer).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.map((services) => Context.get(services, SideQuery.Service)),
    )
    const recap = yield* Layer.build(SessionRecap.layer).pipe(
      Effect.provideService(Instance.Service, instances),
      Effect.provideService(SideQuery.Service, sideQuery),
      Effect.map((services) => Context.get(services, SessionRecap.Service)),
    )
    return { db, bus, store, sideQuery, recap }
  })

const usage = { inputTokens: 1000, nonCachedInputTokens: 1000, outputTokens: 100, visibleOutputTokens: 100 }
const answer = (text: string) =>
  TestLLM.complete(
    { reason: { normalized: "stop" }, usage },
    LLMEvent.textStart({ id: "t" }),
    LLMEvent.textDelta({ id: "t", text }),
    LLMEvent.textEnd({ id: "t" }),
  )

const userTexts = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )

const allText = (request: LLMRequest | undefined) =>
  JSON.stringify([request?.system ?? [], request?.messages ?? []])

const say = (bus: Bus.Interface, text: string) =>
  Effect.gen(function* () {
    const inboxID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID,
      item: { type: "user", payload: { text }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID })
  })

const recordedRecaps = (db: Database.Interface["db"]) =>
  db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.filter(
          (row) =>
            row.type ===
            Event.versionedType(SessionEventSchema.RecapRecorded.type, SessionEventSchema.RecapRecorded.durable.version),
        ),
      ),
    )

const sideQueryPurposes = (db: Database.Interface["db"]) =>
  db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.flatMap((row) =>
          row.type ===
          Event.versionedType(
            SessionEventSchema.SideQueryRecorded.type,
            SessionEventSchema.SideQueryRecorded.durable.version,
          )
            ? [(row.data as { purpose: string }).purpose]
            : [],
        ),
      ),
    )

it.effect(
  "a recap asks the small model once with the last 30 messages, no system prompt, no tools and the instruction last",
  () =>
    Effect.gen(function* () {
      toolDefinitions = [ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } })]
      const { bus, db, store, recap } = yield* setup()
      const test = yield* TestLLM.Test
      for (const index of Array.from({ length: 40 }, (_, item) => item + 1)) yield* say(bus, `message ${index}`)
      yield* test.push(answer("Building the parser. Next: wire the tests."))

      const result = yield* recap.generate(sessionID)

      expect(result).toEqual({ text: "Building the parser. Next: wire the tests." })
      const requests = yield* test.requests()
      expect(requests).toHaveLength(1)
      const request = requests[0]
      // The small model of the session's provider, at its least-reasoning variant: thinking is off.
      expect(String(request?.model.id)).toBe("recap-small")
      expect(selections).toContainEqual({ id: "recap-small", variant: "none" })
      // No system prompt and no tools, even though the session has some.
      expect(request?.system).toEqual([])
      expect(request?.tools).toEqual([])
      // A recap writes no prompt cache entry.
      expect(request?.cache).toBe("none")
      const texts = userTexts(request)
      expect(texts).toHaveLength(31)
      expect(texts.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, item) => `message ${item + 11}`))
      // The instruction is one terse paragraph after the history. There are no session notes in M5, so no notes block.
      const instruction = texts.at(-1) ?? ""
      expect(instruction.trim().length).toBeGreaterThan(0)
      expect(instruction).not.toContain("\n\n")
      expect(instruction.length).toBeLessThan(600)

      // One durable fact, projected as a recap message after the last user message.
      expect(yield* recordedRecaps(db)).toHaveLength(1)
      const messages = yield* store.messages({ sessionID, order: "asc" })
      expect(messages.at(-1)).toMatchObject({ type: "recap", text: "Building the parser. Next: wire the tests." })
      // The spend lands on the session under the away-summary purpose.
      expect(yield* sideQueryPurposes(db)).toEqual(["session.away_summary"])
    }),
)

it.effect("agents.side.model, the person's own choice for side work, is used for the recap", () =>
  Effect.gen(function* () {
    const { bus, recap } = yield* setup({ pinned: true })
    const test = yield* TestLLM.Test
    yield* say(bus, "Fix the build")
    yield* test.push(answer("Fixing the build."))

    yield* recap.generate(sessionID)

    expect((yield* test.requests()).map((request) => String(request.model.id))).toEqual(["recap-pinned"])
  }),
)

it.effect("a provider with no small model gets no recap: the primary model is never used for one", () =>
  Effect.gen(function* () {
    small = undefined
    const { bus, db, recap } = yield* setup()
    const test = yield* TestLLM.Test
    yield* say(bus, "Fix the build")
    yield* test.push(answer("should not be asked"))

    expect(yield* recap.generate(sessionID)).toBeUndefined()

    expect(yield* test.requests()).toHaveLength(0)
    expect(yield* recordedRecaps(db)).toHaveLength(0)
  }),
)

it.effect("an empty session gets no recap and makes no call", () =>
  Effect.gen(function* () {
    const { db, recap } = yield* setup()
    const test = yield* TestLLM.Test
    yield* test.push(answer("should not be asked"))

    expect(yield* recap.generate(sessionID)).toBeUndefined()

    expect(yield* test.requests()).toHaveLength(0)
    expect(yield* recordedRecaps(db)).toHaveLength(0)
  }),
)

it.effect("a session that does not exist is a NotFoundError and makes no call", () =>
  Effect.gen(function* () {
    const { recap } = yield* setup()
    const test = yield* TestLLM.Test

    const error = yield* recap.generate(SessionSchema.ID.make("ses_recap_missing")).pipe(Effect.flip)

    expect(error._tag).toBe("Session.NotFoundError")
    expect(yield* test.requests()).toHaveLength(0)
  }),
)

it.effect(
  "one recap per user turn: a notice or a repeat does not reset it, a prompt or the person's own shell command does",
  () =>
    Effect.gen(function* () {
      const { bus, db, recap } = yield* setup()
      const test = yield* TestLLM.Test
      yield* say(bus, "Fix the build")
      yield* test.push(answer("first"), answer("second"), answer("third"), answer("unused"))

      expect(yield* recap.generate(sessionID)).toEqual({ text: "first" })
      // Asked again with nothing new from the person: no call.
      expect(yield* recap.generate(sessionID)).toBeUndefined()
      // A notice (a synthetic message) is not the person's input.
      yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: "<shell>done</shell>", description: "Shell finished" })
      expect(yield* recap.generate(sessionID)).toBeUndefined()
      expect(yield* test.requests()).toHaveLength(1)

      // A new prompt starts a new turn.
      yield* say(bus, "Now the tests")
      expect(yield* recap.generate(sessionID)).toEqual({ text: "second" })

      // So does a command the person ran with `!`, as the reference's bash input is a user message.
      yield* bus.publish(SessionEvent.Shell.Started, {
        sessionID,
        shell: {
          id: Shell.ID.create(),
          status: "running",
          command: "bun test",
          cwd: "/project",
          shell: "bash",
          file: "/tmp/out",
          metadata: {},
          time: { started: 1 },
        },
      })
      expect(yield* recap.generate(sessionID)).toEqual({ text: "third" })
      expect(yield* test.requests()).toHaveLength(3)
      expect(yield* recordedRecaps(db)).toHaveLength(3)
    }),
)

it.effect("two clients asking at once make one call", () =>
  Effect.gen(function* () {
    const { bus, db, recap } = yield* setup()
    const test = yield* TestLLM.Test
    yield* say(bus, "Fix the build")
    // Two answers, so that a second call would be answered and counted rather than hang.
    yield* test.push(answer("one"), answer("two"))
    const gate = yield* test.gate()

    const first = yield* recap.generate(sessionID).pipe(Effect.forkChild)
    yield* gate.started
    const second = yield* recap.generate(sessionID).pipe(Effect.forkChild)
    yield* gate.release
    const results = [yield* Fiber.join(first), yield* Fiber.join(second)]

    expect(yield* test.requests()).toHaveLength(1)
    expect(yield* recordedRecaps(db)).toHaveLength(1)
    expect(results.filter((result) => result !== undefined)).toEqual([{ text: "one" }])
  }),
)

it.effect("a recap the person came back during is dropped: interrupting it records nothing", () =>
  Effect.gen(function* () {
    const { bus, db, recap } = yield* setup()
    const test = yield* TestLLM.Test
    yield* say(bus, "Fix the build")
    yield* test.push(answer("late"))
    const gate = yield* test.gate()

    const fiber = yield* recap.generate(sessionID).pipe(Effect.forkChild)
    yield* gate.started
    yield* Fiber.interrupt(fiber)

    expect(yield* recordedRecaps(db)).toHaveLength(0)
    // The next request is not blocked by the one that was dropped.
    yield* gate.release
    yield* test.push(answer("again"))
    expect(yield* recap.generate(sessionID)).toEqual({ text: "again" })
  }),
)

it.effect("a provider failure or a blank answer gives no recap and does not fail", () =>
  Effect.gen(function* () {
    const { bus, db, recap } = yield* setup()
    const test = yield* TestLLM.Test
    yield* say(bus, "Fix the build")
    yield* test.push(answer("   \n "), TestLLM.tool("call_1", "lookup", {}))

    expect(yield* recap.generate(sessionID)).toBeUndefined()
    expect(yield* recap.generate(sessionID)).toBeUndefined()

    expect(yield* recordedRecaps(db)).toHaveLength(0)
  }),
)

// Class 9: the recap is model text drawn from repository content. It is escaped when it is stored, so every client
// that reads the event or the message (TUI, Mini, SDK, JSON) gets text that cannot act on a terminal.
it.effect("the stored recap has its control and bidi characters written out, and it never reaches a model", () =>
  Effect.gen(function* () {
    const { bus, db, store, sideQuery, recap } = yield* setup()
    const test = yield* TestLLM.Test
    yield* say(bus, "Fix the build")
    yield* test.push(
      answer("Fixing\u001b]0;pwned\u0007 the build\u202e.\u009b2J\nNext: tests."),
      answer("second"),
      answer("plain"),
    )

    const result = yield* recap.generate(sessionID)

    // ESC and BEL (an OSC title sequence), a C1 CSI and a right-to-left override are written out; the line break stays.
    expect(result?.text).toBe("Fixing\\x1b]0;pwned\\x07 the build\\u{202e}.\\x9b2J\nNext: tests.")
    const [row] = yield* recordedRecaps(db)
    const stored = (row?.data as { text: string }).text
    expect(stored).toBe(result?.text ?? "")
    expect(stored).not.toMatch(/[\u001b\u0007\u009b\u202e]/)
    const message = (yield* store.messages({ sessionID, order: "asc" })).at(-1)
    expect(message).toMatchObject({ type: "recap", text: result?.text })

    // The next recap and any request built from the session's history leave the recap out.
    yield* say(bus, "Now the tests")
    yield* recap.generate(sessionID)
    yield* sideQuery.text({ sessionID, purpose: "memory.recall", system: "Answer.", prompt: "What?", history: true })
    const [, nextRecap, historyQuery] = yield* test.requests()
    expect(allText(nextRecap)).not.toContain("pwned")
    expect(allText(historyQuery)).not.toContain("pwned")
    expect(userTexts(historyQuery)).toContain("Now the tests")
  }),
)
