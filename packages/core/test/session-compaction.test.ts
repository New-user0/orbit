import { expect, test } from "bun:test"
import { GenerationOptions, LLMClient, LLMEvent, LanguageModel, Message, ToolDefinition, type LLMRequest } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
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
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
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
const client = Layer.mock(LLMClient.Service)({
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

  expect(prompt.startsWith("IMPORTANT: Reply with text only. Do not call any tool.")).toBe(true)
  expect(prompt).toEndWith("A tool call will be refused and the handoff will be lost.")
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
