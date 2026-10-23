import { expect, test } from "bun:test"
import { GenerationOptions, LLMClient, LLMEvent, LanguageModel, ToolDefinition, type LLMRequest } from "@orbit/ai"
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
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
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

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt(false)

  expect(prompt).toContain("## Work State")
  expect(prompt).toContain("### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

it.effect("compaction describes tool media without embedding base64", () =>
  Effect.gen(function* () {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
    const recent = yield* recentWithToolOutput(Session.ID.make("ses_tool_media"), [
      { type: "text", text: "Image read successfully" },
      {
        type: "file",
        uri: `data:image/png;base64,${base64}`,
        mime: "image/png",
        name: "pixel.png",
      },
    ])

    expect(recent).toContain("[Tool result]: Image read successfully\n[Attached image/png: pixel.png]")
    expect(recent).not.toContain(base64)
  }),
)

it.effect("compaction truncation does not split surrogate pairs", () =>
  Effect.gen(function* () {
    const prefix = "a".repeat(1_249)
    const split = yield* recentWithToolOutput(Session.ID.make("ses_truncate_split"), [
      { type: "text", text: `${prefix}😀suffix` },
    ])
    const whole = yield* recentWithToolOutput(Session.ID.make("ses_truncate_whole"), [
      { type: "text", text: "😀".repeat(1_250) },
    ])

    expect(split).toEndWith(`[Tool result]: ${prefix}😀\n[truncated]`)
    expect(whole).toEndWith(`[Tool result]: ${"😀".repeat(1_250)}`)
  }),
)

test("compaction prompt requires the checkpoint headings in order", () => {
  const prompt = SessionCompaction.buildPrompt(false)
  expect(prompt.match(/^#{2,3} .+$/gm)).toEqual([
    "## Objective",
    "## Requirements",
    "## Decisions",
    "## Work State",
    "### Completed",
    "### Active",
    "### Blocked",
    "## Next Move",
    "## Relevant Files",
    "## Important Context",
  ])
})

test("compaction update prompt rewrites legacy checkpoints only when asked", () => {
  const rewrite = "The existing checkpoint was written with an earlier format"
  expect(SessionCompaction.buildPrompt(true, true)).toContain(rewrite)
  expect(SessionCompaction.buildPrompt(true)).not.toContain(rewrite)
  expect(SessionCompaction.buildPrompt(false, true)).not.toContain(rewrite)
})

test("compaction prompts prohibit task execution", () => {
  for (const update of [false, true])
    expect(SessionCompaction.buildPrompt(update)).toContain("Do not continue the task or call tools")
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
const recentWithToolOutput = (id: Session.ID, content: SessionMessage.ToolStateCompleted["content"]) =>
  Effect.gen(function* () {
    const session = yield* insertSession(id)
    const user = (text: string) =>
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text,
        time: { created: DateTime.makeUnsafe(0) },
      })
    const assistant = Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "summary-model", providerID: "test" },
      content: [
        {
          type: "tool",
          id: "call_read",
          name: "Read",
          state: { status: "completed", input: {}, content },
          time: { created: 0 },
        },
      ],
      time: { created: 0, completed: 0 },
    })
    expect(yield* compactManually(session, [user("Earlier question"), user("Read it"), assistant])).toEqual({
      status: "completed",
    })
    const store = yield* SessionStore.Service
    const stored = (yield* store.context(id))[0]
    return stored?.type === "compaction" && stored.status === "completed" ? stored.recent : ""
  })

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
        expect(JSON.stringify(event.messages)).not.toContain("Summarize only what")
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
    expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain("Summarize only what")
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

it.effect("the recent text of a summary leaves out an escalated attempt and its notice", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_escalated_recent"))
    const history = escalatedHistory()
    // An earlier user message gives the summary something older, so the exchange below is kept as recent text.
    const earlier = SessionMessage.User.make({ ...history.user, id: SessionMessage.ID.create(), text: "Earlier question" })
    expect(
      yield* compactManually(session, [earlier, history.user, history.cut, history.notice, history.answer]),
    ).toEqual({ status: "completed" })
    const stored = (yield* (yield* SessionStore.Service).context(session.id))[0]
    const recent = stored?.type === "compaction" && stored.status === "completed" ? stored.recent : ""
    expect(recent).toContain("WholeAnswerText")
    expect(recent).not.toContain("FirstCutText")
    expect(recent).not.toContain("escalated")
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

it.effect("sizes a summary request for an unknown window by the 200,000-token window less the output reserve", () =>
  Effect.gen(function* () {
    requests = []
    const session = yield* insertSession(Session.ID.make("ses_unknown_window_cap"))
    // The last message stays verbatim; the eight before it are about 212,000 tokens, and seven of them are 185,500, which fits a 191,808-token cap but not the 180,000 a fixed 20,000 reserve gives.
    const messages = Array.from({ length: 9 }, (_, index) =>
      SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: `marker-${index} ${"a".repeat(106_000)}`,
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

    const sent = JSON.stringify(requests[0]?.messages)
    expect(sent).not.toContain("marker-0 ")
    expect(sent).toContain("marker-1 ")
    expect(sent).toContain("marker-6 ")
  }),
)
