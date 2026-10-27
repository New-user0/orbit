// context-memory-8: the analysis of what the next request carries, by category. It builds the request the runner would
// build (the same `context` hooks, the same lowering), counts it with the runner's own estimators and sends nothing.
// The rows are estimates and the total is the newest measured prompt, so the two need not agree; the rows, the reserve
// and the free space add up to the window instead.
import { describe, expect } from "bun:test"
import { TestLLM } from "@orbit/ai/testing"
import { Agent } from "@orbit/core/agent"
import { AgentInstructions } from "@orbit/core/agent/instructions"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { EventTable } from "@orbit/core/event/sql"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instance } from "@orbit/core/instance/service"
import { Instructions } from "@orbit/core/instructions/index"
import { Mcp } from "@orbit/core/mcp/index"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PromptConfigPlugin } from "@orbit/core/plugin/prompt-config"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionCompaction } from "@orbit/core/session/compaction"
import { SessionContext } from "@orbit/core/session/context"
import { SessionContextUsage } from "@orbit/core/session/context-usage"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionModelRequest } from "@orbit/core/session/model-request"
import { SessionReminders } from "@orbit/core/session/reminders"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { CLEARED_RESULT } from "@orbit/core/session/runner/to-llm-message"
import { AgentNotFoundError } from "@orbit/core/session/error"
import {
  InstructionBlobTable,
  InstructionStateTable,
  SessionInboxTable,
  SessionMessageTable,
  SessionTable,
} from "@orbit/core/session/sql"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { ToolOutput } from "@orbit/core/tool-output"
import { Token } from "@orbit/core/util/token"
import { Model } from "@orbit/schema/model"
import { Provider } from "@orbit/schema/provider"
import { Document, Info } from "@orbit/schema/config"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { CompactionPart, LanguageModel, Message, SystemPart } from "@orbit/ai"
import { OpenAIChat, OpenAIResponses } from "@orbit/ai/protocols"
import { SessionProviderContext } from "@orbit/core/session/provider-context"
import { Bus } from "@orbit/core/bus"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { ConfigInstructionPlugin } from "@orbit/core/config/plugin/instruction"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Location } from "@orbit/core/location"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { Plugin } from "@orbit/core/plugin"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { InstructionState } from "@orbit/core/session/instruction-state"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"
import { SessionStore } from "@orbit/core/session/store"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Layer } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { emptyManagedNode } from "./fixture/config-nodes"
import { emptyMcpLayer } from "./fixture/mcp"
import { seedStep, type SeededCall } from "./lib/context-history"
import { testEffect } from "./lib/effect"
import { noMemory } from "./lib/memory"
import { insertSession } from "./lib/session-row"
import {
  scenario,
  sessionID,
  transformTools,
  undersizedContextModel,
  unknownContextModel,
  type Scenario,
} from "./lib/runner"
import { stubSnapshot } from "./lib/tool"
import { noVcsSnapshot } from "./lib/vcs-snapshot"
import { agentHost, host } from "./plugin/host"

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

// The test's layer is one Location, so no other graph is needed to run the analysis in it.
const here: Instance.Interface = {
  provide: () => (effect) => effect as never,
}
const analyze = (id: Session.ID) => SessionContextUsage.analyze(id).pipe(Effect.provideService(Instance.Service, here))

const MINUTE = 60_000
const NOTHING = { type: "object" as const }
const tool = (name: string) => ({
  name,
  description: `The ${name} tool`,
  input: Schema.Struct({}),
  output: Schema.Struct({}),
  traits: { concurrencySafe: true },
  execute: () => Effect.succeed({ output: {} }),
})
const abs = (name: string) => AbsolutePath.make(path.resolve("/usage", name))

/** Tokens of one category, 0 when it is not listed. */
const tokensOf = (info: SessionContextUsage.Info, kind: SessionContextUsage.CategoryKind) =>
  info.categories.find((item) => item.kind === kind)?.tokens ?? 0
const RESERVE: ReadonlyArray<SessionContextUsage.CategoryKind> = ["auto-buffer", "compact-buffer", "free"]
const DEFERRED: ReadonlyArray<SessionContextUsage.CategoryKind> = ["mcp-deferred", "tools-deferred"]
/** The rows that are counted in the request: no deferred row, no reserve and no free space. */
const counted = (info: SessionContextUsage.Info) =>
  info.categories.filter((item) => !RESERVE.includes(item.kind) && !DEFERRED.includes(item.kind))
const countedSum = (info: SessionContextUsage.Info) => counted(info).reduce((sum, item) => sum + item.tokens, 0)

const answer = (label: string) => TestLLM.text(`answer ${label}`, `answer-${label}`)
const prompt = (s: Scenario, text: string) =>
  Effect.gen(function* () {
    yield* s.llm.push(answer(text))
    return yield* s.runPrompt(text)
  })
const read = (id: string, chars = 400): SeededCall => ({ id, name: "Read", text: `${id}:`.padEnd(chars, "x") })

/** The request the runner builds for a session that has run a step, put together the way the runner puts it together. */
const requested = (id: Session.ID) =>
  Effect.gen(function* () {
    const contexts = yield* SessionContext.Service
    const toolOutput = yield* ToolOutput.Service
    const reminders = yield* SessionReminders.Service
    const loaded = yield* contexts.load(yield* contexts.select(id))
    const transcript = SessionModelRequest.baseTranscript({
      agent: loaded.agent.info,
      model: loaded.model,
      tools: loaded.tools,
      initial: loaded.initial,
      messages: loaded.messages,
      minimal: reminders.minimal,
      toolOutput: toolOutput.root,
    })
    return yield* contexts.request.primary({
      session: loaded.session,
      agent: loaded.agent.id,
      model: loaded.model,
      tools: loaded.tools,
      system: transcript.system,
      messages: transcript.messages,
      inputTokens: SessionCompaction.estimatePrompt(loaded, reminders.minimal, toolOutput.root),
      outputTokenCap: loaded.outputTokenCap,
    })
  })

const newSession = (id: string, input: { parentID?: string; fork?: string; agent?: string; directory?: string } = {}) =>
  insertSession({ id, directory: input.directory ?? "/project", ...input })

/** A baseline row written straight into the store: the stored value of each key, as a session that ran a step holds it. */
const storeBaseline = (id: Session.ID, values: Readonly<Record<string, Schema.Json>>) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const hashes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Instructions.hash(value)]))
    yield* db
      .insert(InstructionBlobTable)
      .values(Object.values(values).map((value) => ({ hash: Instructions.hash(value), value })))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(InstructionStateTable)
      .values({ session_id: id, epoch_start: 0, through_seq: 0, initial_values: hashes, current_values: hashes })
      .run()
      .pipe(Effect.orDie)
  })

/** A source under a production key whose rendered text is `chars` characters long, and whose value is `value`. */
const source = (key: string, chars: number, value: Schema.Json = "value", fill = "i") =>
  Instructions.make({
    key: Instructions.Key.make(key),
    codec: Schema.toCodecJson(Schema.Json),
    read: Effect.succeed(value),
    render: { initial: () => fill.repeat(chars), changed: () => "c".repeat(chars) },
  })

const withUsage = (
  s: Scenario,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
) =>
  seedStep(s.bus, sessionID, {
    id: `msg_usage_${tokens.input}`,
    calls: [],
    finish: "stop",
    usage: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.read, write: tokens.write },
    },
  })

/** A response that failed after the provider had billed it: it carries usage, and an error. */
const failedStep = (s: Scenario, id: Session.ID, input: number) =>
  Effect.gen(function* () {
    const assistantMessageID = SessionMessage.ID.make(`msg_failed_${input}`)
    yield* s.bus.publish(SessionEvent.Step.Started, {
      sessionID: id,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: { id: Model.ID.make("fake-model"), providerID: Provider.ID.make("fake") },
      started: 0,
    })
    yield* s.bus.publish(SessionEvent.Step.Failed, {
      sessionID: id,
      assistantMessageID,
      error: { type: "provider.failed", message: "boom" },
      tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  })

const count = (
  s: Scenario,
  table: typeof SessionMessageTable | typeof SessionInboxTable | typeof InstructionStateTable | typeof EventTable,
) =>
  s.db
    .select()
    .from(table)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )

const registerDeferred = (name: string) =>
  Tool.Service.use((registry) => transformTools(registry, { [name]: tool(name) }))

/** MCP tools as the discovery reports them, registered the way `McpTool` registers them (direct or deferred). */
const mcpTool = (server: string, name: string, codemode: boolean): Mcp.Tool => ({
  name,
  description: `${name} of ${server}`,
  inputSchema: NOTHING,
  server: Mcp.ServerName.make(server),
  codemode,
})
const discover = (s: Scenario, tools: ReadonlyArray<Mcp.Tool>) =>
  Effect.gen(function* () {
    s.mcpTools = [...tools]
    const registry = yield* Tool.Service
    yield* Effect.forEach(
      tools,
      (found) =>
        transformTools(
          registry,
          { [found.name]: tool(found.name) },
          { codemode: found.codemode !== false, namespace: found.server.replace(/[^a-zA-Z0-9_-]/g, "_") },
        ),
      { discard: true },
    )
  })

const userConfig = (info: unknown, scope: "user" | "project" = "user") =>
  new Document({ type: "document", scope, info: Schema.decodeUnknownSync(Info)(info) })

/** The prompt keys of the config need the plugin that applies them, as a server runs it. */
const activatePromptConfig = (s: Scenario) =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const agents = yield* Agent.Service
    yield* PromptConfigPlugin.Plugin.effect(
      host({
        agent: agentHost(agents),
        session: {
          hook: (name, callback) => hooks.register("session", name, callback),
          get: (input) => s.session.get(input.sessionID),
        },
      }),
    )
  })

// ---------------------------------------------------------------------------------------------------------------------
// The sum and the total

// U1, Q1: the counted rows, the reserve and the free space fill the window; a deferred row is listed and left out.
scenario("rows, reserve and free space sum to the window when free space is above 0", function* (s) {
  yield* registerDeferred("lookup")
  yield* prompt(s, "look at the file")
  yield* seedStep(s.bus, sessionID, { id: "msg_u1", calls: [read("u1c", 2_000)], inputTokens: 50_000 })
  const info = yield* analyze(sessionID)

  expect(info.window).toBe(200_000)
  expect(tokensOf(info, "tools-deferred")).toBeGreaterThan(0)
  const reserve = tokensOf(info, "auto-buffer")
  const free = tokensOf(info, "free")
  expect(reserve).toBeGreaterThan(0)
  expect(free).toBeGreaterThan(0)
  expect(countedSum(info) + reserve + free).toBe(info.window!)
})

// U2, S4: each token is counted once, and the counted rows are what the runner estimates for the request it builds.
scenario("the counted rows equal the runner's estimate of the request it would build", function* (s) {
  // Lengths of 2 modulo 4, so that where a key sits in the baseline decides how many tokens its share is.
  const table = [
    ["core/language", 38, "l"],
    ["core/skill-guidance", 50, "s"],
    ["core/memory-index", 30, "m"],
    ["core/date", 14, "d"],
  ] as const
  s.extraSources = Instructions.combine(
    table.map(([key, chars, fill]) =>
      source(key, chars, key === "core/memory-index" ? { path: "/m/MEMORY.md", content: "m" } : "value", fill),
    ),
  )
  yield* registerDeferred("lookup")
  yield* prompt(s, "first")
  yield* seedStep(s.bus, sessionID, { id: "msg_u2", calls: [read("u2c", 1_001)] })
  const info = yield* analyze(sessionID)
  const prepared = yield* requested(sessionID)

  expect(countedSum(info)).toBe(SessionCompaction.estimateRequest(prepared.request))
  // A key's share is its place in the one baseline part, found here by searching for its text.
  const baseline = prepared.request.system.find((part) => part.text.includes("s".repeat(50)))!.text
  const shareOf = ([, chars, fill]: (typeof table)[number]) => {
    const at = baseline.indexOf(fill.repeat(chars))
    return Token.estimateLength(at + chars) - Token.estimateLength(at)
  }
  const sections = Object.fromEntries(info.sections.map((section) => [section.name, section.tokens]))
  expect(sections["core/language"]).toBe(shareOf(table[0]))
  expect(tokensOf(info, "skills")).toBe(shareOf(table[1]))
  expect(tokensOf(info, "instructions")).toBe(shareOf(table[2]))
  expect(sections["core/date"]).toBe(shareOf(table[3]))
})

// U3, S8: the total is what the provider reported for the prompt, and not what it generated.
scenario("the total is the newest measured input plus cache read and cache write, without output", function* (s) {
  yield* prompt(s, "first")
  yield* withUsage(s, { input: 1_000, output: 400, reasoning: 30, read: 200, write: 50 })
  const info = yield* analyze(sessionID)

  expect(info.measured).toBe(true)
  expect(info.total).toBe(1_250)
  expect(info.percentage).toBe(Math.round((1_250 / info.window!) * 100))
})

// U4, class 7: no response yet, or a failed one, leaves the estimate.
scenario("with no measured response the total is the sum of the counted rows", function* (s) {
  yield* s.admit("not answered yet")
  yield* failedStep(s, sessionID, 7_000)
  const info = yield* analyze(sessionID)

  expect(info.measured).toBe(false)
  expect(info.total).toBe(countedSum(info))
  expect(info.total).not.toBe(7_000)
})

// U5, class 7: another provider's count may describe a window this model cannot replay.
scenario("a response of another provider is not the measurement", function* (s) {
  yield* prompt(s, "first")
  yield* seedStep(s.bus, sessionID, {
    id: "msg_other",
    calls: [],
    finish: "stop",
    inputTokens: 90_000,
    model: { id: Model.ID.make("their-model"), providerID: Provider.ID.make("theirs") },
  })
  const info = yield* analyze(sessionID)

  expect(info.measured).toBe(false)
  expect(info.total).toBe(countedSum(info))
})

// ---------------------------------------------------------------------------------------------------------------------
// Where each row comes from

const File = Schema.toCodecJson(Schema.Array(InstructionDiscovery.File))
const files = [
  new InstructionDiscovery.File({ path: abs("ORBIT.md"), content: "project rules", kind: "local" }),
  new InstructionDiscovery.File({ path: abs("docs/more.md"), content: "more rules" }),
]
const filesSource = (chars: number) =>
  Instructions.make({
    key: Instructions.Key.make("core/instructions"),
    codec: File,
    read: Effect.succeed(files),
    render: { initial: () => "f".repeat(chars), changed: () => "f".repeat(chars) },
  })

// U8, S1 and class 1 (hook): the system prompt row counts what the context hooks build, which only the person's own
// settings may change.
scenario("the system prompt row counts what the context hooks build", function* (s) {
  yield* activatePromptConfig(s)
  const config = s.configControl!
  const file = path.join(os.tmpdir(), `orbit-usage-prompt-${crypto.randomUUID()}.md`)
  yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(file, { force: true })))
  yield* Effect.promise(() => fs.writeFile(file, "w".repeat(20_000)))
  yield* prompt(s, "first")

  const control = tokensOf(yield* analyze(sessionID), "system")
  // 3,998 characters and the two of the separator: exactly 1,000 more tokens, whatever the base's length.
  yield* config.setEntries([userConfig({ append_system_prompt: "a".repeat(3_998) })])
  expect(tokensOf(yield* analyze(sessionID), "system")).toBe(control + 1_000)
  // A project's own settings never supply it.
  yield* config.setEntries([userConfig({ append_system_prompt: "a".repeat(3_998) }, "project")])
  expect(tokensOf(yield* analyze(sessionID), "system")).toBe(control)
  // The replacement file counts as the hook reads it, and only from the person's own settings.
  yield* config.setEntries([userConfig({ system_prompt_file: file }, "project")])
  expect(tokensOf(yield* analyze(sessionID), "system")).toBe(control)
  yield* config.setEntries([userConfig({ system_prompt_file: file })])
  expect(tokensOf(yield* analyze(sessionID), "system")).toBeGreaterThanOrEqual(5_000)
})

// U9, S4, S5 and class 7 (a value that does not decode).
scenario("each baseline key lands in its category", function* (s) {
  const table: ReadonlyArray<
    readonly [key: string, chars: number, kind: SessionContextUsage.CategoryKind, value?: Schema.Json]
  > = [
    ["core/memory-index", 48, "instructions", { path: "/m/MEMORY.md", content: "m" }],
    ["core/team-memory-index", 52, "instructions", { path: "/t/MEMORY.md", content: "t" }],
    ["core/skill-guidance", 60, "skills", [{ id: "alpha", description: "does alpha" }]],
    ["core/reference-guidance", 64, "system"],
    ["core/memory-guide", 68, "system"],
    ["core/language", 72, "system"],
    ["core/date", 76, "system"],
    ["core/environment", 80, "system"],
    ["core/vcs-snapshot", 84, "system"],
    ["core/scratchpad", 88, "system"],
    ["api/x", 92, "system"],
  ]
  s.extraSources = Instructions.combine([
    filesSource(40),
    ...table.map(([key, chars, , value]) => source(key, chars, value)),
  ])
  yield* s.admit("a fresh session")
  const info = yield* analyze(sessionID)

  expect(tokensOf(info, "instructions")).toBe(
    (40 + table.filter((row) => row[2] === "instructions").reduce((sum, row) => sum + row[1], 0)) / 4,
  )
  expect(tokensOf(info, "skills")).toBe(15)
  // A system key is a section of its own, named by the key; the instruction and skill keys are not.
  const sections = Object.fromEntries(info.sections.map((section) => [section.name, section.tokens]))
  for (const [key, chars, kind] of table) {
    if (kind === "system") expect(sections[key]).toBe(chars / 4)
    else expect(key in sections).toBe(false)
  }
  expect("core/instructions" in sections).toBe(false)
  expect(info.files.map((item) => [item.path, item.type])).toEqual([
    [files[0]!.path, "local"],
    [files[1]!.path, "file"],
    ["/m/MEMORY.md", "memory"],
    ["/t/MEMORY.md", "team-memory"],
  ])
  expect(info.files.map((item) => item.tokens).every((tokens) => tokens > 0)).toBe(true)
  // An index is one entry of the key, so its size is the key's share.
  expect(info.files.slice(2).map((item) => item.tokens)).toEqual([12, 13])
  expect(info.skills.map((item) => item.id)).toEqual(["alpha"])
  expect(info.skills[0]!.tokens).toBe(
    Token.estimate(SkillInstructions.line({ id: "alpha", description: "does alpha" })),
  )
})

scenario("a stored value that does not decode renders nothing and lists no file", function* (s) {
  s.extraSources = Instructions.combine([filesSource(40)])
  yield* s.admit("a session with a stored baseline")
  yield* storeBaseline(sessionID, { "core/instructions": "this is not a list of files" })
  const info = yield* analyze(sessionID)

  expect(info.files).toEqual([])
  expect(tokensOf(info, "instructions")).toBe(0)
  // A source the stored baseline has no value for contributes no part.
  expect(info.sections.map((section) => section.name)).not.toContain("test/context")})

// U20, class 7.
scenario("a fresh session whose source is unavailable fails with InitializationBlocked", function* (s) {
  s.systemUnavailable = true
  yield* s.admit("a fresh session")
  const failure = yield* Effect.flip(analyze(sessionID))

  expect(failure).toBeInstanceOf(Instructions.InitializationBlocked)
  expect((failure as Instructions.InitializationBlocked).keys).toEqual([Instructions.Key.make("test/context")])
  expect(yield* count(s, InstructionStateTable)).toBe(0)
})

// U21, S10.
scenario(
  "system prompt sections are named by the first heading or the first line cut to 40 characters, and baseline sections by key",
  function* (s) {
    const hooks = yield* PluginHooks.Service
    const long = "This opening line of the prompt is longer than forty characters."
    const parts = [`Intro\n\n# Plain heading\nThe rest of the part.`, `\n\n${long}\nMore.`, "Short line"]
    yield* hooks.register("session", "context", (event) =>
      Effect.sync(() => void event.system.push(...parts.map((text) => SystemPart.make(text)))),
    )
    yield* prompt(s, "first")
    const info = yield* analyze(sessionID)

    const sections = Object.fromEntries(info.sections.map((section) => [section.name, section.tokens]))
    expect(sections["Plain heading"]).toBe(Token.estimate(parts[0]!))
    expect(sections[`${long.slice(0, 40)}…`]).toBe(Token.estimate(parts[1]!))
    expect(sections["Short line"]).toBe(Token.estimate(parts[2]!))
    // The baseline's own sections are named by their key.
    expect(sections["test/context"]).toBe(Token.estimate("Initial context"))
  },
)

scenario("custom agents are counted in their own row, once", function* (s) {
  const registry = yield* Tool.Service
  yield* transformTools(registry, { Agent: tool("Agent") }, { codemode: false })
  const agents = yield* Agent.Service
  // The listing line is `- custom: <description> (all tools)`; pad it to a whole number of tokens so that its share of
  // the baseline is exact wherever it falls.
  let description = "Reviews the code"
  while (AgentInstructions.line({ id: "custom", description, tools: "all tools" }).length % 4 !== 0) description += "."
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("custom"), (agent) => {
      agent.mode = "subagent"
      agent.description = description
      agent.source = { scope: "project" }
    })
    // An agent type Orbit ships has no source: its line stays with the tool guidance.
    editor.update(Agent.ID.make("shipped"), (agent) => {
      agent.mode = "subagent"
      agent.description = "Ships with Orbit"
    })
  })
  yield* prompt(s, "first")
  const info = yield* analyze(sessionID)
  const prepared = yield* requested(sessionID)

  expect(info.agents.map((item) => [item.id, item.scope])).toEqual([["custom", "project"]])
  expect(info.agents[0]!.tokens).toBe(
    Token.estimate(AgentInstructions.line({ id: "custom", description, tools: "all tools" })),
  )
  expect(tokensOf(info, "agents")).toBe(info.agents[0]!.tokens)
  // The agent types Orbit ships stay in the tools row, with the rest of the listing, so nothing is counted twice.
  expect(countedSum(info)).toBe(SessionCompaction.estimateRequest(prepared.request))
})

// ---------------------------------------------------------------------------------------------------------------------
// History

// U10, context-memory-4 hand-off and S8.
scenario(
  "a retained checkpoint's kept span counts in Messages, and only a response after the checkpoint is the measurement",
  function* (s) {
    for (const n of [1, 2, 3, 4]) {
      yield* s.llm.push(TestLLM.textWithUsage(`answer ${n}`, `answer-${n}`, 150_000))
      yield* s.session.prompt({ sessionID, text: `prompt ${n}`, resume: false })
      yield* s.session.resume(sessionID)
    }
    const before = yield* analyze(sessionID)
    expect(before.measured).toBe(true)
    expect(before.total).toBe(150_000)

    const all = yield* s.session.messages({ sessionID, order: "asc" })
    const start = all.find((message) => message.type === "user" && message.text === "prompt 3")!.id
    const contexts = yield* SessionContext.Service
    const compaction = yield* SessionCompaction.Service
    const inputID = SessionMessage.ID.create()
    yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID })
    yield* s.llm.push(TestLLM.text("## Objective\n- first summary", "summary-first"))
    const context = yield* contexts.load(yield* contexts.select(sessionID))
    expect((yield* compaction.compact({ reason: "manual", context, inputID, retain: start })).status).toBe("completed")

    const after = yield* analyze(sessionID)
    // The kept answers still carry the usage of the large requests they were made in; none of it is the measurement.
    expect(after.measured).toBe(false)
    expect(after.total).toBe(countedSum(after))
    expect(after.total).toBeLessThan(100_000)
    const prepared = yield* requested(sessionID)
    expect(tokensOf(after, "messages")).toBe(
      prepared.request.messages.reduce((sum, message) => sum + SessionCompaction.estimateMessage(message), 0),
    )
    // The summary plus the two kept prompts and their answers: more than the summary alone.
    expect(prepared.request.messages.length).toBeGreaterThanOrEqual(5)

    yield* s.llm.push(TestLLM.textWithUsage("answer 5", "answer-5", 21_000))
    yield* s.runPrompt("prompt 5")
    const next = yield* analyze(sessionID)
    expect(next.measured).toBe(true)
    expect(next.total).toBe(21_000)
  },
)

// U11, context-memory-3 hand-off and S7.
scenario("a cleared result counts as its placeholder", function* (s) {
  const compaction = yield* SessionCompaction.Service
  const analyzed = (name: string, clear: boolean) =>
    Effect.gen(function* () {
      yield* compaction.transform((editor) => editor.configure({ clear }))
      const id = Session.ID.make(`ses_usage_${name}`)
      yield* newSession(id)
      yield* seedStep(s.bus, id, {
        id: `msg_${name}`,
        calls: Array.from({ length: 8 }, (_, n) => read(`${name}${n + 1}`)),
      })
      yield* TestClock.adjust(61 * MINUTE)
      yield* s.llm.push(TestLLM.text("done", `done-${name}`))
      yield* s.session.prompt({ sessionID: id, text: "next", resume: false })
      yield* s.session.resume(id)
      return { id, info: yield* analyze(id) }
    })
  const kept = yield* analyzed("kept", false)
  const cleared = yield* analyzed("cleared", true)

  const rows = yield* s.session.messages({ sessionID: cleared.id, order: "asc" })
  expect(rows.some((message) => message.type === "context-cleared")).toBe(true)
  // Three results of 100 tokens each go out as the 13 tokens of the placeholder.
  const saved = 3 * (Token.estimate("c".repeat(400)) - Token.estimate(CLEARED_RESULT))
  expect(tokensOf(kept.info, "messages") - tokensOf(cleared.info, "messages")).toBe(saved)
  const readsOf = (info: SessionContextUsage.Info) => info.messages.tools.find((item) => item.name === "Read")!.results
  expect(readsOf(kept.info) - readsOf(cleared.info)).toBe(saved)
  // The stored output is still whole.
  const stored = rows.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "tool" && part.state.status === "completed" ? [part.state.content] : [],
        )
      : [],
  )
  expect(stored).toHaveLength(8)
  expect(stored.every((content) => content[0]?.type === "text" && content[0].text.length === 400)).toBe(true)
})

// S7: a result the step saved reaches the model as its short wrapper, and the analysis counts what the request carries.
scenario("a saved result counts as the wrapper the request carries", function* (s) {
  yield* prompt(s, "first")
  yield* seedStep(s.bus, sessionID, {
    id: "msg_saved",
    calls: [
      {
        id: "saved1",
        name: "Read",
        text: "s".repeat(40_000),
        metadata: {
          persisted: { session: sessionID, name: "msg_0123abc-saved1-1a2b3c4d.txt", size: 40_000, format: 1 },
        },
      },
    ],
  })
  const info = yield* analyze(sessionID)
  const prepared = yield* requested(sessionID)
  const results = prepared.request.messages
    .flatMap((message) => message.content)
    .filter((part) => part.type === "tool-result")
    .reduce((sum, part) => sum + SessionCompaction.estimatePart(part), 0)

  expect(results).toBeLessThan(2_000)
  expect(info.messages.toolResults).toBe(results)
  expect(tokensOf(info, "messages")).toBe(
    prepared.request.messages.reduce((sum, message) => sum + SessionCompaction.estimateMessage(message), 0),
  )
})

// A native window of another provider cannot be replayed by this model, so history keeps the original messages and the
// analysis counts them, as the runner loads them.
scenario("a native checkpoint of another provider is not counted", function* (s) {
  yield* prompt(s, "first")
  const native = SessionRunnerModel.resolved(
    LanguageModel.make({ id: "deployment", provider: "openai", route: OpenAIResponses.route }),
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      cost: [],
      limit: { context: 128_000, output: 4096 },
    },
  )
  const context = SessionProviderContext.encode(SessionProviderContext.provenance(native)!, [
    Message.user("retained request ".repeat(200)),
    Message.assistant(
      CompactionPart.make({ provider: native.model.provider, encrypted: "opaque-checkpoint", id: "cp_1" }),
    ),
  ])
  yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
  yield* s.bus.publish(SessionEvent.Compaction.Ended, {
    sessionID,
    reason: "manual",
    text: "",
    recent: "",
    providerContext: context,
  })
  const info = yield* analyze(sessionID)
  const prepared = yield* requested(sessionID)

  expect(tokensOf(info, "messages")).toBe(
    prepared.request.messages.reduce((sum, message) => sum + SessionCompaction.estimateMessage(message), 0),
  )
  expect(tokensOf(info, "messages")).toBeLessThan(800)
})

// U12, class 12, class 6 and V2 read-only.
scenario("the analysis records nothing and calls no model", function* (s) {
  yield* registerDeferred("lookup")
  yield* seedStep(s.bus, sessionID, {
    id: "msg_idle",
    calls: Array.from({ length: 8 }, (_, n) => read(`idle${n + 1}`)),
  })
  yield* TestClock.adjust(61 * MINUTE)
  const before = {
    messages: yield* count(s, SessionMessageTable),
    events: yield* count(s, EventTable),
    inbox: yield* count(s, SessionInboxTable),
    state: yield* count(s, InstructionStateTable),
    requests: s.requests.length,
  }
  yield* analyze(sessionID)
  yield* analyze(sessionID)

  expect({
    messages: yield* count(s, SessionMessageTable),
    events: yield* count(s, EventTable),
    inbox: yield* count(s, SessionInboxTable),
    state: yield* count(s, InstructionStateTable),
    requests: s.requests.length,
  }).toEqual(before)
  // An hour of quiet clears old results at a step, and the analysis is not a step.
  const rows = yield* s.session.messages({ sessionID, order: "asc" })
  expect(rows.some((message) => message.type === "context-cleared")).toBe(false)
})

// U13, S7 and class 5.
scenario("the message breakdown attributes calls and results per canonical tool name", function* (s) {
  yield* prompt(s, "first")
  s.systemBaseline = "Initial context, changed"
  yield* prompt(s, "second")
  yield* seedStep(s.bus, sessionID, {
    id: "msg_names",
    calls: [
      { id: "n1", name: "shell", text: "s".repeat(40) },
      { id: "n2", name: "read", text: "r".repeat(4_000) },
      { id: "n3", name: "../x", text: "x".repeat(80) },
    ],
  })
  yield* s.bus.publish(SessionEvent.Synthetic, {
    sessionID,
    text: "A reminder of the todo kind",
    metadata: { reminder: { kind: "todo" } },
  })
  const info = yield* analyze(sessionID)

  // The old spellings are lowered under the current names, and the largest tool is first.
  expect(info.messages.tools.map((item) => item.name)).toEqual(["Read", "../x", "Bash"])
  const read = info.messages.tools.find((item) => item.name === "Read")!
  expect(read.results).toBe(Token.estimate("r".repeat(4_000)))
  expect(read.calls).toBeGreaterThan(0)
  expect(info.messages.toolCalls).toBe(info.messages.tools.reduce((sum, item) => sum + item.calls, 0))
  expect(info.messages.toolResults).toBe(info.messages.tools.reduce((sum, item) => sum + item.results, 0))
  // A reminder counts under its kind, and the update of an instruction under attachments, not as a file.
  const kinds = Object.fromEntries(info.messages.attachmentKinds.map((item) => [item.name, item.tokens]))
  expect(kinds["todo"]).toBe(Token.estimate("A reminder of the todo kind"))
  expect(kinds["instructions"]).toBeGreaterThan(0)
  // Largest first.
  expect(info.messages.attachmentKinds.map((item) => item.name)).toEqual(["todo", "instructions"])
  expect(info.messages.attachments).toBe(info.messages.attachmentKinds.reduce((sum, item) => sum + item.tokens, 0))
  expect(info.messages.user).toBeGreaterThan(0)
  expect(info.messages.assistant).toBeGreaterThan(0)
  expect(info.files).toEqual([])
  // The baseline is the stored one, not the changed text that the update row carries.
  expect(info.sections.find((section) => section.name === "test/context")?.tokens).toBe(
    Token.estimate("Initial context"),
  )
})

// ---------------------------------------------------------------------------------------------------------------------
// The window

// U14, S9.
scenario(
  "the reserve is window minus the threshold with automatic compaction on, and the 3,000 compact buffer with it off",
  function* (s) {
    const compaction = yield* SessionCompaction.Service
    yield* prompt(s, "first")
    const table = [
      ["automatic compaction on with the default buffer", undefined, true, "auto-buffer"],
      ["automatic compaction on with a larger buffer", 30_000, true, "auto-buffer"],
      ["automatic compaction off", undefined, false, "compact-buffer"],
    ] as const
    for (const [, buffer, auto, kind] of table) {
      yield* compaction.transform((editor) => editor.configure({ auto, buffer }))
      const info = yield* analyze(sessionID)

      expect(info.auto).toBe(auto)
      expect(RESERVE.filter((item) => item !== "free").filter((item) => tokensOf(info, item) > 0)).toEqual([kind])
      if (!auto) {
        expect(tokensOf(info, "compact-buffer")).toBe(3_000)
        continue
      }
      // 200,000 less the room for a 32,000-token reply capped at 20,000, less the buffer.
      const threshold = Math.max(200_000 - 20_000 - (buffer ?? 13_000), 100_000)
      expect(info.threshold).toBe(threshold)
      expect(tokensOf(info, "auto-buffer")).toBe(200_000 - threshold)
    }

    // The configured output cap shrinks the room kept for the reply, so the threshold moves up with it.
    yield* s.configControl!.setEntries([userConfig({ output_token_cap: 4_000 })])
    yield* compaction.transform((editor) => editor.configure({ auto: true, buffer: undefined }))
    expect((yield* analyze(sessionID)).threshold).toBe(200_000 - 4_000 - 13_000)
  },
)

// U15, Differ 6 and class 7.
scenario("an unknown window gives rows and the total but no percentage, reserve or free space", function* (s) {
  s.currentModel = unknownContextModel
  yield* prompt(s, "first")
  yield* withUsage(s, { input: 900, output: 10, reasoning: 0, read: 0, write: 0 })
  const info = yield* analyze(sessionID)

  expect(info.window).toBeUndefined()
  expect(info.percentage).toBeUndefined()
  expect(info.threshold).toBeUndefined()
  expect(info.total).toBe(900)
  expect(countedSum(info)).toBeGreaterThan(0)
  expect(info.categories.filter((item) => RESERVE.includes(item.kind))).toEqual([])
})

// U16, Q1 floor.
scenario("free space never goes below 0", function* (s) {
  s.currentModel = undersizedContextModel
  yield* prompt(s, "first")
  const info = yield* analyze(sessionID)

  expect(info.window).toBe(1)
  expect(info.categories.find((item) => item.kind === "free")).toEqual({ kind: "free", tokens: 0 })
  expect(countedSum(info) + tokensOf(info, "auto-buffer")).toBeGreaterThan(info.window!)
})

// ---------------------------------------------------------------------------------------------------------------------
// Which session

// U17, Q4 and classes 3, 7 and 13: a table of sessions, each with its own explicit result.
scenario("only a main session in this Location is analysed", function* (s) {
  yield* prompt(s, "first")
  const hooks = yield* PluginHooks.Service
  let events = 0
  yield* hooks.register("session", "context", () => Effect.sync(() => void events++))

  // A child session: refused before any source or hook is touched.
  yield* newSession("ses_usage_child", { parentID: sessionID })
  const states = yield* count(s, InstructionStateTable)
  const child = yield* Effect.flip(analyze(Session.ID.make("ses_usage_child")))
  expect(child).toBeInstanceOf(Session.MainSessionOnlyError)
  expect(child).toMatchObject({ sessionID: "ses_usage_child", parentID: sessionID })
  expect((child as Session.MainSessionOnlyError).message).toBe(
    `Session ses_usage_child belongs to ${sessionID}; ask for the main session instead`,
  )
  expect(events).toBe(0)
  expect(yield* count(s, InstructionStateTable)).toBe(states)

  // An unknown session.
  expect(yield* Effect.flip(analyze(Session.ID.make("ses_usage_missing")))).toBeInstanceOf(Session.NotFoundError)

  // A model that does not resolve, and an agent that does not.
  s.modelResolveHook = Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID }))
  expect(yield* Effect.flip(analyze(sessionID))).toBeInstanceOf(SessionRunnerModel.ModelNotSelectedError)
  s.modelResolveHook = Effect.void
  yield* newSession("ses_usage_agent", { agent: "no-such-agent" })
  expect(yield* Effect.flip(analyze(Session.ID.make("ses_usage_agent")))).toBeInstanceOf(AgentNotFoundError)

  // A session of another Location is not analysed from this one: its selection interrupts.
  yield* newSession("ses_usage_elsewhere", { directory: "/elsewhere" })
  const elsewhere = yield* Effect.exit(analyze(Session.ID.make("ses_usage_elsewhere")))
  expect(Exit.isFailure(elsewhere) && Exit.hasInterrupts(elsewhere)).toBe(true)

  // A fork is a main session.
  yield* newSession("ses_usage_fork", { fork: sessionID })
  expect((yield* analyze(Session.ID.make("ses_usage_fork"))).window).toBe(200_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// Tools

// U18, S6 and class 7.
scenario("MCP tools are split by their server and deferred tools are listed but not counted", function* (s) {
  yield* registerDeferred("lookup")
  yield* discover(s, [mcpTool("alpha", "direct", false), mcpTool("alpha", "later", true)])
  yield* prompt(s, "first")
  const info = yield* analyze(sessionID)
  const prepared = yield* requested(sessionID)

  expect(info.mcp.map((item) => [item.name, item.server, item.deferred])).toEqual([
    ["alpha_direct", "alpha", false],
    ["alpha_later", "alpha", true],
  ])
  const direct = prepared.request.tools.find((item) => item.name === "alpha_direct")!
  expect(tokensOf(info, "mcp")).toBe(SessionCompaction.estimateTool(direct))
  expect(info.mcp[0]!.tokens).toBe(tokensOf(info, "mcp"))
  expect(tokensOf(info, "mcp-deferred")).toBe(info.mcp[1]!.tokens)
  expect(info.deferredTools.map((item) => item.name)).toEqual(["lookup"])
  expect(tokensOf(info, "tools-deferred")).toBe(info.deferredTools[0]!.tokens)
  expect(info.systemTools.map((item) => item.name)).not.toContain("alpha_direct")
  expect(countedSum(info)).toBe(SessionCompaction.estimateRequest(prepared.request))
  const total =
    counted(info).reduce((sum, item) => sum + item.tokens, 0) + tokensOf(info, "auto-buffer") + tokensOf(info, "free")
  expect(total).toBe(info.window!)
})

scenario("an empty discovery gives no MCP rows, and denying Execute gives no deferred rows", function* (s) {
  yield* registerDeferred("lookup")
  yield* prompt(s, "first")
  const empty = yield* analyze(sessionID)
  expect(empty.mcp).toEqual([])
  expect(tokensOf(empty, "mcp")).toBe(0)
  expect(tokensOf(empty, "mcp-deferred")).toBe(0)
  expect(tokensOf(empty, "tools-deferred")).toBeGreaterThan(0)
  // A row with nothing in it is left out.
  expect(empty.categories.map((item) => item.kind)).not.toContain("mcp")
  expect(empty.categories.map((item) => item.kind)).not.toContain("mcp-deferred")

  yield* s.db
    .update(SessionTable)
    .set({ permission: [{ action: "Execute", resource: "*", effect: "deny" }] })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
  const denied = yield* analyze(sessionID)
  expect(denied.deferredTools).toEqual([])
  expect(tokensOf(denied, "tools-deferred")).toBe(0)
  expect(denied.categories.map((item) => item.kind)).not.toContain("tools-deferred")
})

scenario("the catalog of deferred tools is counted as tools, not as a system section", function* (s) {
  yield* registerDeferred("lookup")
  yield* prompt(s, "first")
  const info = yield* analyze(sessionID)

  expect(tokensOf(info, "tools")).toBeGreaterThan(info.systemTools.reduce((sum, item) => sum + item.tokens, 0))
  expect(info.sections.map((section) => section.name)).not.toContain("core/codemode")
})

scenario("a completed checkpoint counts under attachments as a checkpoint", function* (s) {
  yield* prompt(s, "first")
  yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "" })
  yield* s.bus.publish(SessionEvent.Compaction.Ended, {
    sessionID,
    reason: "manual",
    text: "S".repeat(400),
    recent: "",
  })
  const info = yield* analyze(sessionID)

  expect(info.messages.attachmentKinds.map((item) => item.name)).toContain("checkpoint")
})

// U19, class 9 (core half).
scenario("strings from files and servers are carried unchanged", function* (s) {
  const hostile = "\u001b[31m\u0007‮evil"
  s.extraSources = Instructions.make({
    key: Instructions.Key.make("core/instructions"),
    codec: Schema.toCodecJson(Schema.Array(InstructionDiscovery.File)),
    read: Effect.succeed([
      new InstructionDiscovery.File({ path: AbsolutePath.make(`/usage/${hostile}.md`), content: "x" }),
    ]),
    render: { initial: () => "files", changed: () => "files" },
  })
  yield* discover(s, [mcpTool(`srv${hostile}`, `tool${hostile}`, false)])
  yield* prompt(s, "first")
  const info = yield* analyze(sessionID)

  expect(info.files[0]!.path).toBe(`/usage/${hostile}.md`)
  expect(info.mcp[0]!.server).toBe(`srv${hostile}`)
  const encoded = Schema.encodeSync(SessionContextUsage.Info)(info)
  expect(Schema.decodeUnknownSync(SessionContextUsage.Info)(JSON.parse(JSON.stringify(encoded)))).toEqual(info)
})

// ---------------------------------------------------------------------------------------------------------------------
// The instruction files (class 1)

// The real instruction discovery, over folders on disk, with the folder trusted or not. The rest of the graph is the
// real session context over stand-ins that say nothing, as the layout test has it.
const base = path.join(os.tmpdir(), `orbit-usage-${crypto.randomUUID()}`)
const project = path.join(base, "project")
const aboveFile = path.join(base, "ORBIT.md")
const projectFile = path.join(project, "ORBIT.md")
const MARKER = "MARKER-7f3a"

const usageLayer = (trusted: boolean) => {
  const watcher = Watcher.testLayer
  const config = Config.testLayer()
  const nothing = Effect.succeed(Instructions.empty)
  return Layer.mergeAll(
    config,
    watcher,
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Project.node,
        SessionProjector.node,
        SessionStore.node,
        Agent.node,
        InstructionEntry.node,
        InstructionDiscovery.node,
        Global.node,
        WorkspaceTrust.node,
        Watcher.node,
        ManagedSettings.node,
        ProjectTrust.node,
        SessionCompaction.node,
        SessionContext.node,
        Location.node,
        FSUtil.node,
        Mcp.node,
        Plugin.node,
        ToolOutput.node,
        SessionReminders.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        Config.node.replace(config),
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: trusted })),
        Watcher.node.replace(watcher),
        ManagedSettings.node.replace(emptyManagedNode),
        Mcp.node.replace(emptyMcpLayer),
        Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
        noMemory,
        noVcsSnapshot,
        InstructionBuiltIns.node.replace(
          Layer.mock(InstructionBuiltIns.Service, {
            preferences: () => Effect.succeed(Instructions.empty),
            toolResults: InstructionBuiltIns.toolResultsSource,
            load: () => Effect.succeed(Instructions.empty),
          }),
        ),
        SessionRunnerModel.node.replace(
          Layer.mock(SessionRunnerModel.Service)({
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "primary", provider: "test", route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 32_000 },
                  },
                ),
              ),
          }),
        ),
        AgentInstructions.node.replace(Layer.mock(AgentInstructions.Service, { load: () => nothing })),
        SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => nothing })),
        ReferenceInstructions.node.replace(Layer.mock(ReferenceInstructions.Service, { load: () => nothing })),
        McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => nothing })),
        SessionScratchpad.node.replace(
          Layer.mock(SessionScratchpad.Service, {
            path: () => undefined,
            source: () => Instructions.empty,
            ensure: () => Effect.void,
          }),
        ),
        PluginSupervisor.node.replace(Layer.empty),
        Tool.node.replace(
          Layer.mock(Tool.Service, {
            snapshot: () =>
              Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
          }),
        ),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
            ),
          ),
        ),
      ],
    ),
  )
}

const folders = Effect.gen(function* () {
  yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
  yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(base, { recursive: true, force: true })))
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
  })
  yield* insertSession({ id: sessionID, directory: project, agent: "build" })
})

// The plugin that reads the files runs after the test has written them, as a server starts it.
const scan = Effect.fnUntraced(function* () {
  yield* ConfigInstructionPlugin.Plugin.effect(host())
})

const plain = testEffect(Layer.empty)
const listed = (info: SessionContextUsage.Info) => info.files.map((item) => item.path)
const states = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return (yield* db.select().from(InstructionStateTable).all().pipe(Effect.orDie)).length
})

// One fresh session over the real discovery, in a folder that is trusted or not, with `written` on disk.
const fresh = (trusted: boolean, written: ReadonlyArray<readonly [file: string, text: string]>) =>
  Effect.gen(function* () {
    yield* folders
    yield* Effect.forEach(written, ([file, text]) => Effect.promise(() => fs.writeFile(file, text)), { discard: true })
    yield* scan()
    return { info: yield* analyze(sessionID), states: yield* states }
  }).pipe(Effect.scoped, Effect.provide(usageLayer(trusted)))

// U7, classes 1 (fresh) and 14. What trust holds back from a step is held back from the analysis, and a trusted control
// lists the same file. The analysis goes through the step's own sources and stores nothing. The project's own files are
// read whether or not the folder is trusted (`instruction-discovery.test.ts` pins that), so the file that trust holds
// back here is the one in the folder above the project.
plain.live("a fresh session lists the instruction files the step would read, and none from an untrusted folder", () =>
  Effect.gen(function* () {
    const control = yield* fresh(true, [[aboveFile, MARKER]])
    expect(listed(control.info)).toContain(aboveFile)
    expect(control.info.files.find((item) => item.path === aboveFile)!.tokens).toBeGreaterThan(0)
    expect(tokensOf(control.info, "instructions")).toBeGreaterThanOrEqual(Token.estimate(MARKER))
    expect(control.states).toBe(0)

    const held = yield* fresh(false, [
      [aboveFile, MARKER],
      [projectFile, "the project's own rules"],
    ])
    expect(listed(held.info)).toEqual([projectFile])
    expect(JSON.stringify(held.info)).not.toContain(MARKER)
    expect(held.states).toBe(0)

    // The same marker in a file of the project is read, trusted or not.
    for (const trusted of [true, false])
      expect(listed((yield* fresh(trusted, [[projectFile, MARKER]])).info)).toEqual([projectFile])
  }),
)

// U6, class 1 (stored): once a session holds a baseline, the analysis reports it and reads no source.
plain.live("instruction categories come from the stored baseline, not from the files", () =>
  Effect.gen(function* () {
    yield* folders
    yield* Effect.promise(() => fs.writeFile(projectFile, "original rules"))
    yield* scan()
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const contexts = yield* SessionContext.Service
    const selection = yield* contexts.select(sessionID)
    yield* InstructionState.prepare(db, bus, selection.instructions, sessionID)
    const stored = yield* analyze(sessionID)
    expect(stored.files.find((item) => item.path === projectFile)).toBeDefined()

    // The file changes after the baseline was stored; the discovery now holds the new text.
    const discovery = yield* InstructionDiscovery.Service
    yield* discovery.transform((editor) =>
      editor.update(projectFile, (file) => void (file.content = "c".repeat(4_000))),
    )
    const events = (yield* db.select().from(EventTable).all().pipe(Effect.orDie)).length
    const after = yield* analyze(sessionID)

    expect(after.files).toEqual(stored.files)
    expect(tokensOf(after, "instructions")).toBe(tokensOf(stored, "instructions"))
    expect(JSON.stringify(after)).not.toContain("c".repeat(100))
    expect((yield* db.select().from(EventTable).all().pipe(Effect.orDie)).length).toBe(events)
  }).pipe(Effect.scoped, Effect.provide(usageLayer(true))),
)
