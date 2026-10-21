import { expect } from "bun:test"
import { App } from "@orbit/core/app"
import {
  LLMClient,
  LLMEvent,
  LLMResponse,
  LanguageModel,
  Message,
  SystemPart,
  ToolDefinition,
  type AIError,
  type LLMRequest,
} from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import type { StreamOptions } from "@orbit/ai/route"
import { Agent } from "@orbit/core/agent"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Bus } from "@orbit/core/bus"
import { EventTable } from "@orbit/core/event/sql"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instance } from "@orbit/core/instance/service"
import { Instructions } from "@orbit/core/instructions/index"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { ID } from "@orbit/core/model"
import { Project } from "@orbit/core/project"
import { Provider } from "@orbit/core/provider"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionContext } from "@orbit/core/session/context"
import { SessionReminders } from "@orbit/core/session/reminders"
import { SessionGenerate } from "@orbit/core/session/generate"
import { InstructionState } from "@orbit/core/session/instruction-state"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import {
  InstructionBlobTable,
  InstructionStateTable,
  SessionMessageTable,
  SessionInboxTable,
  SessionUsageTable,
  SessionTable,
} from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SessionTurn } from "@orbit/core/session/turn"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Tool } from "@orbit/core/tool"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { overloaded } from "./lib/provider-failure"
import { noScratchpad } from "./lib/scratchpad"
import { noVcsSnapshot } from "./lib/vcs-snapshot"
import { stubSnapshot } from "./lib/tool"

const requests: LLMRequest[] = []
const options: Array<StreamOptions | undefined> = []
let instruction: string | Instructions.Unavailable = "Initial context"
// When set, the provider rejects every request with it.
let rejection: AIError | undefined
const sessionID = SessionSchema.ID.make("ses_generate_test")

const model = LanguageModel.make({ id: "generate-model", provider: "test", route: OpenAIChat.route })
const client = Layer.mock(LLMClient.Service)({
  stream: () => Stream.die(new Error("unused")),
  generate: (request, requestOptions) =>
    Effect.suspend(() => {
      requests.push(request)
      options.push(requestOptions)
      if (rejection) return Effect.fail(rejection)
      const response = LLMResponse.fromEvents([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "generate" }),
        LLMEvent.textDelta({ id: "generate", text: "Transient answer" }),
        LLMEvent.textEnd({ id: "generate" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: { normalized: "stop" },
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
        LLMEvent.finish({ reason: { normalized: "stop" } }),
      ])
      if (!response) return Effect.die(new Error("Incomplete generate response"))
      return Effect.succeed(response)
    }),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})
const builtins = Layer.mock(InstructionBuiltIns.Service, {
  preferences: () => Effect.succeed(Instructions.empty),
  load: () =>
    Effect.succeed(
      Instructions.make({
        key: Instructions.Key.make("test/context"),
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.sync(() => instruction),
        render: {
          initial: String,
          changed: (_previous, current) => current,
        },
      }),
    ),
})
const discovery = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  load: () => Effect.succeed(Instructions.empty),
})
const skills = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const references = Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcp = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const tools = Layer.mock(Tool.Service, {
  snapshot: () =>
    Effect.succeed(
      stubSnapshot({
        codeModeCatalog: {
          tools: [
            {
              type: "tool",
              name: "captured.lookup",
              description: "Captured Code Mode catalog",
              signature: "tools.captured.lookup(): Promise<string>",
            },
          ],
        },
        definitions: [ToolDefinition.make({ name: "lookup", description: "Lookup", inputSchema: { type: "object" } })],
        execute: () => Effect.die(new Error("unused")),
      }),
    ),
  transform: () => Effect.die(new Error("unused")),
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionBuiltIns.node,
      SessionContext.node,
      SessionReminders.node,
      PluginHooks.node,
      llmClient,
    ]),
    [
      // The production node reads the Location for its language-server reminder; these tests have none.
      SessionReminders.node.replace(SessionReminders.configured(SessionReminders.production)),
      Bus.node.replace(Bus.configured({ persist: true })),
      llmClient.replace(client),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(builtins),
      noScratchpad,
      noVcsSnapshot,
      InstructionDiscovery.node.replace(discovery),
      SkillInstructions.node.replace(skills),
      ReferenceInstructions.node.replace(references),
      McpInstructions.node.replace(mcp),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(tools),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
    ],
  ),
)

const durableState = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  Effect.all({
    sequence: Bus.latestSequence(db, sessionID),
    bus: db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie),
    messages: db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie),
    pending: db
      .select()
      .from(SessionInboxTable)
      .where(eq(SessionInboxTable.session_id, sessionID))
      .orderBy(asc(SessionInboxTable.enqueued_seq))
      .all()
      .pipe(Effect.orDie),
    instructions: db
      .select()
      .from(InstructionStateTable)
      .where(eq(InstructionStateTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie),
    blobs: db.select().from(InstructionBlobTable).orderBy(asc(InstructionBlobTable.hash)).all().pipe(Effect.orDie),
    session: db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
  })

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const agents = yield* Agent.Service
  const projects = yield* Project.Service
  const instructionBuiltIns = yield* InstructionBuiltIns.Service
  const context = yield* SessionContext.Service
  const store = yield* SessionStore.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
      slug: "generate-test",
      directory: "/project",
      title: "Generate test",
      version: "test",
      agent: Agent.ID.make("build"),
    })
    .run()
    .pipe(Effect.orDie)
  const session = yield* store.get(sessionID)
  if (!session) return yield* Effect.die("Session fixture missing")
  return {
    db,
    bus,
    session,
    instructions: yield* instructionBuiltIns.load(),
    instances: Instance.Service.of({
      // Generation only exercises the Location's model context.
      provide: () =>
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(SessionContext.Service, context),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
          ) as Layer.Layer<Instance.Services>,
        ),
    }),
  }
})

it.effect(
  "generates from fresh settled Session context without durable mutation",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      options.length = 0
      instruction = "Initial context"
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const existing = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: existing,
        item: { type: "user", payload: { text: "Existing durable context" }, delivery: "steer" },
      })
      yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID,
        inboxID: existing,
      })
      const settledAssistant = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: settledAssistant,
        agent: Agent.ID.make("build"),
        model: { id: ID.make("generate-model"), providerID: Provider.ID.make("test") },
        started: 0,
      })
      yield* bus.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: settledAssistant,
        ordinal: 0,
      })
      yield* bus.publish(SessionEvent.Text.Ended, {
        sessionID,
        assistantMessageID: settledAssistant,
        ordinal: 0,
        text: "Settled partial answer",
      })
      const activeAssistant = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: activeAssistant,
        agent: Agent.ID.make("build"),
        model: { id: ID.make("generate-model"), providerID: Provider.ID.make("test") },
        started: 0,
      })
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID: activeAssistant,
        id: "active-call",
        name: "echo",
      })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID: activeAssistant,
        id: "active-call",
        text: "{}",
      })
      yield* bus.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID: activeAssistant,
        id: "active-call",
        input: {},
        executed: false,
      })
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: SessionMessage.ID.create(),
        item: { type: "user", payload: { text: "Queued input must remain invisible" }, delivery: "queue" },
      })
      instruction = "Changed context"
      const before = yield* durableState(db, sessionID)

      const result = yield* SessionGenerate.generate({ session, prompt: "Summarize privately" }).pipe(
        Effect.provideService(Instance.Service, instances),
      )

      expect(result).toBe("Transient answer")
      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.system.map((part) => part.text)).toContain("Initial context")
      expect(requests[0]?.http?.headers).toEqual({ "User-Agent": App.useragent(App.make()) })
      expect(requests[0]?.promptCacheKey).toBe(sessionID)
      const instructionUpdates = requests[0]?.messages.flatMap((message) =>
        message.role === "system"
          ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
          : [],
      )
      expect(instructionUpdates).toHaveLength(1)
      expect(instructionUpdates?.[0]).toContain("Changed context")
      expect(instructionUpdates?.[0]).toContain("tools.captured.lookup(): Promise<string>")
      expect(userTexts(requests[0])).toEqual(["Existing durable context", "Summarize privately"])
      expect(
        requests[0]?.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
            : [],
        ),
      ).toEqual(["Settled partial answer"])
      expect(requests[0]?.tools).toMatchObject([{ name: "lookup", description: "Lookup" }])
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(options[0]?.webSocket).toBeUndefined()
      // The only durable fact is what the call spent, recorded on the Session so turn limits count it.
      const after = yield* durableState(db, sessionID)
      expect(after.bus.slice(before.bus.length).map((event) => event.type)).toEqual(["session.side_query.recorded.1"])
      expect({ ...after, bus: after.bus.slice(0, before.bus.length), sequence: before.sequence, session: before.session }).toEqual(before)
      const spent = yield* db
        .select()
        .from(SessionUsageTable)
        .where(eq(SessionUsageTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(spent.map((row) => [row.kind, row.source, row.tokens_input, row.tokens_output])).toEqual([
        ["side_query", "session.generate", 0, 10],
      ])
      expect(
        (yield* SessionTurn.usage(db, sessionID, { seq: -1, time: DateTime.makeUnsafe(0) })).tokens,
      ).toBe(10)
    }),
  { timeout: 15_000 },
)

it.effect("a generation lowers a prompt's hint and editor note like the main request, except on a minimal instance", () =>
  Effect.gen(function* () {
    instruction = "Initial context"
    const { db, bus, instructions, session, instances } = yield* setup
    yield* InstructionState.prepare(db, bus, instructions, sessionID)
    const id = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID: id,
      item: {
        type: "user",
        payload: { text: "Original prompt", agents: [{ name: "helper" }], editor: { path: "/project/open-file.ts" } },
        delivery: "steer",
      },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })
    const texts = Effect.gen(function* () {
      requests.length = 0
      yield* SessionGenerate.generate({ session, prompt: "Side question" }).pipe(Effect.provideService(Instance.Service, instances))
      return userTexts(requests[0])
    })

    const normal = yield* texts
    expect(normal).toHaveLength(4)
    expect(normal.join("\n")).toContain("helper")
    expect(normal.join("\n")).toContain("open-file.ts")
    expect(normal.at(-2)).toBe("Original prompt")

    const reminders = yield* SessionReminders.Service
    const lean = yield* texts.pipe(
      Effect.provideService(SessionReminders.Service, SessionReminders.Service.of({ ...reminders, minimal: true })),
    )
    expect(lean).toEqual(["Original prompt", "Side question"])
  }),
)

it.effect(
  "runs generate hooks instead of context hooks",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      instruction = "Initial context"
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const hooks = yield* PluginHooks.Service
      let contexts = 0
      yield* hooks.register("session", "context", () => Effect.sync(() => contexts++))
      yield* hooks.register("session", "generate", (event) =>
        Effect.sync(() => {
          expect(event.sessionID).toBe(sessionID)
          expect(event.agent).toBe(Agent.ID.make("build"))
          expect(Object.keys(event.tools)).toEqual(["lookup"])
          event.system.push(SystemPart.make("Answer briefly."))
          event.messages = [Message.user("[redacted]")]
          event.options.maxTokens = 32
          event.options.reasoningEffort = "low"
        }),
      )

      yield* SessionGenerate.generate({ session, prompt: "Summarize privately" }).pipe(
        Effect.provideService(Instance.Service, instances),
      )

      expect(contexts).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toContain("Answer briefly.")
      expect(userTexts(requests[0])).toEqual(["[redacted]"])
      expect(requests[0]?.generation).toEqual(expect.objectContaining({ maxTokens: 32 }))
      expect(requests[0]?.providerOptions).toEqual({ reasoningEffort: "low" })
    }),
  { timeout: 15_000 },
)

it.effect(
  "blocks unavailable initial instructions before generation",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      instruction = Instructions.unavailable
      const { db, session, instances } = yield* setup
      const before = yield* durableState(db, sessionID)

      const error = yield* SessionGenerate.generate({ session, prompt: "Summarize privately" }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(Instructions.InitializationBlocked)
      expect(requests).toEqual([])
      expect(yield* durableState(db, sessionID)).toEqual(before)
    }),
  { timeout: 15_000 },
)

// Generation is background work: nobody waits on it, so an overloaded provider is asked once and the caller gets the
// failure, where foreground work would back off and send the request again.
it.effect(
  "makes one request when the provider is overloaded",
  () =>
    Effect.gen(function* () {
      requests.length = 0
      instruction = "Initial context"
      const failure = overloaded()
      rejection = failure
      const { db, bus, instructions, session, instances } = yield* setup
      yield* InstructionState.prepare(db, bus, instructions, sessionID)
      const before = yield* durableState(db, sessionID)

      const error = yield* SessionGenerate.generate({ session, prompt: "Summarize privately" }).pipe(
        Effect.provideService(Instance.Service, instances),
        Effect.flip,
      )

      expect(error).toBe(failure)
      expect(requests).toHaveLength(1)
      expect(yield* durableState(db, sessionID)).toEqual(before)
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          rejection = undefined
        }),
      ),
    ),
  { timeout: 15_000 },
)
