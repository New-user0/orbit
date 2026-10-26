import { expect, test } from "bun:test"
import {
  AIError,
  CompactionCheckpointResponse,
  GenerationOptions,
  InvalidRequestError,
  LLMClient,
  LLMEvent,
  LanguageModel,
  Message,
  ToolDefinition,
  type LLMRequest,
} from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { OpenAI } from "@orbit/ai/providers"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Bus } from "@orbit/core/bus"
import { EventTable } from "@orbit/core/event/sql"
import { SessionCompaction } from "@orbit/core/session/compaction"
import type { SessionContext } from "@orbit/core/session/context"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionModelRequest } from "@orbit/core/session/model-request"
import { SessionReminders } from "@orbit/core/session/reminders"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionTable, SessionUsageTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { Session } from "@orbit/core/session"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { App } from "@orbit/core/app"
import { Agent } from "@orbit/core/agent"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Money } from "@orbit/schema/money"
import { Skill } from "@orbit/schema/skill"
import { Shell } from "@orbit/schema/shell"
import { Context, DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { stubSnapshot } from "./lib/tool"

let requests: LLMRequest[] = []
const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
// When set, the provider answers with this instead of the summary.
let override: (() => Stream.Stream<LLMEvent>) | undefined
// When not empty, each request takes the next scripted answer, ahead of `override`.
let replies: Array<() => Stream.Stream<LLMEvent>> = []
// Each native compaction call takes the next of these.
let checkpoints: Array<() => Effect.Effect<CompactionCheckpointResponse, AIError>> = []
const client = Layer.mock(LLMClient.Service)({
  // Only the trigger form is scripted; an arrow function cannot spell the overloads, hence the cast.
  compact: ((request: LLMRequest) => {
    requests.push(request)
    return checkpoints.shift()?.() ?? Effect.die("no scripted native compaction")
  }) as unknown as Context.Service.Shape<typeof LLMClient.Service>["compact"],
  stream: (request: LLMRequest) => {
    requests.push(request)
    const scripted = replies.shift()
    if (scripted) return scripted()
    if (override) return override()
    return Stream.make(
      LLMEvent.textDelta({ id: "summary", text: "## Objective\n- manual summary" }),
      LLMEvent.stepFinish({
        index: 0,
        reason: { normalized: "stop" },
        usage: {
          inputTokens: 15,
          outputTokens: 6,
          nonCachedInputTokens: 10,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          reasoningTokens: 2,
        },
      }),
      LLMEvent.finish({
        reason: { normalized: "stop" },
      }),
    )
  },
  generate: () => Effect.die("unused"),
})
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  cost,
  limit: { context: 200_000, output: 32_000 },
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      SessionReminders.node.replace(SessionReminders.configured(SessionReminders.production)),
    ],
  ),
)

const lean = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionCompaction.node,
      SessionModelRequest.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      SessionReminders.node.replace(SessionReminders.configured(SessionReminders.minimal(SessionReminders.production))),
    ],
  ),
)

lean.effect("a minimal instance's summary request carries neither the hint nor the editor note", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_lean_compaction"))
    const prompt = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Lean compaction keeps this text.",
      agents: [{ name: "helper" }],
      editor: { path: "/project/src/open-file.ts" },
      time: { created: DateTime.makeUnsafe(0) },
    })
    expect(yield* compactManually(session, [prompt])).toEqual({ status: "completed" })
    const sent = JSON.stringify(requests[0]?.messages)
    expect(sent).toContain("Lean compaction keeps this text.")
    expect(sent).not.toContain("agent named below")
    expect(sent).not.toContain("open-file.ts")
  }),
)

test("compaction prompt asks for the files, the work in progress and the next step", () => {
  const prompt = SessionCompaction.buildPrompt()

  expect(prompt).toContain("3. Files and code")
  expect(prompt).toContain("8. Work in progress")
  expect(prompt).toContain("9. Next step")
})

test("compaction prompt prohibits tool calls at both ends", () => {
  const prompt = SessionCompaction.buildPrompt()

  expect(prompt.startsWith("IMPORTANT: Reply with text only. No tool calls.")).toBe(true)
  expect(prompt).toEndWith("Any tool call is turned down and the handoff is lost.")
})

it.effect("auto compaction estimates current content against the threshold below the effective window", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_input_limit"))
    const input = (tokens: number, limit: { context: number; input?: number; output: number }) => ({
      session,
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
        cost: [],
        limit,
      }),
      messages: [
        Schema.decodeUnknownSync(SessionMessage.Assistant)({
          id: SessionMessage.ID.make("msg_assistant"),
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: "summary-model", providerID: "test" },
          content: [{ type: "text", text: "Done" }],
          tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, completed: 0 },
        }),
      ],
      agent: {
        id: Agent.defaultID,
        info: { ...Agent.Info.default(Agent.defaultID), system: "You are a helpful assistant." },
      },
      initial: "Project instructions.",
      tools: stubSnapshot({
        definitions: [
          ToolDefinition.make({ name: "Read", description: "Read files", inputSchema: { type: "object" } }),
        ],
        execute: () => Effect.die("unused"),
      }),
    })
    // An automatic compaction that is not due is skipped.
    const due = (context: SessionContext.Loaded) =>
      compaction.compact({ reason: "auto", context }).pipe(Effect.map((outcome) => outcome.status !== "skipped"))

    // The input limit takes precedence over the context window.
    const inputLimited = { context: 400_000, input: 272_000, output: 128_000 }
    expect(yield* due(input(238_999, inputLimited))).toBe(false)
    expect(yield* due(input(239_000, inputLimited))).toBe(true)
    const native = (tokens: number, limit: { context: number; input?: number; output: number } = inputLimited) => {
      const selected = input(tokens, limit)
      return { ...selected, model: { ...selected.model, compaction: { type: "native" as const } } }
    }
    expect(yield* due(native(238_999))).toBe(false)
    expect(yield* due(native(239_000))).toBe(true)
    expect(yield* due(native(1_000_000, { context: 0, input: undefined, output: 0 }))).toBe(false)

    // The summary keeps the model's 10k output limit free and 13k more below that.
    const contextLimited = { context: 100_000, output: 10_000 }
    expect(yield* due(input(76_999, contextLimited))).toBe(false)
    expect(yield* due(input(77_000, contextLimited))).toBe(true)

    // A larger output limit keeps no more than 20k free.
    const outputLimited = { context: 100_000, output: 30_000 }
    expect(yield* due(input(66_999, outputLimited))).toBe(false)
    expect(yield* due(input(67_000, outputLimited))).toBe(true)

    const assistant = input(89_000, contextLimited).messages[0]
    const tool = SessionMessage.AssistantTool.make({
      type: "tool",
      id: "call_read",
      name: "Read",
      state: { status: "completed", input: {}, content: [{ type: "text", text: "x".repeat(4_000) }] },
      time: { created: DateTime.makeUnsafe(0) },
    })
    const grown = { ...input(89_000, contextLimited), messages: [{ ...assistant, content: [tool] }] }
    expect(SessionCompaction.estimateContext(grown)).toBe(90_000)
    expect(yield* due(grown)).toBe(true)

    const interrupted = { ...assistant, id: SessionMessage.ID.create(), tokens: undefined }
    expect(SessionCompaction.estimateContext({ ...grown, messages: [...grown.messages, interrupted] })).toBe(90_001)
    // Without provider usage, include 20 tokens for the system prompt, instructions, and tool definition.
    expect(SessionCompaction.estimateContext({ ...grown, messages: [interrupted] })).toBe(21)
    // Another provider's usage is not trusted either.
    const foreign = { ...assistant, model: { ...assistant.model, providerID: Provider.ID.make("other") } }
    expect(SessionCompaction.estimateContext({ ...grown, messages: [foreign] })).toBe(21)
    expect(
      SessionCompaction.estimateContext({
        ...grown,
        messages: [{ ...interrupted, tokens: input(0, contextLimited).messages[0].tokens }],
      }),
    ).toBe(21)

    const media = [
      { type: "file", mime: "image/png", uri: `data:image/png;base64,${"a".repeat(100_000)}` },
      { type: "file", mime: "application/pdf", uri: `data:application/pdf;base64,${"a".repeat(100_000)}` },
    ] as const
    const messages = [
      { ...assistant, content: [{ ...tool, state: { status: "completed" as const, input: {}, content: media } }] },
    ]
    expect(SessionCompaction.estimateContext({ ...grown, messages })).toBe(92_500)
    const user = Schema.decodeUnknownSync(SessionMessage.User)({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "",
      // A queued prompt waited for the work to end, so it carries no mid-turn note to add to the estimate.
      delivery: "queue",
      files: media.map((file) => ({ mime: file.mime, data: "a".repeat(100_000), source: { type: "inline" } })),
      time: { created: 0 },
    })
    expect(SessionCompaction.estimateContext({ ...grown, messages: [...messages, user] })).toBe(96_000)
    for (const [modalities, tokens, fallback] of [
      [["text", "image"], 92_040, 1_520],
      [["text", "pdf"], 93_042, 2_021],
      [["text"], 89_082, 41],
    ] as const) {
      const selected = {
        ...grown,
        model: { ...grown.model, capabilities: { ...grown.model.capabilities, input: modalities } },
      }
      expect(SessionCompaction.estimateContext({ ...selected, messages: [...messages, user] })).toBe(tokens)
      expect(SessionCompaction.estimateContext({ ...selected, messages: [user] })).toBe(fallback + 20)
    }

    const checkpoint = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "x".repeat(400_000),
      recent: "",
      time: { created: 0, completed: 0 },
    })
    expect(yield* due({ ...grown, messages: [checkpoint] })).toBe(false)
  }),
)

// tool-runtime-8: a saved result reaches the model as its wrapper, so compaction measures and summarizes the wrapper and
// not the full text that is in the file.
const savedResult = (sessionID: Session.ID, tokens?: number) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "summary-model", providerID: "test" },
    content: [
      {
        type: "tool",
        id: "call_saved",
        name: "Grep",
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: "r".repeat(60_000) }],
          metadata: {
            persisted: { session: sessionID, name: "msg_0123abc-call_saved-1a2b3c4d.txt", size: 60_000, format: 1 },
          },
        },
        time: { created: 0 },
      },
    ],
    ...(tokens === undefined ? {} : { tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    time: { created: 0, completed: 0 },
  })

it.effect("auto compaction measures a saved tool result by its wrapper", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_saved_estimate"))
    const context = (message: SessionMessage.Info) => ({
      ...loaded(session, [message]),
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 110_000, output: 10_000 },
      }),
    })
    const saved = savedResult(session.id, 80_000)
    const due = (message: SessionMessage.Info) =>
      compaction
        .compact({ reason: "auto", context: context(message) })
        .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
    // The whole text would pass the 87,000-token threshold; the wrapper stays under it.
    expect(yield* due(saved)).toBe(false)
    const content = saved.content.map((part) =>
      part.type === "tool" && part.state.status === "completed"
        ? { ...part, state: { ...part.state, metadata: {} } }
        : part,
    )
    expect(yield* due({ ...saved, content } as SessionMessage.Info)).toBe(true)
  }),
)

it.effect("summary compaction sends a saved tool result as its wrapper", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_saved_summary"))
    const user = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Search the code",
      time: { created: DateTime.makeUnsafe(0) },
    })
    expect(yield* compactManually(session, [user, savedResult(session.id)])).toEqual({ status: "completed" })
    const sent = JSON.stringify(requests[0]?.messages)
    expect(sent).toContain("<saved-output>")
    expect(sent).toContain("msg_0123abc-call_saved-1a2b3c4d.txt")
    expect(sent).not.toContain("r".repeat(2_001))
  }),
)

// tool-runtime-9: a result the message budget replaced reaches every side query as its wrapper too, and a side query
// decides no budget of its own: only the runner publishes replacements.
const overriddenResult = (sessionID: Session.ID, tokens?: number) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "summary-model", providerID: "test" },
    content: [
      {
        type: "tool",
        id: "call_budget",
        name: "Grep",
        state: { status: "completed", input: {}, content: [{ type: "text", text: "r".repeat(60_000) }] },
        override: { session: sessionID, name: "msg_0123abc-call_budget-1a2b3c4d.txt", format: 1 },
        time: { created: 0 },
      },
    ],
    ...(tokens === undefined ? {} : { tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    time: { created: 0, completed: 0 },
  })

it.effect("auto compaction measures an overridden tool result by its wrapper", () =>
  Effect.gen(function* () {
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_override_estimate"))
    const context = (message: SessionMessage.Info) => ({
      ...loaded(session, [message]),
      model: SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 110_000, output: 10_000 },
      }),
    })
    const overridden = overriddenResult(session.id, 80_000)
    const due = (message: SessionMessage.Info) =>
      compaction
        .compact({ reason: "auto", context: context(message) })
        .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
    // The whole text would pass the 87,000-token threshold; the wrapper stays under it.
    expect(yield* due(overridden)).toBe(false)
    const content = overridden.content.map((part) => {
      if (part.type !== "tool") return part
      const { override: _, ...rest } = part as typeof part & { override?: unknown }
      return rest
    })
    expect(yield* due({ ...overridden, content } as SessionMessage.Info)).toBe(true)
  }),
)

it.effect("summary compaction sends an overridden tool result as its wrapper", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_override_summary"))
    const user = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Search the code",
      time: { created: DateTime.makeUnsafe(0) },
    })
    expect(yield* compactManually(session, [user, overriddenResult(session.id)])).toEqual({ status: "completed" })
    const sent = JSON.stringify(requests[0]?.messages)
    // Booleans, so a failure does not print 60,000 characters.
    expect({
      wrapped: sent.includes("<saved-output>"),
      named: sent.includes("msg_0123abc-call_budget-1a2b3c4d.txt"),
      whole: sent.includes("r".repeat(2_001)),
    }).toEqual({ wrapped: true, named: true, whole: false })
  }),
)

it.effect("summary compaction sends a fresh group over the budget whole", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_budget_side_query"))
    const user = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Search the code",
      time: { created: DateTime.makeUnsafe(0) },
    })
    // Five results of 45,000 characters: over the 200,000 default, but only the runner decides a budget.
    const group = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: ["a", "b", "c", "d", "e"].map((letter) => ({
        type: "tool",
        id: `call_${letter}`,
        name: "Grep",
        state: { status: "completed", input: {}, content: [{ type: "text", text: letter.repeat(45_000) }] },
        time: { created: 0 },
      })),
      time: { created: 0, completed: 0 },
    })
    expect(yield* compactManually(session, [user, group])).toEqual({ status: "completed" })
    expect(JSON.stringify(requests[0]?.messages).includes("<saved-output>")).toBe(false)
  }),
)

/** Seeds the global project plus one session row, returning the projected session. */
const insertSession = (id: Session.ID, overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        ...overrides,
      })
      .run()
      .pipe(Effect.orDie)
    const store = yield* SessionStore.Service
    return yield* store
      .get(id)
      .pipe(Effect.flatMap((session) => (session ? Effect.succeed(session) : Effect.die(`session missing: ${id}`))))
  })

const loaded = (session: Session.Info, messages: readonly SessionMessage.Info[]) => ({
  session,
  messages,
  model: resolved,
  agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
  initial: "Session instructions",
  tools: stubSnapshot({ definitions: [], execute: () => Effect.die("Compaction must not execute tools") }),
})

/** Opens the compaction's message as the runner does when it delivers `/compact`, then compacts. */
const compactManually = (
  session: Session.Info,
  messages: readonly SessionMessage.Info[],
  inputID = SessionMessage.ID.create(),
) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const compaction = yield* SessionCompaction.Service
    yield* bus.publish(SessionEvent.Compaction.Started, {
      sessionID: session.id,
      reason: "manual",
      recent: "",
      inputID,
    })
    return yield* compaction.compact({ reason: "manual", context: loaded(session, messages), inputID })
  })

/** The recent text a manual compaction keeps when the latest exchange is one tool call with this output. */
it.effect("manual compaction summarizes short context instead of no-op", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_manual_compaction")
    const parentID = Session.ID.make("ses_manual_compaction_parent")
    const userMessage = {
      id: SessionMessage.ID.create(),
      type: "user" as const,
      text: "Manual compaction should include this short conversation.",
      agents: [{ name: "helper" }],
      editor: { path: "/project/src/open-file.ts" },
      skills: [
        {
          id: Skill.ID.make("effect"),
          name: Skill.Name.make("Effect"),
          text: "Use Effect services and generators.",
        },
      ],
      time: { created: DateTime.makeUnsafe(0) },
    }
    const session = yield* insertSession(sessionID, { parent_id: parentID })
    const hooks = yield* PluginHooks.Service
    let hooked = 0
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        hooked = event.messages.length
        expect(JSON.stringify(event.messages)).not.toContain("IMPORTANT: Reply with text only")
      }),
    )
    const messages = [
      userMessage,
      SessionMessage.Shell.make({
        id: SessionMessage.ID.create(),
        type: "shell",
        shellID: Shell.ID.make("sh_background"),
        status: "exited",
        command: "pwd",
        metadata: { background: true },
        output: { output: "display-only-output", cursor: 19, size: 19, truncated: false },
        time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(1) },
      }),
      SessionMessage.Synthetic.make({
        id: SessionMessage.ID.create(),
        type: "synthetic",
        text: "User shell pwd completed: /project",
        time: { created: DateTime.makeUnsafe(2) },
      }),
    ]

    const delta = yield* bus
      .subscribe(SessionEvent.Compaction.Delta)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_manual_compaction"))).toEqual({
      status: "completed",
    })
    expect(Array.from(yield* Fiber.join(delta)).map((event) => event.data.text)).toEqual([
      "## Objective\n- manual summary",
    ])

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(parentID)
    expect(requests[0]?.http?.headers).toEqual({ "User-Agent": App.useragent(App.make()) })
    expect(requests[0]?.generation).toEqual(GenerationOptions.make({ maxTokens: 20_000 }))
    expect(JSON.stringify(requests[0]?.messages)).toContain("Manual compaction should include this short conversation.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("Use Effect services and generators.")
    expect(JSON.stringify(requests[0]?.messages)).toContain("User shell pwd completed: /project")
    // A normal instance sends the summary request the way the main request lowers the prompt: hint and editor note stay.
    expect(JSON.stringify(requests[0]?.messages)).toContain("agent named below")
    expect(JSON.stringify(requests[0]?.messages)).toContain("open-file.ts")
    expect(requests[0]?.messages).toHaveLength(hooked + 1)
    expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain("IMPORTANT: Reply with text only")
    expect(JSON.stringify(requests[0]?.messages)).not.toContain("display-only-output")
    // The compaction message carries its own request usage so clients can show what compacting cost.
    expect(yield* store.context(sessionID)).toMatchObject([
      {
        type: "compaction",
        reason: "manual",
        summary: "## Objective\n- manual summary",
        recent: "",
        cost: 0.0000233,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
      },
    ])
    expect(yield* store.get(sessionID)).toMatchObject({
      cost: 0.0000233,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
    })
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.UsageRecorded.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

it.effect("compaction hooks can supply the summary instead of the model", () =>
  Effect.gen(function* () {
    requests = []
    const db = (yield* Database.Service).db
    const hooks = yield* PluginHooks.Service
    const store = yield* SessionStore.Service
    const sessionID = Session.ID.make("ses_hooked_compaction")
    const session = yield* insertSession(sessionID)
    const messages = [
      {
        id: SessionMessage.ID.create(),
        type: "user" as const,
        text: "Hooked compaction should see this conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      },
    ]
    let contexts = 0
    yield* hooks.register("session", "context", () => Effect.sync(() => contexts++))
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        expect(event.sessionID).toBe(sessionID)
        expect(event.agent).toBe(Agent.defaultID)
        expect(JSON.stringify(event.messages)).toContain("Hooked compaction should see this conversation.")
        event.result = { summary: "## Objective\n- hooked summary" }
      }),
    )

    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_hooked_compaction"))).toEqual({
      status: "completed",
    })

    expect(contexts).toBe(0)
    expect(requests).toEqual([])
    expect(yield* store.context(sessionID)).toMatchObject([
      { type: "compaction", reason: "manual", summary: "## Objective\n- hooked summary", recent: "" },
    ])
    expect(
      yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([
      { type: Bus.versionedType(SessionEvent.Compaction.Started.type, 1) },
      { type: Bus.versionedType(SessionEvent.Compaction.Ended.type, 1) },
    ])
  }),
)

// FU-M2-015: a summary call that began and was cut off was probably billed, so an estimate keeps it from reading as free.
for (const [name, stream, records] of [
  [
    "after the response began",
    () =>
      Stream.make(
        LLMEvent.textDelta({ id: "summary", text: "## Objective\n- half a summary" }),
        LLMEvent.providerError({ message: "The provider stopped the response" }),
      ),
    true,
  ],
  ["before any response", () => Stream.make(LLMEvent.providerError({ message: "The provider refused" })), false],
] as const)
  it.effect(`compaction records an estimated spend for a stream that failed ${name}: ${records}`, () =>
    Effect.gen(function* () {
      requests = []
      const db = (yield* Database.Service).db
      const sessionID = Session.ID.make(`ses_failed_compaction_${records}`)
      const session = yield* insertSession(sessionID)
      override = stream
      const result = yield* compactManually(
        session,
        [
          {
            id: SessionMessage.ID.create(),
            type: "user" as const,
            text: "Summarize this conversation, which will fail.",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        SessionMessage.ID.make(`msg_failed_compaction_${records}`),
      ).pipe(Effect.ensuring(Effect.sync(() => (override = undefined))))

      expect(result.status).toBe("failed")
      const rows = yield* db
        .select()
        .from(SessionUsageTable)
        .where(eq(SessionUsageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows.length > 0).toBe(records)
      for (const row of rows) {
        expect(row.source).toBe("compaction")
        expect(row.tokens_input).toBeGreaterThan(0)
        expect(row.tokens_output).toBeGreaterThan(0)
        expect(row.cost).toBeGreaterThan(0)
      }
    }),
  )

// A hook that supplies the summary ran no model: tokens it does not report are no spend, and are not recorded as one.
for (const [name, tokens, records] of [
  ["no tokens", { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 0],
  ["tokens", { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, 1],
] as const)
  it.effect(`compaction records ${records} usage when a hook supplies the summary with ${name}`, () =>
    Effect.gen(function* () {
      requests = []
      const db = (yield* Database.Service).db
      const hooks = yield* PluginHooks.Service
      const sessionID = Session.ID.make(`ses_hook_tokens_${records}`)
      const session = yield* insertSession(sessionID)
      yield* hooks.register("session", "compaction", (event) =>
        Effect.sync(() => {
          event.result = { summary: "## Objective\n- hooked summary", tokens }
        }),
      )

      yield* compactManually(
        session,
        [
          {
            id: SessionMessage.ID.create(),
            type: "user" as const,
            text: "Hooked compaction.",
            time: { created: DateTime.makeUnsafe(0) },
          },
        ],
        SessionMessage.ID.make(`msg_hook_tokens_${records}`),
      )

      const rows = yield* db
        .select()
        .from(SessionUsageTable)
        .where(eq(SessionUsageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(records)
    }),
  )

it.effect("native compaction fails without a model call on a route that cannot compact", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_native_unsupported"))
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Compact this natively.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    expect(
      yield* compaction.compact({
        reason: "manual",
        context: { ...loaded(session, messages), model: { ...resolved, compaction: { type: "native" } } },
        inputID: SessionMessage.ID.create(),
      }),
    ).toEqual({
      status: "failed",
      error: {
        type: "provider.unsupported-operation",
        message: "Native compaction is not supported for test/openai-chat",
      },
    })
    expect(requests).toHaveLength(0)
  }),
)

it.effect("forked session compaction reuses the fork root prompt cache key", () =>
  Effect.gen(function* () {
    requests = []
    const sessionID = Session.ID.make("ses_fork_compaction")
    const rootID = Session.ID.make("ses_fork_compaction_root")
    const session = yield* insertSession(sessionID, {
      fork_session_id: rootID,
      fork_boundary: { type: "before", messageID: SessionMessage.ID.create() },
    })
    const messages = [
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: "Summarize the forked conversation.",
        time: { created: DateTime.makeUnsafe(0) },
      }),
    ]
    expect(yield* compactManually(session, messages, SessionMessage.ID.make("msg_fork_compaction"))).toEqual({
      status: "completed",
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.promptCacheKey).toBe(rootID)
  }),
)

/** A cut-off attempt, the output-escalation notice that replaces it, then the answer that followed. */
const escalatedHistory = (tokens = 0) => {
  const user = SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text: "Question",
    time: { created: DateTime.makeUnsafe(0) },
  })
  const assistant = (id: SessionMessage.ID, text: string, input: number) =>
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id,
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [{ type: "text", text }],
      tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    })
  const cut = assistant(SessionMessage.ID.create(), "FirstCutText", tokens)
  const notice = SessionMessage.Synthetic.make({
    id: SessionMessage.ID.create(),
    type: "synthetic",
    text: "escalated",
    metadata: { notice: "output-escalation", replaces: cut.id },
    time: { created: DateTime.makeUnsafe(1) },
  })
  return { user, cut, notice, answer: assistant(SessionMessage.ID.create(), "WholeAnswerText", 0) }
}

it.effect("summary compaction leaves out an escalated attempt and its notice", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_escalated_summary"))
    const history = escalatedHistory()
    expect(yield* compactManually(session, [history.user, history.cut, history.notice, history.answer])).toEqual({
      status: "completed",
    })
    const sent = JSON.stringify(requests[0]?.messages)
    expect(sent).toContain("WholeAnswerText")
    expect(sent).not.toContain("FirstCutText")
    expect(sent).not.toContain("escalated")
  }),
)

it.effect("native compaction finds nothing to compact in a replaced attempt", () =>
  Effect.gen(function* () {
    requests = []
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_escalated_native"))
    const history = escalatedHistory()
    expect(
      yield* compaction.compact({
        reason: "manual",
        context: {
          ...loaded(session, [history.cut, history.notice]),
          model: { ...resolved, compaction: { type: "native" } },
        },
        inputID: SessionMessage.ID.create(),
      }),
    ).toMatchObject({ status: "failed", error: { type: "compaction.unavailable" } })
  }),
)

it.effect("a replaced attempt is not the measured anchor of a prompt estimate", () =>
  Effect.gen(function* () {
    const session = yield* insertSession(Session.ID.make("ses_escalated_estimate"))
    const history = escalatedHistory(40_000)
    const estimate = SessionCompaction.estimatePrompt(
      loaded(session, [history.user, history.cut, history.notice, history.answer]),
    )
    expect(estimate.measured).toBe(0)
  }),
)

it.effect("a minimal estimate leaves out the editor selection that the full estimate counts", () =>
  Effect.gen(function* () {
    const session = yield* insertSession(Session.ID.make("ses_minimal_estimate"))
    const user = SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Question",
      editor: { path: "/p/a.ts", selection: { start: 1, end: 2, text: "x".repeat(1800) } },
      time: { created: DateTime.makeUnsafe(0) },
    })
    const context = loaded(session, [user])
    expect(SessionCompaction.estimatePrompt(context, true).estimated).toBeLessThan(
      SessionCompaction.estimatePrompt(context, false).estimated,
    )
  }),
)

it.effect("a summary request for an unknown window is sent whole, with nothing shrunk to fit", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_unknown_window_cap"))
    const messages = Array.from({ length: 9 }, (_, index) =>
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: `marker-${index} ${"a".repeat(110_000)}`,
        time: { created: DateTime.makeUnsafe(index) },
      }),
    )
    const context = {
      ...loaded(session, messages),
      model: { ...resolved, limit: { context: 0, output: 8_192 } },
    }
    const compaction = yield* SessionCompaction.Service
    const bus = yield* Bus.Service
    const inputID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Compaction.Started, {
      sessionID: session.id,
      reason: "manual",
      recent: "",
      inputID,
    })
    expect(yield* compaction.compact({ reason: "manual", context, inputID })).toEqual({ status: "completed" })

    expect(requests).toHaveLength(1)
    const sent = JSON.stringify(requests[0]?.messages)
    expect(sent).toContain("marker-0 ")
    expect(sent).toContain("marker-8 ")
    // Nothing is known to size the output against, so it keeps the model's own limit.
    expect(requests[0]?.generation?.maxTokens).toBe(8_192)
  }),
)

// context-memory-2: the summary prompt, what is stored from the reply, the fallback request and the prompt-too-long
// retry. The section headings, the error texts and the placeholder are the spec's (ref-specs/context-memory-2.md).

const SECTIONS = [
  "Requests and intent",
  "Technical context",
  "Files and code",
  "Problems and fixes",
  "Problems worked through",
  "User messages",
  "Open tasks",
  "Work in progress",
  "Next step",
]
const NO_SUMMARY = "Compaction produced no summary"
const TOO_LONG = "The conversation is too long to compact. Go back a few messages and try again."

const usage = {
  inputTokens: 15,
  outputTokens: 6,
  nonCachedInputTokens: 10,
  cacheReadInputTokens: 3,
  cacheWriteInputTokens: 2,
  reasoningTokens: 2,
}
const answer =
  (text: string, finish: "stop" | "length" = "stop") =>
  () =>
    Stream.make(
      LLMEvent.textDelta({ id: "summary", text }),
      LLMEvent.stepFinish({ index: 0, reason: { normalized: finish }, usage }),
      LLMEvent.finish({ reason: { normalized: finish } }),
    )
const toolCallOnly = () =>
  Stream.make(
    LLMEvent.toolCall({ id: "call_summary_read", name: "Read", input: { path: "/project/a.ts" } }),
    LLMEvent.stepFinish({ index: 0, reason: { normalized: "tool-calls" }, usage }),
    LLMEvent.finish({ reason: { normalized: "tool-calls" } }),
  )
const silent = () =>
  Stream.make(
    LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" }, usage }),
    LLMEvent.finish({ reason: { normalized: "stop" } }),
  )
const tooLong = (message: string) => () =>
  Stream.make(LLMEvent.providerError({ message, classification: "context-overflow" }))

const textOf = (message: LLMRequest["messages"][number] | undefined) =>
  (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("")
/** The compaction prompt: the user message appended after the conversation. */
const promptOf = (request: LLMRequest | undefined) => textOf(request?.messages.at(-1))
const paragraphsOf = (prompt: string) => prompt.split(/\n\s*\n/).filter((paragraph) => paragraph.trim())

const userText = (text: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })
const assistantText = (text: string) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.defaultID,
    model: { id: "summary-model", providerID: "test" },
    content: [{ type: "text", text }],
    time: { created: 0, completed: 0 },
  })
const previousCheckpoint = (summary: string) =>
  Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)({
    id: SessionMessage.ID.create(),
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary,
    recent: "",
    time: { created: 0, completed: 0 },
  })

/** Runs a manual compaction with scripted answers, returning the outcome, the requests and what was stored. */
const scripted = (
  name: string,
  messages: readonly SessionMessage.Info[],
  answers: Array<() => Stream.Stream<LLMEvent>>,
  options: { instructions?: string; context?: (context: ReturnType<typeof loaded>) => SessionContext.Loaded } = {},
) =>
  Effect.gen(function* () {
    requests = []
    replies = [...answers]
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make(name))
    const inputID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Compaction.Started, {
      sessionID: session.id,
      reason: "manual",
      recent: "",
      inputID,
    })
    const base = loaded(session, messages)
    const context = options.context ? options.context(base) : base
    // `instructions` is the trigger field this task adds; the base ignores it.
    const trigger = { reason: "manual" as const, context, inputID, instructions: options.instructions }
    const outcome = yield* compaction.compact(trigger).pipe(Effect.ensuring(Effect.sync(() => (replies = []))))
    const stored = (yield* store.context(session.id))[0]
    const completed = stored?.type === "compaction" && stored.status === "completed" ? stored : undefined
    const events = yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, session.id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    return { outcome, sent: [...requests], summary: completed?.summary, recent: completed?.recent, events }
  })

it.effect("the compaction prompt opens and closes with the no-tools rule and asks for an analysis then a handoff", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_prompt",
      [userText("Plan the migration")],
      [answer("<handoff>\nok\n</handoff>")],
    )
    const prompt = promptOf(run.sent[0])
    const paragraphs = paragraphsOf(prompt)
    const preamble = paragraphs.slice(0, 2).join("\n\n")
    // The preamble comes first and the trailer last: each forbids tools and names both blocks.
    for (const part of [preamble, paragraphs.at(-1) ?? ""]) {
      expect(part).toMatch(/tool/i)
      expect(part).toContain("<analysis>")
      expect(part).toContain("<handoff>")
    }
    // The analysis instruction comes before the nine sections, which are listed and then shown in the example.
    const analysis = prompt.indexOf("<analysis>", prompt.indexOf(preamble) + preamble.length)
    const listed = SECTIONS.map((section, index) => prompt.indexOf(`${index + 1}. ${section}`))
    expect(analysis).toBeGreaterThan(0)
    expect(listed.every((at) => at > analysis)).toBe(true)
    expect(listed).toEqual([...listed].sort((a, b) => a - b))
    const example = prompt.indexOf("<example>")
    const handoff = prompt.indexOf("<handoff>", example)
    const shown = SECTIONS.map((section, index) => prompt.indexOf(`${index + 1}. ${section}`, handoff))
    expect(example).toBeGreaterThan(listed[8])
    expect(shown.every((at) => at > handoff)).toBe(true)
    expect(shown).toEqual([...shown].sort((a, b) => a - b))
    expect(prompt.indexOf("</handoff>", handoff)).toBeGreaterThan(shown[8])
    // The closing note tells the model to follow summary instructions it finds in the context.
    expect(prompt.slice(prompt.indexOf("</example>", handoff))).toMatch(/instructions/i)
  }),
)

it.effect("every summary compaction sends the one base prompt, a previous checkpoint included", () =>
  Effect.gen(function* () {
    const first = yield* scripted(
      "ses_cm2_first",
      [userText("Start the work")],
      [answer("<handoff>\nfirst\n</handoff>")],
    )
    const again = yield* scripted(
      "ses_cm2_again",
      [previousCheckpoint("PREVIOUS-SUMMARY"), userText("Continue the work")],
      [answer("<handoff>\nsecond\n</handoff>")],
    )
    expect(promptOf(again.sent[0])).toBe(promptOf(first.sent[0]))
    // The previous summary is summarized again with everything after it.
    const history = JSON.stringify(again.sent[0]?.messages.slice(0, -1))
    expect(history).toContain("PREVIOUS-SUMMARY")
    expect(history).toContain("Continue the work")
  }),
)

it.effect("a summary compaction keeps no verbatim tail and summarizes the latest exchange too", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_no_tail",
      [
        userText("OLDER-REQUEST"),
        assistantText("older answer"),
        userText("LATEST-REQUEST"),
        assistantText("latest answer"),
      ],
      [answer("<handoff>\nsummary\n</handoff>")],
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.recent).toBe("")
    const history = JSON.stringify(run.sent[0]?.messages.slice(0, -1))
    expect(history).toContain("LATEST-REQUEST")
    expect(history).toContain("latest answer")
  }),
)

// Plan test: analysis never stored. A closed block, a second block and a block cut off by the output limit are all
// removed, and no durable event carries them.
for (const [name, text, finish] of [
  ["a closed analysis", "<analysis>\nDRAFT-A\n</analysis>\n\n<handoff>\n## Objective\n- keep\n</handoff>", "stop"],
  [
    "a second analysis",
    "<analysis>DRAFT-A</analysis>\n<handoff>\n## Objective\n- keep\n</handoff>\n<analysis>DRAFT-B</analysis>",
    "stop",
  ],
  [
    "an analysis cut off by the output limit",
    "<handoff>\n## Objective\n- keep\n</handoff>\n<analysis>DRAFT-C cut",
    "length",
  ],
] as const)
  it.effect(`analysis never stored: ${name}`, () =>
    Effect.gen(function* () {
      const run = yield* scripted(
        `ses_cm2_analysis_${name.replaceAll(" ", "_")}`,
        [userText("Do it")],
        [answer(text, finish)],
      )
      expect(run.outcome).toEqual({ status: "completed" })
      expect(run.summary).toBe("Summary:\n## Objective\n- keep")
      expect(JSON.stringify(run.events)).not.toContain("DRAFT-")
    }),
  )

it.effect("a reply that is only an unfinished analysis fails as no summary and stores nothing", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_only_analysis",
      [userText("Do it")],
      [answer("<analysis>DRAFT-D cut", "length")],
    )
    expect(run.outcome).toMatchObject({ status: "failed", error: { type: "compaction.failed", message: NO_SUMMARY } })
    expect(run.sent).toHaveLength(1)
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-")
    expect(run.events.map((event) => event.type)).not.toContain(
      Bus.versionedType(SessionEvent.Compaction.Ended.type, 1),
    )
  }),
)

it.effect("the stored summary turns the handoff block into a Summary heading and collapses blank lines", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_format",
      [userText("Do it")],
      [answer("Intro line\n\n\n<handoff>\n\n## Objective\n- a\n\n\n- b\n</handoff>\n")],
    )
    expect(run.summary).toBe("Intro line\n\nSummary:\n## Objective\n- a\n\n- b")
  }),
)

it.effect("a summary that a compaction hook supplies is formatted the same way", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.result = { summary: "<analysis>DRAFT-H</analysis>\n<handoff>\n## Objective\n- hooked\n</handoff>" }
      }),
    )
    const run = yield* scripted("ses_cm2_hook_format", [userText("Do it")], [])
    expect(run.sent).toEqual([])
    expect(run.summary).toBe("Summary:\n## Objective\n- hooked")
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-")
  }),
)

const withTools = (output: number) => (context: ReturnType<typeof loaded>) => ({
  ...context,
  model: { ...context.model, limit: { context: 200_000, output } },
  tools: stubSnapshot({
    definitions: [
      ToolDefinition.make({ name: "Read", description: "Read files", inputSchema: { type: "object" } }),
      ToolDefinition.make({ name: "Shell", description: "Run commands", inputSchema: { type: "object" } }),
    ],
    execute: () => Effect.die("Compaction must not execute tools"),
  }),
})
const withImage = () =>
  Schema.decodeUnknownSync(SessionMessage.User)({
    id: SessionMessage.ID.create(),
    type: "user",
    text: "Look at this screenshot",
    files: [{ mime: "image/png", data: "iVBORw0KGgo=", source: { type: "inline" } }],
    time: { created: 0 },
  })

it.effect("a reply with no text gets one fallback request: one system line, no media, the read tool only", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_fallback",
      [withImage()],
      [toolCallOnly, answer("<handoff>\nfallback\n</handoff>")],
      { context: withTools(12_000) },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(2)
    const [primary, fallback] = run.sent
    // The first request shares the main request's system prompt and tools, media included.
    expect(primary?.tools.map((tool) => tool.name)).toEqual(["Read", "Shell"])
    expect(primary?.messages.some((message) => message.content.some((part) => part.type === "media"))).toBe(true)
    expect(fallback?.system).toHaveLength(1)
    expect(fallback?.system[0]?.text).not.toBe(primary?.system[0]?.text)
    expect(fallback?.tools.map((tool) => tool.name)).toEqual(["Read"])
    expect(fallback?.messages.some((message) => message.content.some((part) => part.type === "media"))).toBe(false)
    expect(JSON.stringify(fallback?.messages)).toContain("[image]")
    expect(fallback?.generation?.maxTokens).toBe(12_000)
    expect(promptOf(fallback)).toBe(promptOf(primary))
    expect(run.summary).toBe("Summary:\nfallback")
  }),
)

it.effect("the fallback is made once: a second reply without text fails as no summary", () =>
  Effect.gen(function* () {
    const run = yield* scripted("ses_cm2_fallback_once", [userText("Do it")], [silent, silent, answer("unused")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toMatchObject({ status: "failed", error: { message: NO_SUMMARY } })
    expect(run.sent).toHaveLength(2)
    expect(run.sent[1]?.system).toHaveLength(1)
  }),
)

it.effect("a first request the provider refuses goes to the fallback", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_refused",
      [userText("Do it")],
      [
        () => Stream.make(LLMEvent.providerError({ message: "The provider refused this request" })),
        answer("<handoff>\nok\n</handoff>"),
      ],
      { context: withTools(32_000) },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(2)
    expect(run.sent[1]?.system).toHaveLength(1)
  }),
)

/** u0 is about 1,000 tokens; each later round group (an assistant reply and the user message after it) is small. */
const rounds = (count: number) => [
  userText(`U0-${"x".repeat(4_000)}`),
  ...Array.from({ length: count }, (_, index) => [
    assistantText(`A${index + 1}-reply`),
    userText(`U${index + 1}-ask`),
  ]).flat(),
]

it.effect("a prompt-too-long rejection drops the oldest round groups covering the reported gap and retries", () =>
  Effect.gen(function* () {
    const gap = tooLong("prompt is too long: 1600 tokens > 600 maximum")
    const run = yield* scripted("ses_cm2_ptl_gap", rounds(3), [gap, gap, answer("<handoff>\nfits\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(3)
    // The rejected first request went to the fallback, which was rejected too.
    expect(run.sent[1]?.system).toHaveLength(1)
    // The retry is the first request again, with the oldest group (u0, 1,000 tokens) gone and the rest as messages.
    const retry = run.sent[2]
    expect(retry?.system.length).toBe(run.sent[0]?.system.length)
    const sent = retry?.messages ?? []
    expect(JSON.stringify(sent)).not.toContain("U0-")
    const first = sent.findIndex((message) => textOf(message).includes("A1-reply"))
    expect(first).toBeGreaterThan(0)
    expect(sent[first]?.role).toBe("assistant")
    // The slice would open with an assistant reply, so a marker user message goes first.
    expect(sent[first - 1]?.role).toBe("user")
    expect(textOf(sent[first - 1])).toBe("[Earlier messages were left out so that this summary request fits.]")
    expect(JSON.stringify(sent)).toContain("U3-ask")
  }),
)

it.effect("a prompt-too-long rejection without a readable gap drops a fifth of the round groups", () =>
  Effect.gen(function* () {
    const unknown = tooLong("Input is longer than the context window")
    // Ten groups: u0, then nine reply-and-ask pairs. A fifth is two groups: u0, and A1 with U1.
    const run = yield* scripted(
      "ses_cm2_ptl_fifth",
      rounds(9),
      [unknown, unknown, answer("<handoff>\nfits\n</handoff>")],
      { context: withTools(32_000) },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(3)
    const sent = JSON.stringify(run.sent[2]?.messages)
    expect(sent).not.toContain("U0-")
    expect(sent).not.toContain("A1-reply")
    expect(sent).not.toContain("U1-ask")
    expect(sent).toContain("A2-reply")
    expect(run.sent[2]?.messages.some((message) => message.role === "assistant")).toBe(true)
  }),
)

it.effect("prompt-too-long gives up after three retries with a message that says to go back", () =>
  Effect.gen(function* () {
    const unknown = tooLong("Input is longer than the context window")
    const run = yield* scripted(
      "ses_cm2_ptl_exhausted",
      rounds(9),
      Array.from({ length: 12 }, () => unknown),
      { context: withTools(32_000) },
    )
    expect(run.outcome).toMatchObject({ status: "failed", error: { type: "compaction.failed", message: TOO_LONG } })
    // The first try and three retries, each a first request and its fallback.
    expect(run.sent).toHaveLength(8)
  }),
)

it.effect("prompt-too-long with one round group left fails at once", () =>
  Effect.gen(function* () {
    const unknown = tooLong("Input is longer than the context window")
    const run = yield* scripted("ses_cm2_ptl_single", [userText("Only one message")], [unknown, unknown, unknown], {
      context: withTools(32_000),
    })
    expect(run.outcome).toMatchObject({ status: "failed", error: { message: TOO_LONG } })
    expect(run.sent).toHaveLength(2)
  }),
)

it.effect("compaction instructions go in a block of their own before the closing reminder", () =>
  Effect.gen(function* () {
    const done = () => [answer("<handoff>\nok\n</handoff>")]
    const plain = yield* scripted("ses_cm2_no_instructions", [userText("Do it")], done())
    const blank = yield* scripted("ses_cm2_blank_instructions", [userText("Do it")], done(), {
      instructions: "  \n\t ",
    })
    const given = yield* scripted("ses_cm2_instructions", [userText("Do it")], done(), {
      instructions: "  Keep the MIGRATION-COMMANDS exactly.  ",
    })
    // Empty or blank instructions are none.
    expect(promptOf(blank.sent[0])).toBe(promptOf(plain.sent[0]))
    const prompt = promptOf(given.sent[0])
    expect(prompt).toContain("\nKeep the MIGRATION-COMMANDS exactly.\n")
    expect(prompt.indexOf("MIGRATION-COMMANDS")).toBeGreaterThan(prompt.lastIndexOf("</example>"))
    // The trailer is still last, and the block is the only difference.
    expect(paragraphsOf(prompt).at(-1)).toBe(paragraphsOf(promptOf(plain.sent[0])).at(-1))
    expect(prompt.replace(/\n\n[^\n]+\nKeep the MIGRATION-COMMANDS exactly\./, "")).toBe(promptOf(plain.sent[0]))
  }),
)

it.effect("the fallback leaves out reasoning settings and effort notes, and names each kind of media", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.options.reasoningEffort = "high"
        event.messages.unshift(Message.effort({ effort: "high" }))
      }),
    )
    const document = Schema.decodeUnknownSync(SessionMessage.User)({
      id: SessionMessage.ID.create(),
      type: "user",
      text: "Read this report",
      files: [{ mime: "application/pdf", data: "JVBERi0=", source: { type: "inline" } }],
      time: { created: 0 },
    })
    const toolImage = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [
        {
          type: "tool",
          id: "call_read",
          name: "Read",
          state: {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: "TOOL-TEXT" },
              { type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", name: "pixel.png" },
            ],
          },
          time: { created: 0 },
        },
      ],
      time: { created: 0, completed: 0 },
    })
    const run = yield* scripted(
      "ses_cm2_fallback_media",
      [document, toolImage],
      [silent, answer("<handoff>\nok\n</handoff>")],
      {
        context: (context) => {
          const selected = withTools(32_000)(context)
          return {
            ...selected,
            model: { ...selected.model, capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] } },
          }
        },
      },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    const [primary, fallback] = run.sent
    // The first request keeps what the hooks and the history gave it.
    expect(primary?.providerOptions).toMatchObject({ reasoningEffort: "high" })
    const parts = (request: LLMRequest | undefined) => request?.messages.flatMap((message) => message.content) ?? []
    expect(parts(primary).some((part) => part.type === "effort")).toBe(true)
    expect(parts(primary).some((part) => part.type === "media")).toBe(true)
    // The fallback has no reasoning setting, no effort note and no media; each kind of media is named.
    expect(fallback?.providerOptions).toBeUndefined()
    expect(parts(fallback).some((part) => part.type === "effort")).toBe(false)
    expect(parts(fallback).some((part) => part.type === "media")).toBe(false)
    const sent = JSON.stringify(fallback?.messages)
    expect(sent).toContain("[document]")
    expect(sent).toContain("[image]")
    expect(sent).toContain("TOOL-TEXT")
    expect(sent).not.toContain("iVBORw0KGgo")
  }),
)

it.effect("a prompt-too-long rejection with a larger gap drops as many oldest groups as the gap needs", () =>
  Effect.gen(function* () {
    // The gap is 1,003 tokens: u0 (about 1,000) is not enough, so the next group goes too. A fifth of four groups
    // would be one.
    const gap = tooLong("Prompt is too long: 2,003 tokens > 1,000 maximum")
    const run = yield* scripted("ses_cm2_ptl_two_groups", rounds(3), [gap, gap, answer("<handoff>\nfits\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    const sent = JSON.stringify(run.sent[2]?.messages)
    expect(sent).not.toContain("U0-")
    expect(sent).not.toContain("A1-reply")
    expect(sent).not.toContain("U1-ask")
    expect(sent).toContain("A2-reply")
  }),
)

it.effect("a prompt-too-long rejection whose gap the first group exactly covers drops that group only", () =>
  Effect.gen(function* () {
    // u0 is 1,001 tokens, so a gap of 1,001 is covered by it alone.
    const gap = tooLong("prompt is too long: 2001 tokens > 1000 maximum")
    const run = yield* scripted("ses_cm2_ptl_exact", rounds(3), [gap, gap, answer("<handoff>\nfits\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    const sent = JSON.stringify(run.sent[2]?.messages)
    expect(sent).not.toContain("U0-")
    expect(sent).toContain("A1-reply")
  }),
)

it.effect("analysis never stored: a second analysis ahead of the handoff", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_analysis_before",
      [userText("Do it")],
      [answer("<analysis>DRAFT-A</analysis>\n<analysis>DRAFT-B</analysis>\n<handoff>\n## Objective\n- keep\n</handoff>")],
    )
    expect(run.summary).toBe("Summary:\n## Objective\n- keep")
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-")
  }),
)

it.effect("a handoff that quotes an <analysis> tag is stored whole", () =>
  Effect.gen(function* () {
    // Section 6 quotes user messages, and one of them may name the tag without closing it.
    const handoff = [
      "<handoff>",
      "6. User messages:",
      '   - "Why does the eval prompt open an <analysis> tag first?"',
      "8. Work in progress: QUOTED-WORK",
      "9. Next step: QUOTED-NEXT",
      "</handoff>",
    ].join("\n")
    const run = yield* scripted(
      "ses_cm2_quoted_tag",
      [userText("Do it")],
      [answer(`<analysis>DRAFT-Q</analysis>\n${handoff}`)],
    )
    expect(run.summary).toContain("QUOTED-WORK")
    expect(run.summary).toContain("QUOTED-NEXT")
    expect(run.summary?.startsWith("Summary:\n6. User messages:")).toBe(true)
    expect(run.summary).not.toContain("<handoff>")
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-Q")
  }),
)

it.effect("analysis never stored: an analysis that names the handoff tag", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_analysis_names_tag",
      [userText("Do it")],
      [answer("<analysis>\nI will write <handoff> next.\nDRAFT-N\n</analysis>\n<handoff>\nreal\n</handoff>")],
    )
    expect(run.summary).toBe("Summary:\nreal")
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-N")
  }),
)

it.effect("analysis never stored: an analysis that quotes a whole handoff block", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_analysis_quotes_block",
      [userText("Do it")],
      [answer("<analysis>\nFixture has <handoff>x</handoff>.\nDRAFT-S\n</analysis>\n<handoff>\n1. Requests: real\n</handoff>")],
    )
    expect(run.summary).toBe("Summary:\n1. Requests: real")
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-S")
  }),
)

it.effect("analysis never stored: an analysis cut off while it quotes a whole handoff block", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_analysis_cut_quotes_block",
      [userText("Do it")],
      [answer("<analysis>\nFixture has <handoff>QUOTED-X</handoff>.\nDRAFT-U cut", "length")],
    )
    expect(run.outcome).toMatchObject({ status: "failed", error: { type: "compaction.failed", message: NO_SUMMARY } })
    expect(JSON.stringify(run.events)).not.toContain("QUOTED-X")
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-U")
  }),
)

it.effect("a handoff cut off before its closing tag stays as written", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_handoff_cut",
      [userText("Do it")],
      [answer("<handoff>\n## Objective\n- cut", "length")],
    )
    expect(run.summary).toBe("<handoff>\n## Objective\n- cut")
  }),
)

// Which history counts as something to compact: each row is compacted, or fails as nothing to compact.
const lone = (message: unknown) => [Schema.decodeUnknownSync(SessionMessage.Info)(message)]
const loneBase = { id: "msg_lone", time: { created: 0 } }
for (const [name, history, compacts] of [
  [
    "a skill message",
    lone({ ...loneBase, type: "skill", skill: "sk", name: "sk", text: "Use the skill" }),
    true,
  ],
  [
    "a location switch",
    lone({ ...loneBase, type: "location-switched", location: { directory: "/destination" } }),
    true,
  ],
  [
    "a background shell",
    lone({
      ...loneBase,
      type: "shell",
      shellID: "sh_lone",
      status: "exited",
      command: "pwd",
      metadata: { background: true },
      output: { output: "x", cursor: 1, size: 1, truncated: false },
      time: { created: 0, completed: 1 },
    }),
    false,
  ],
  [
    "an assistant message with only empty reasoning",
    lone({
      ...loneBase,
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [{ type: "reasoning", text: "" }],
      time: { created: 0, completed: 0 },
    }),
    false,
  ],
  [
    "an assistant message with reasoning text",
    lone({
      ...loneBase,
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [{ type: "reasoning", text: "thinking it over" }],
      time: { created: 0, completed: 0 },
    }),
    true,
  ],
  [
    "a reminder",
    lone({ ...loneBase, type: "synthetic", text: "reminder text", metadata: { reminder: { kind: "todo" } } }),
    false,
  ],
] as const)
  it.effect(`a history of only ${name} ${compacts ? "compacts" : "fails as nothing to compact"}`, () =>
    Effect.gen(function* () {
      const run = yield* scripted(`ses_cm2_lone_${name.replaceAll(" ", "_")}`, history, [
        answer("<handoff>\nok\n</handoff>"),
      ])
      expect(run.outcome).toEqual(
        compacts
          ? { status: "completed" }
          : { status: "failed", error: { type: "compaction.unavailable", message: "Nothing to compact yet" } },
      )
    }),
  )

// Gate mutations: each test below fails when the line named in its comment is broken.
const failedFinish = () =>
  Stream.make(
    LLMEvent.stepFinish({ index: 0, reason: { normalized: "error" }, usage }),
    LLMEvent.finish({ reason: { normalized: "error" } }),
  )

it.effect("a summary that a compaction hook supplies with no text outside the analysis fails as no summary", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.result = { summary: "<analysis>DRAFT-I only</analysis>" }
      }),
    )
    const run = yield* scripted("ses_cm2_hook_blank", [userText("Do it")], [])
    expect(run.outcome).toMatchObject({ status: "failed", error: { message: NO_SUMMARY } })
    expect(run.sent).toEqual([])
    expect(run.summary).toBeUndefined()
  }),
)

it.effect("a first reply of only whitespace goes to the fallback", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_whitespace",
      [userText("Do it")],
      [answer("  \n\t"), answer("<handoff>\nfallback\n</handoff>")],
      { context: withTools(32_000) },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(2)
    expect(run.sent[1]?.system).toHaveLength(1)
  }),
)

it.effect("a failure that is not a context overflow stops the fallback at once, without dropping history", () =>
  Effect.gen(function* () {
    const refused = () => Stream.make(LLMEvent.providerError({ message: "The provider refused this request" }))
    const run = yield* scripted("ses_cm2_refused_twice", rounds(3), [refused, refused, answer("unused")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toMatchObject({ status: "failed", error: { message: expect.stringContaining("refused") } })
    expect(run.sent).toHaveLength(2)
  }),
)

it.effect("a prompt-too-long gap larger than the whole history still keeps the newest round group", () =>
  Effect.gen(function* () {
    const gap = tooLong("prompt is too long: 900000 tokens > 1000 maximum")
    const run = yield* scripted("ses_cm2_ptl_huge", rounds(3), [gap, gap, answer("<handoff>\nfits\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    const sent = JSON.stringify(run.sent[2]?.messages)
    expect(sent).not.toContain("A2-reply")
    expect(sent).toContain("A3-reply")
    expect(sent).toContain("U3-ask")
  }),
)

it.effect("the fallback asks for at most 20,000 tokens, also when the model states no output limit", () =>
  Effect.gen(function* () {
    for (const output of [32_000, 0]) {
      const run = yield* scripted(
        `ses_cm2_cap_${output}`,
        [userText("Do it")],
        [silent, answer("<handoff>\nok\n</handoff>")],
        { context: withTools(output) },
      )
      expect(run.sent[1]?.generation?.maxTokens).toBe(20_000)
    }
  }),
)

it.effect("the fallback sends no message that is left without content", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.messages.unshift(Message.effort({ effort: "high" }))
      }),
    )
    const run = yield* scripted(
      "ses_cm2_fallback_empty",
      [userText("Do it")],
      [silent, answer("<handoff>\nok\n</handoff>")],
      { context: withTools(32_000) },
    )
    expect(run.sent[1]?.messages.length).toBe((run.sent[0]?.messages.length ?? 0) - 1)
    expect(run.sent[1]?.messages.every((message) => message.content.length > 0)).toBe(true)
  }),
)

it.effect("a retryable failure of the first request is resent under the retry policy and its hook", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    let decided = 0
    yield* hooks.register("session", "retry", (event) =>
      Effect.sync(() => {
        decided++
        event.decision = { retry: true, delay: 0 }
      }),
    )
    const run = yield* scripted(
      "ses_cm2_retry_yes",
      [userText("Do it")],
      [failedFinish, answer("<handoff>\nretried\n</handoff>")],
      { context: withTools(32_000) },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(decided).toBe(1)
    // The same request is sent again: no fallback system prompt.
    expect(run.sent).toHaveLength(2)
    expect(run.sent[1]?.system).toHaveLength(run.sent[0]?.system.length ?? -1)
  }),
)

it.effect("a hook that declines the retry sends the first request's failure on to the fallback", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "retry", (event) =>
      Effect.sync(() => {
        event.decision = { retry: false }
      }),
    )
    const run = yield* scripted(
      "ses_cm2_retry_no",
      [userText("Do it")],
      [failedFinish, answer("<handoff>\nfallback\n</handoff>")],
      { context: withTools(32_000) },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(2)
    expect(run.sent[1]?.system).toHaveLength(1)
  }),
)

it.effect("a context overflow never reaches the retry policy", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    let decided = 0
    yield* hooks.register("session", "retry", (event) =>
      Effect.sync(() => {
        decided++
        event.decision = { retry: true, delay: 0 }
      }),
    )
    const gap = tooLong("Input is longer than the context window")
    const run = yield* scripted("ses_cm2_overflow_policy", rounds(3), [gap, gap, answer("<handoff>\nfits\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    expect(decided).toBe(0)
    expect(run.sent).toHaveLength(3)
  }),
)

it.effect("a fallback that fails for another reason than the size stops the compaction without dropping history", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "retry", (event) =>
      Effect.sync(() => {
        event.decision = { retry: false }
      }),
    )
    const run = yield* scripted("ses_cm2_fallback_fails", rounds(3), [failedFinish, failedFinish, answer("unused")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toMatchObject({ status: "failed" })
    expect(run.outcome).not.toMatchObject({ error: { message: TOO_LONG } })
    expect(run.sent).toHaveLength(2)
  }),
)

it.effect("a history of only a synthetic note counts as conversation to compact", () =>
  Effect.gen(function* () {
    const run = yield* scripted(
      "ses_cm2_synthetic_only",
      [
        SessionMessage.Synthetic.make({
          id: SessionMessage.ID.create(),
          type: "synthetic",
          text: "User shell pwd completed: /project",
          time: { created: DateTime.makeUnsafe(0) },
        }),
      ],
      [answer("<handoff>\nok\n</handoff>")],
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(JSON.stringify(run.sent[0]?.messages)).toContain("User shell pwd completed")
  }),
)

it.effect("a summary that a compaction hook supplies on the native path is formatted the same way", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        event.result = { summary: "<analysis>DRAFT-N</analysis>\n<handoff>\n## Objective\n- native\n</handoff>" }
      }),
    )
    // A configured endpoint gives the model a stable identity, which the native path requires before it reaches the hook.
    const endpoint = OpenAI.configure({ apiKey: "fixture", baseURL: "http://127.0.0.1:1" }).responses("gpt-5.4-mini")
    const run = yield* scripted("ses_cm2_hook_native", [userText("Do it")], [], {
      context: (context) => ({ ...context, model: { ...context.model, model: endpoint, compaction: { type: "native" } } }),
    })
    expect(run.sent).toEqual([])
    expect(run.summary).toBe("Summary:\n## Objective\n- native")
    expect(JSON.stringify(run.events)).not.toContain("DRAFT-")
  }),
)

// A summary compaction sends a rejected request to its fallback; a native one still resends its history as transcript
// text, and the transcript leaves reasoning out.
it.effect("a native compaction rejected as too large resends its history as text without the assistant's reasoning", () =>
  Effect.gen(function* () {
    const endpoint = OpenAI.configure({ apiKey: "fixture", baseURL: "http://127.0.0.1:1" }).responses("gpt-5.4-mini")
    checkpoints = [
      () =>
        Effect.fail(
          new AIError({ reason: new InvalidRequestError({ message: "Too large", classification: "payload-too-large" }) }),
        ),
      () =>
        Effect.succeed(
          CompactionCheckpointResponse.make({
            responseID: "resp_cm2_native_text",
            checkpoint: { type: "compaction", provider: endpoint.provider, encrypted: "native-text" },
          }),
        ),
    ]
    const reasoned = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [
        { type: "reasoning", text: "Private reasoning" },
        { type: "text", text: "Answer 0" },
      ],
      time: { created: 0, completed: 0 },
    })
    const run = yield* scripted("ses_cm2_native_text", [userText("Request 0"), reasoned], [], {
      context: (context) => ({ ...context, model: { ...context.model, model: endpoint, compaction: { type: "native" } } }),
    }).pipe(Effect.ensuring(Effect.sync(() => (checkpoints = []))))

    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(2)
    // The first send carries the reasoning as a part of its own; the transcript text leaves it out.
    expect(run.sent[0]?.messages.some((message) => message.content.some((part) => part.type === "reasoning"))).toBe(true)
    const transcript = textOf(run.sent[1]?.messages.at(-1))
    expect(transcript).toContain("[Assistant]: Answer 0")
    expect(transcript).not.toContain("Private reasoning")
  }),
)

// context-memory-4: a checkpoint that keeps messages is stored after them, so the newest completed compaction is not
// the first message of the history. The text fallback still sends its summary as the lead message.
it.effect("a native compaction resent as text keeps the summary of a retained checkpoint in front", () =>
  Effect.gen(function* () {
    const endpoint = OpenAI.configure({ apiKey: "fixture", baseURL: "http://127.0.0.1:1" }).responses("gpt-5.4-mini")
    checkpoints = [
      () =>
        Effect.fail(
          new AIError({ reason: new InvalidRequestError({ message: "Too large", classification: "payload-too-large" }) }),
        ),
      () =>
        Effect.succeed(
          CompactionCheckpointResponse.make({
            responseID: "resp_cm4_retained_text",
            checkpoint: { type: "compaction", provider: endpoint.provider, encrypted: "native-text" },
          }),
        ),
    ]
    const kept = userText("Kept request")
    const retainedCheckpoint = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)({
      id: SessionMessage.ID.create(),
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "RETAINED-SUMMARY",
      recent: "",
      retain: kept.id,
      time: { created: 0, completed: 0 },
    })
    const run = yield* scripted(
      "ses_cm4_retained_text",
      [kept, assistantText("Kept answer"), retainedCheckpoint, userText("Newest request")],
      [],
      {
        context: (context) => ({ ...context, model: { ...context.model, model: endpoint, compaction: { type: "native" } } }),
      },
    ).pipe(Effect.ensuring(Effect.sync(() => (checkpoints = []))))

    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(2)
    const resent = run.sent[1]?.messages ?? []
    // The summary is its own lead message, and the transcript after it neither repeats it nor drops the kept exchange.
    expect(textOf(resent[0])).toContain("RETAINED-SUMMARY")
    const transcript = textOf(resent.at(-1))
    expect(transcript).not.toContain("RETAINED-SUMMARY")
    expect(transcript).toContain("Kept request")
    expect(transcript).toContain("Newest request")
  }),
)

// A view that failed open can hold two completed compactions; the text fallback leads with the newest one.
it.effect("a native compaction resent as text leads with the newest of two checkpoints", () =>
  Effect.gen(function* () {
    const endpoint = OpenAI.configure({ apiKey: "fixture", baseURL: "http://127.0.0.1:1" }).responses("gpt-5.4-mini")
    checkpoints = [
      () =>
        Effect.fail(
          new AIError({ reason: new InvalidRequestError({ message: "Too large", classification: "payload-too-large" }) }),
        ),
      () =>
        Effect.succeed(
          CompactionCheckpointResponse.make({
            responseID: "resp_cm4_two_checkpoints",
            checkpoint: { type: "compaction", provider: endpoint.provider, encrypted: "native-text" },
          }),
        ),
    ]
    const run = yield* scripted(
      "ses_cm4_two_checkpoints",
      [previousCheckpoint("OLDER-SUMMARY"), userText("Kept request"), previousCheckpoint("NEWER-SUMMARY"), userText("Newest request")],
      [],
      {
        context: (context) => ({ ...context, model: { ...context.model, model: endpoint, compaction: { type: "native" } } }),
      },
    ).pipe(Effect.ensuring(Effect.sync(() => (checkpoints = []))))

    expect(run.outcome).toEqual({ status: "completed" })
    const resent = run.sent[1]?.messages ?? []
    expect(textOf(resent[0])).toContain("NEWER-SUMMARY")
    expect(textOf(resent[0])).not.toContain("OLDER-SUMMARY")
  }),
)

it.effect("a reply with text and a tool call uses the text and runs no tool", () =>
  Effect.gen(function* () {
    const both = () =>
      Stream.make(
        LLMEvent.textDelta({ id: "summary", text: "<handoff>\nT\n</handoff>" }),
        LLMEvent.toolCall({ id: "call_summary_read", name: "Read", input: { path: "/project/a.ts" } }),
        LLMEvent.stepFinish({ index: 0, reason: { normalized: "tool-calls" }, usage }),
        LLMEvent.finish({ reason: { normalized: "tool-calls" } }),
      )
    // `withTools` makes `execute` die, so a tool run would fail the outcome.
    const run = yield* scripted("ses_cm2_text_and_call", [userText("Do it")], [both], { context: withTools(32_000) })
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.summary).toBe("Summary:\nT")
    expect(run.sent).toHaveLength(1)
  }),
)

it.effect("a summary request is sized for the room it leaves and drops nothing when the history fits the window", () =>
  Effect.gen(function* () {
    // Above the effective window (the window minus the reserve), below the window itself.
    const history = [userText("word ".repeat(152_000)), assistantText("ok"), userText("go on")]
    const run = yield* scripted("ses_cm2_room", history, [answer("<handoff>\nT\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent).toHaveLength(1)
    const request = run.sent[0]!
    expect(request.messages).toHaveLength(history.length + 1)
    const maxTokens = request.generation?.maxTokens ?? 0
    expect(maxTokens).toBeGreaterThanOrEqual(3_000)
    expect(SessionCompaction.estimateRequest(request) + maxTokens).toBeLessThanOrEqual(200_000)
  }),
)

it.effect("a summary request leaves a margin of 15 percent for an estimate that runs low", () =>
  Effect.gen(function* () {
    // About 160,000 estimated tokens: 15 percent over leaves 16,000 of the 200,000 window, below the 20,000 asked for.
    const history = [userText("word ".repeat(128_000)), assistantText("ok"), userText("go on")]
    const run = yield* scripted("ses_cm2_margin", history, [answer("<handoff>\nT\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    const request = run.sent[0]!
    expect(request.generation?.maxTokens).toBe(200_000 - Math.ceil(SessionCompaction.estimateRequest(request) * 1.15))
    expect(request.generation?.maxTokens).toBeGreaterThan(3_000)
    expect(request.generation?.maxTokens).toBeLessThan(20_000)
  }),
)

it.effect("the fallback is built on the model without the session's reasoning variant", () =>
  Effect.gen(function* () {
    const thinking = LanguageModel.update(model, {
      defaults: { providerOptions: { openai: { reasoningEffort: "high" } } },
    })
    const run = yield* scripted(
      "ses_cm2_unreasoned",
      [userText("Do it")],
      [silent, answer("<handoff>\nok\n</handoff>")],
      {
        context: (context) => {
          const selected = withTools(32_000)(context)
          return { ...selected, model: { ...selected.model, model: thinking }, unreasoned: Effect.succeed(selected.model) }
        },
      },
    )
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent[0]?.model.defaults?.providerOptions).toEqual({ openai: { reasoningEffort: "high" } })
    expect(run.sent[1]?.model.defaults?.providerOptions).toBeUndefined()
  }),
)

// A model.request hook that reroutes the request moves the fallback too, with or without a reasoning variant.
for (const withVariant of [false, true]) {
  for (const hooked of [false, true]) {
    it.effect(`the fallback goes where the first request went: variant ${withVariant}, route hook ${hooked}`, () =>
      Effect.gen(function* () {
        if (hooked) {
          const hooks = yield* PluginHooks.Service
          yield* hooks.register("session", "model.request", (event) =>
            Effect.sync(() => {
              event.baseURL = "https://gateway.example.test/v1"
              event.headers["x-gateway-key"] = "GATEWAY-SECRET"
            }),
          )
        }
        const run = yield* scripted(
          `ses_cm2_route_${withVariant}_${hooked}`,
          [userText("Do it")],
          [silent, answer("<handoff>\nok\n</handoff>")],
          {
            context: (context) => {
              const selected = withTools(32_000)(context)
              return withVariant ? { ...selected, unreasoned: Effect.succeed(selected.model) } : selected
            },
          },
        )
        expect(run.outcome).toEqual({ status: "completed" })
        expect(run.sent).toHaveLength(2)
        expect(run.sent[1]?.model.route.endpoint.baseURL).toBe(run.sent[0]?.model.route.endpoint.baseURL)
        expect(run.sent[1]?.http?.headers).toEqual(run.sent[0]?.http?.headers)
        if (hooked) expect(run.sent[1]?.model.route.endpoint.baseURL).toBe("https://gateway.example.test/v1")
      }),
    )
  }
}

it.effect("a summary request keeps the output limit a hook set, and none when a hook removed it", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    yield* hooks.register("session", "compaction", (event) =>
      Effect.sync(() => {
        delete event.options.maxTokens
      }),
    )
    const run = yield* scripted("ses_cm2_no_limit", [userText("Do it")], [answer("<handoff>\nT\n</handoff>")], {
      context: withTools(32_000),
    })
    expect(run.outcome).toEqual({ status: "completed" })
    expect(run.sent[0]?.generation?.maxTokens).toBeUndefined()
  }),
)

it.effect("a summary request leaves a margin for an estimate that runs low", () =>
  Effect.gen(function* () {
    // The estimate alone leaves 12,000 tokens of the window; a request that also allows for the estimate running low
    // leaves less than that, but never less than the 3,000 floor.
    const run = yield* scripted("ses_cm2_margin", [userText("word ".repeat(129_000)), assistantText("ok"), userText("go on")], [answer("<handoff>\nT\n</handoff>")], {
      context: withTools(32_000),
    })
    const request = run.sent[0]!
    const maxTokens = request.generation?.maxTokens ?? 0
    expect(maxTokens).toBeGreaterThan(3_000)
    expect(SessionCompaction.estimateRequest(request) * 1.1 + maxTokens).toBeLessThanOrEqual(200_000)
  }),
)

it.effect("an automatic summary compaction opens its own message", () =>
  Effect.gen(function* () {
    requests = []
    replies = [answer("<handoff>\nT\n</handoff>")]
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const session = yield* insertSession(Session.ID.make("ses_cm2_auto_summary"))
    const context = withTools(32_000)(
      loaded(session, [userText("word ".repeat(152_000)), assistantText("ok"), userText("go on")]),
    )
    const outcome = yield* compaction
      .compact({ reason: "auto", context })
      .pipe(Effect.ensuring(Effect.sync(() => (replies = []))))
    expect(outcome).toEqual({ status: "completed" })
    const events = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, session.id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    expect(events.map((event) => event.type)).toEqual([
      Bus.versionedType(SessionEvent.Compaction.Started.type, 1),
      Bus.versionedType(SessionEvent.UsageRecorded.type, 1),
      Bus.versionedType(SessionEvent.Compaction.Ended.type, 1),
    ])
    expect((yield* store.context(session.id))[0]).toMatchObject({ type: "compaction", reason: "auto", summary: "Summary:\nT" })
  }),
)
