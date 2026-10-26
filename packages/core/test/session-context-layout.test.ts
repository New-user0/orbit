// prompts-context-17: the tool-results section of the baseline and the layout of the baseline around it. The section
// is the default prompt's, as the reference's two tool-result texts are dynamic sections of its default prompt: it goes
// wherever the default prompt goes (a main thread and an exact fork of one), and not to a subagent, to an agent whose
// own prompt takes the default prompt's place, to a system prompt of the person's, or to a minimal instance. It stands
// after the scratchpad and before the entries of the API (class 12), reads the setting the runner clears by (class 3),
// and the request's system part and tool list stay as they were across every event that changes only the history.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { TestLLM } from "@orbit/ai/testing"
import { Agent } from "@orbit/core/agent"
import { AgentInstructions } from "@orbit/core/agent/instructions"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigCompactionPlugin } from "@orbit/core/config/plugin/compaction"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { EventTable } from "@orbit/core/event/sql"
import { Project } from "@orbit/core/project"
import { Session } from "@orbit/core/session"
import { CLEARED_RESULT } from "@orbit/core/session/runner/to-llm-message"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionCompaction } from "@orbit/core/session/compaction"
import { SessionContext } from "@orbit/core/session/context"
import { SessionHistory } from "@orbit/core/session/history"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { SessionMicrocompaction } from "@orbit/core/session/microcompaction"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionReminders } from "@orbit/core/session/reminders"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { VcsInstructions } from "@orbit/core/vcs/instructions"
import { Document, Event, Info, type Entry } from "@orbit/schema/config"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { and, eq } from "drizzle-orm"
import { Effect, Layer, Option, Ref, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { testEffect } from "./lib/effect"
import { readInitial, readUpdate } from "./lib/instructions"
import { insertSession } from "./lib/session-row"
import { scenario, sessionID, transformTools, type Scenario } from "./lib/runner"
import { seedStep } from "./lib/context-history"
import { stubSnapshot } from "./lib/tool"
import { host } from "./plugin/host"

const directory = AbsolutePath.make(FSUtil.resolve("/repo"))
const KEY = "core/tool-results"
const GUIDE = "core/memory-guide"
const HEADING = "# Clearing of old tool output"
const ADVICE = "note it in your reply"
// The built-in sources in the order the baseline lists them, the tool-results section last among them.
const BUILT_INS = [
  "core/codemode",
  "core/mcp-guidance",
  "core/reference-guidance",
  "core/skill-guidance",
  "core/agent-guidance",
  "core/language",
  "core/instructions",
  "core/memory-guide",
  "core/memory-index",
  "core/team-memory-index",
  "core/date",
  "core/environment",
  "core/vcs-snapshot",
  "core/scratchpad",
  KEY,
]
const ids = {
  main: SessionSchema.ID.make("ses_layout_main"),
  sub: SessionSchema.ID.make("ses_layout_sub"),
  forkOfMain: SessionSchema.ID.make("ses_layout_fork_main"),
  forkOfSub: SessionSchema.ID.make("ses_layout_fork_sub"),
  own: SessionSchema.ID.make("ses_layout_own"),
  helper: SessionSchema.ID.make("ses_layout_helper"),
  bare: SessionSchema.ID.make("ses_layout_bare"),
}

const source = (key: string) =>
  Instructions.make({
    key: Instructions.Key.make(key),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(key),
    render: { initial: (value) => `value of ${value}`, changed: (_previous, value) => `now ${value}` },
  })
const stub = (key: string) => Effect.succeed(source(key))

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(LanguageModel.make({ id: "primary", provider: "test", route: OpenAIChat.route }), {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})

const options = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const document = (raw: unknown) => {
  const normalized = ConfigNormalize.normalize(raw)
  if (normalized.type !== "normalized") throw new Error("expected a normalized config")
  return new Document({ type: "document", info: Schema.decodeUnknownSync(Info, options)(normalized.encoded) })
}

// The real session context over the real built-in sources (language, date, environment, the memory guide and indexes,
// the tool-results section) and the real compaction setting. The listings that other tasks own are given one entry
// each under their production keys. The config keeps `entries` as its array, so a row that rewrites it changes the
// config mid-session.
const entries: Entry[] = []
const recorded = recordedFileSystem()
const config = Config.testLayer(entries)
const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Project.node,
        SessionProjector.node,
        SessionStore.node,
        Agent.node,
        InstructionEntry.node,
        SessionCompaction.node,
        SessionContext.node,
        Location.node,
        Global.node,
        FSUtil.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        Config.node.replace(config),
        FSUtil.node.replace(recorded.layer),
        SessionRunnerModel.node.replace(models),
        AgentInstructions.node.replace(
          Layer.mock(AgentInstructions.Service, { load: () => stub("core/agent-guidance") }),
        ),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured()),
        SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => stub("core/skill-guidance") })),
        ReferenceInstructions.node.replace(
          Layer.mock(ReferenceInstructions.Service, { load: () => stub("core/reference-guidance") }),
        ),
        McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => stub("core/mcp-guidance") })),
        VcsInstructions.node.replace(
          Layer.succeed(VcsInstructions.Service, { source: () => source("core/vcs-snapshot") }),
        ),
        SessionScratchpad.node.replace(
          Layer.mock(SessionScratchpad.Service, {
            path: () => undefined,
            source: () => source("core/scratchpad"),
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
          Layer.succeed(Location.Service, Location.Service.of(location({ directory }, { projectDirectory: directory }))),
        ),
      ],
    ),
  ),
)

const seed = Effect.gen(function* () {
  entries.length = 0
  recorded.calls.length = 0
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    editor.update(Agent.ID.make("bare"), (agent) => {
      agent.mode = "primary"
      agent.context = { instructions: false }
    })
    editor.update(Agent.ID.make("own"), (agent) => {
      agent.mode = "primary"
      agent.system = "You are an agent with a prompt of its own."
    })
    editor.update(Agent.ID.make("helper"), (agent) => {
      agent.mode = "subagent"
    })
  })
  const options = { directory, agent: "build" }
  yield* insertSession({ id: ids.main, ...options })
  yield* insertSession({ id: ids.sub, parentID: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfMain, fork: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfSub, parentID: ids.main, fork: ids.sub, ...options })
  yield* insertSession({ id: ids.own, directory, agent: "own" })
  yield* insertSession({ id: ids.helper, directory, agent: "helper" })
  yield* insertSession({ id: ids.bare, directory, agent: "bare" })
})

const select = (id: SessionSchema.ID) =>
  SessionContext.Service.pipe(
    Effect.flatMap((context) => context.select(id)),
    Effect.map((selected) => selected.instructions),
  )
// The keys of a session's list, and which of them hold a value.
const sources = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const list = yield* select(id)
    const read = yield* Instructions.read(list)
    return {
      keys: list.map((item) => String(item.key)),
      present: read.flatMap((entry) => (entry.value === Instructions.removed ? [] : [String(entry.key)])),
      values: Object.fromEntries(read.map((entry) => [String(entry.key), entry.value])),
    }
  })

describe("the layout of the baseline", () => {
  // Q1 and Q4: the reference lists the tool-result texts after the scratchpad, and the entries of the API follow every
  // built-in source. The order among the entries of the API is the plugins' own and is not pinned.
  it.live("orders the built-in sources as the reference does, with tool-results after the scratchpad and every api entry last", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* InstructionEntry.Service
      yield* store.put({ sessionID: ids.main, key: InstructionEntry.Key.make("notes"), value: "from the API" })
      yield* store.put({ sessionID: ids.main, key: InstructionEntry.Key.make("other"), value: "from the API" })
      const keys = (yield* sources(ids.main)).keys
      const builtIns = keys.filter((key) => !key.startsWith("api/"))
      // Every source is listed, so the order below is not that of a thin list.
      expect(builtIns).toEqual(BUILT_INS)
      const apiKeys = keys.filter((key) => key.startsWith("api/"))
      expect(apiKeys).toHaveLength(2)
      for (const key of apiKeys) expect(keys.indexOf(key)).toBeGreaterThan(keys.indexOf(KEY))
    }),
  )

  it.live("shows the same section in the instruction preview", () =>
    Effect.gen(function* () {
      yield* seed
      const store = yield* InstructionEntry.Service
      yield* store.put({ sessionID: ids.main, key: InstructionEntry.Key.make("notes"), value: "from the API" })
      const list = yield* select(ids.main)
      const database = yield* Database.Service
      // The preview endpoint builds its baseline from this same selection.
      const preview = yield* SessionHistory.preview(database.db, ids.main, list, "local")
      const at = (text: string) => preview.initial.indexOf(text)
      expect(at(HEADING)).toBeGreaterThan(at("value of core/scratchpad"))
      expect(at(HEADING)).toBeLessThan(at("from the API"))
      expect(at(ADVICE)).toBeGreaterThan(at(HEADING))
      // The preview and the runner's baseline read the same list, so their text is the same.
      expect(preview.initial).toEqual((yield* readInitial(list)).text)
    }),
  )
})

describe("the tool-results section follows the default prompt", () => {
  const file = path.join(os.tmpdir(), `orbit-layout-prompt-${crypto.randomUUID()}.md`)
  const readsOfFile = () => recorded.calls.filter((call) => call === `readFileStringSafe ${path.resolve(file)}`).length

  // Every row holds that the memory guide and the section agree: one default-prompt value feeds both.
  const rows = (id: SessionSchema.ID) =>
    sources(id).pipe(
      Effect.map((found) => {
        expect(found.present.includes(KEY)).toBe(found.present.includes(GUIDE))
        return found.present.includes(KEY)
      }),
    )

  it.live("carries the section wherever the default prompt goes", () =>
    Effect.gen(function* () {
      yield* seed
      const prompt = (info: unknown) => {
        entries.length = 0
        entries.push(document(info))
      }
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(file, { force: true })))

      // No replacement: the main thread and an exact fork of it carry the section, a subagent and a fork of one do not.
      expect(yield* rows(ids.main)).toBe(true)
      expect(yield* rows(ids.forkOfMain)).toBe(true)
      expect(yield* rows(ids.sub)).toBe(false)
      expect(yield* rows(ids.forkOfSub)).toBe(false)
      // An agent whose own prompt takes the default prompt's place drops it; one that leaves the instruction files out keeps it.
      expect(yield* rows(ids.own)).toBe(false)
      expect(yield* rows(ids.bare)).toBe(true)

      // A system prompt of the person's takes the default prompt's place on the main thread, but not on a subagent's
      // definition that runs as the main thread.
      prompt({ system_prompt: "You are a custom assistant." })
      expect(yield* rows(ids.main)).toBe(false)
      expect(yield* rows(ids.helper)).toBe(true)

      // A file that is missing or empty replaces nothing; once it has text it does. One read per selection.
      prompt({ system_prompt_file: file })
      recorded.calls.length = 0
      expect(yield* rows(ids.main)).toBe(true)
      expect(readsOfFile()).toBe(1)
      yield* Effect.promise(() => fs.writeFile(file, ""))
      recorded.calls.length = 0
      expect(yield* rows(ids.main)).toBe(true)
      expect(readsOfFile()).toBe(1)
      yield* Effect.promise(() => fs.writeFile(file, "You are a custom assistant."))
      recorded.calls.length = 0
      expect(yield* rows(ids.main)).toBe(false)
      expect(readsOfFile()).toBe(1)

      // A network share is refused before any file system call: the default prompt stays, nothing is read.
      for (const share of ["\\\\host\\share\\p.md", "//host/share/p.md"]) {
        prompt({ system_prompt_file: share })
        recorded.calls.length = 0
        expect(yield* rows(ids.main)).toBe(true)
        expect(recorded.calls.filter((call) => call.startsWith("readFileStringSafe"))).toEqual([])
      }
    }),
  )
})

describe("the tool-results section's text", () => {
  const on = InstructionBuiltIns.toolResultsSource(Effect.succeed(true))
  const off = InstructionBuiltIns.toolResultsSource(Effect.succeed(false))

  test("shows the clearing notice with the keep count only while compaction.clear is on", async () => {
    const shown = await Effect.runPromise(readInitial(on))
    expect(shown.values).toEqual({ [KEY]: 5 })
    expect(SessionMicrocompaction.KEEP).toBe(5)
    // The heading, then the notice with the count, then the advice.
    expect(shown.text.startsWith(HEADING)).toBe(true)
    expect(shown.text.indexOf("5 latest")).toBeGreaterThan(shown.text.indexOf(HEADING))
    expect(shown.text.indexOf(ADVICE)).toBeGreaterThan(shown.text.indexOf("5 latest"))

    // Clearing off: the advice alone.
    const hidden = await Effect.runPromise(readInitial(off))
    expect(hidden.values).toEqual({ [KEY]: null })
    expect(hidden.text).toContain(ADVICE)
    expect(hidden.text).not.toContain("Clearing")
    expect(hidden.text).not.toContain("latest")

    // The number is the stored value: a baseline stored with 3 names 3.
    const stored = Instructions.renderInitial(on, { [KEY]: 3 })
    expect(stored).toContain("3 latest")
    expect(stored).not.toContain("5 latest")
  })

  test("renders nothing for a stored value it cannot read, and the next value as new", () => {
    // A string, a negative number, a fraction and an object do not decode; none renders, and none throws.
    for (const stored of ["five", -1, 2.5, {}, [5], true])
      expect(Instructions.renderInitial(on, { [KEY]: stored })).toBe("")
    // The value that follows renders as a section that appeared, which is the initial text, not an "is now on" change.
    const next = Instructions.renderUpdate(on, { [KEY]: "five" }, { [KEY]: Option.some(5) })
    expect(next).toBe(Instructions.renderInitial(on, { [KEY]: 5 }))
    expect(next).toContain(HEADING)
    // Control: a stored 3 followed by 5 is a change.
    expect(Instructions.renderUpdate(on, { [KEY]: 3 }, { [KEY]: Option.some(5) })).toContain("is now on")
    // The change names the stored count, never a literal.
    expect(Instructions.renderUpdate(on, { [KEY]: null }, { [KEY]: Option.some(7) })).toContain("7 latest")
  })

  // Differ 3: a change of the setting is one chronological update, and the baseline's bytes stay.
  test("renders a change of compaction.clear as an update and keeps the baseline", async () => {
    const setting = Ref.makeUnsafe(true)
    const list = InstructionBuiltIns.toolResultsSource(Ref.get(setting))
    const initial = await Effect.runPromise(readInitial(list))
    await Effect.runPromise(Ref.set(setting, false))
    const turnedOff = await Effect.runPromise(readUpdate(list, initial))
    expect(turnedOff.values).toEqual({ [KEY]: null })
    expect(turnedOff.text).toContain("is now off")
    expect(turnedOff.text).toContain("stays cleared")
    await Effect.runPromise(Ref.set(setting, true))
    const turnedOn = await Effect.runPromise(readUpdate(list, turnedOff))
    expect(turnedOn.text).toContain("is now on")
    expect(turnedOn.text).toContain("5 latest")
    // The baseline renders from the stored values, so neither change touches its bytes.
    expect(Instructions.renderInitial(list, initial.values)).toBe(initial.text)
    // A setting that did not change adds nothing.
    expect((await Effect.runPromise(readUpdate(list, turnedOn))).changed).toBe(false)
  })
})

describe("the tool-results section and the compaction setting", () => {
  const applied = (expected: boolean) =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((yield* compaction.clearing) === expected) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
    })
  const set = (documents: Entry[], expected: boolean) =>
    Effect.gen(function* () {
      const test = yield* Config.Test
      const bus = yield* Bus.Service
      yield* test.setEntries(documents)
      yield* bus.publish(Event.Updated, {})
      yield* applied(expected)
    })
  const value = (id: SessionSchema.ID) => sources(id).pipe(Effect.map((found) => found.values[KEY]))

  // Class 3 and 7: the notice reads the setting the runner clears by, which folds each field over every document, and a
  // malformed field costs only itself.
  it.live("follows the compaction setting the runner clears by", () =>
    Effect.gen(function* () {
      yield* seed
      const bus = yield* Bus.Service
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))
      expect(yield* value(ids.main)).toBe(5)

      // Row 1: the lower document turns clearing off and the higher one sets only `auto`; the last document that sets
      // `clear` wins, not the last document that sets `compaction`.
      yield* set([document({ compaction: { clear: false } }), document({ compaction: { auto: true } })], false)
      expect(yield* value(ids.main)).toBeNull()
      // Control: the lower document alone says the same.
      yield* set([document({ compaction: { clear: false } })], false)
      expect(yield* value(ids.main)).toBeNull()

      // Row 2: a malformed `clear` is dropped with a diagnostic, so clearing stays on, and the buffer beside it applies.
      yield* set([document({ compaction: { clear: "no", buffer: 2_000 } })], true)
      expect(yield* value(ids.main)).toBe(5)
    }),
  )

  it.live("renders nothing after a move to an agent with a prompt of its own, and nothing again on the way back", () =>
    Effect.gen(function* () {
      yield* seed
      const bus = yield* Bus.Service
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))
      const before = yield* readInitial(yield* select(ids.main))
      expect(Object.keys(before.values)).toContain(KEY)
      expect(before.text).toContain(HEADING)

      // The gate goes false: the source leaves the list, so nothing renders, and the stored value is kept.
      const database = yield* Database.Service
      const agent = (name: string) =>
        database.db
          .update(SessionTable)
          .set({ agent: name })
          .where(eq(SessionTable.id, ids.main))
          .run()
          .pipe(Effect.orDie)
      yield* agent("own")
      const away = yield* readUpdate(yield* select(ids.main), before)
      expect(away.text).not.toContain(ADVICE)
      expect(away.text).not.toContain("Clearing")
      expect(away.values[KEY]).toBe(5)

      // Back on the default prompt: the stored value still stands, so the section adds nothing.
      yield* agent("build")
      const back = yield* readUpdate(yield* select(ids.main), away)
      expect(back.text).not.toContain(ADVICE)
      expect(back.text).not.toContain("Clearing")

      // A change of the setting meanwhile is the one thing that renders.
      yield* set([document({ compaction: { clear: false } })], false)
      const toggled = yield* readUpdate(yield* select(ids.main), back)
      expect(toggled.text).toContain("is now off")
    }),
  )
})

// The runner rows: the section reaches the model's request, and the request's system part and tool list stay as they
// were across every event that changes only the history.
const MINUTE = 60_000
const CLEARED = "session.context.cleared.1"
const body = (id: string) => `${id}:`.padEnd(400, "x")
const reads = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => {
    const id = `${prefix}${index + 1}`
    return { id, name: "Read", text: body(id) }
  })
const systemText = (request: { readonly system: ReadonlyArray<{ readonly text: string }> } | undefined) =>
  (request?.system ?? []).map((part) => part.text).join("\n")
const everything = (request: object | undefined) => JSON.stringify(request ?? {})

const newSession = (s: Scenario, name: string, input: { parentID?: Session.ID; agent?: string } = {}) =>
  Effect.gen(function* () {
    const id = Session.ID.make(`ses_layout_${name}`)
    yield* s.db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.parentID === undefined ? {} : { parent_id: input.parentID }),
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })

// A prompt on `id` that the model answers, and the request it made.
const ask = (s: Scenario, id: Session.ID, text = "Next") =>
  Effect.gen(function* () {
    yield* s.llm.push(TestLLM.text("Done", `reply-${s.requests.length}`))
    const before = s.requests.length
    yield* s.session.prompt({ sessionID: id, text, resume: false })
    yield* s.session.resume(id)
    const request = s.requests.slice(before).at(-1)
    if (request === undefined) return yield* Effect.die(new Error("Expected a request"))
    return request
  })

const clearings = (s: Scenario, id: Session.ID) =>
  s.db
    .select({ id: EventTable.id })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, id), eq(EventTable.type, CLEARED)))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )

// Eight reads, an hour of quiet and a prompt: the prompt's request clears the three oldest.
const idleRequest = (s: Scenario, id: Session.ID, name: string) =>
  Effect.gen(function* () {
    yield* seedStep(s.bus, id, { id: `msg_${name}`, calls: reads(name, 8) })
    yield* TestClock.adjust(61 * MINUTE)
    return yield* ask(s, id)
  })

const ownPrompt = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("own"), (agent) => {
      agent.mode = "primary"
      agent.system = "You are an agent with a prompt of its own."
    }),
  )
})

describe("the tool-results section in the runner's request", () => {
  // Class 3: the notice shows exactly when the session clears, because both read the setting. The one row where they
  // differ is the reference's: an agent with a prompt of its own still clears and shows no text.
  scenario("shows the clearing notice exactly when the session clears", function* (s) {
    yield* ownPrompt
    const compaction = yield* SessionCompaction.Service

    const main = yield* newSession(s, "main")
    const request = yield* idleRequest(s, main, "m")
    expect(systemText(request)).toContain(HEADING)
    expect(systemText(request)).toContain("5 latest")
    expect(systemText(request)).toContain(ADVICE)
    expect(everything(request)).toContain(CLEARED_RESULT)
    expect(yield* clearings(s, main)).toBe(1)

    // A fork of the main thread carries the notice, and its history sends the placeholders.
    const fork = yield* s.session.fork({ sessionID: main })
    const forked = yield* ask(s, fork.id)
    expect(systemText(forked)).toContain(HEADING)
    expect(everything(forked)).toContain(CLEARED_RESULT)

    // A subagent neither carries the section nor clears.
    const sub = yield* newSession(s, "sub", { parentID: main })
    const child = yield* idleRequest(s, sub, "s")
    expect(systemText(child)).not.toContain(HEADING)
    expect(systemText(child)).not.toContain(ADVICE)
    expect(everything(child)).not.toContain(CLEARED_RESULT)
    expect(yield* clearings(s, sub)).toBe(0)

    // An agent with a prompt of its own shows no text and clears all the same, as the reference does.
    const own = yield* newSession(s, "own", { agent: "own" })
    const owned = yield* idleRequest(s, own, "o")
    expect(systemText(owned)).not.toContain(HEADING)
    expect(systemText(owned)).not.toContain(ADVICE)
    expect(everything(owned)).toContain(CLEARED_RESULT)
    expect(yield* clearings(s, own)).toBe(1)

    // Clearing off: the advice alone, and nothing is cleared.
    yield* compaction.transform((editor) => editor.configure({ clear: false }))
    const off = yield* newSession(s, "off")
    const quiet = yield* idleRequest(s, off, "f")
    expect(systemText(quiet)).toContain(ADVICE)
    expect(systemText(quiet)).not.toContain(HEADING)
    expect(everything(quiet)).not.toContain(CLEARED_RESULT)
    expect(yield* clearings(s, off)).toBe(0)
  })

  scenario("keeps an exact fork's first request byte for byte, the section included", function* (s) {
    const first = yield* ask(s, sessionID, "First")
    expect(systemText(first)).toContain(HEADING)
    const exact = yield* s.session.fork({ sessionID, prompt: "exact" })
    const second = yield* ask(s, exact.id, "Forked")
    expect(second.system).toEqual(first.system)
    expect(second.tools).toEqual(first.tools)
    expect(systemText(second)).toContain(HEADING)
    expect(systemText(second)).toContain(ADVICE)
  })

  // The request's system part and tool list hold across every event that touches only the history. A tool added after
  // the first step that is deferred into the Code Mode catalog leaves both alone, and its definition arrives as a
  // chronological update; a direct tool changes the tool list, which is the accepted miss, and the system part holds.
  scenario(
    "keeps the system prompt and the tool list byte-identical across a mode switch, a grant, a reminder, a tool load, a clearing and a setting change",
    function* (s) {
      const agents = yield* Agent.Service
      const registry = yield* Tool.Service
      const compaction = yield* SessionCompaction.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("plan"), (agent) => {
          agent.mode = "primary"
          // Plan's edit deny is a mode rule followed by a folder allow, so the tool list does not change.
          agent.permissions.push({ action: "edit", resource: "*", effect: "deny" })
          agent.permissions.push({ action: "edit", resource: "/project/**", effect: "allow" })
        }),
      )
      const tool = (name: string) => ({
        [name]: {
          name,
          description: `Offered after the first step: ${name}`,
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          traits: { concurrencySafe: true },
          execute: () => Effect.succeed({ output: {} }),
        },
      })

      // The request made while Plan mode is active, kept so the row can compare it with the one before the switch.
      const inPlan: Array<Effect.Success<ReturnType<typeof ask>>> = []
      const rows: ReadonlyArray<{
        readonly name: string
        readonly event: (id: Session.ID) => Effect.Effect<unknown, unknown, Scope.Scope>
        readonly added?: { readonly deferred: boolean; readonly tool: string }
        readonly update?: string
      }> = [
        {
          name: "a switch to Plan mode and back",
          event: (id) =>
            Effect.gen(function* () {
              yield* s.session.switchAgent({ sessionID: id, agent: Agent.ID.make("plan") })
              inPlan.push(yield* ask(s, id, "In plan"))
              yield* s.session.switchAgent({ sessionID: id, agent: Agent.ID.make("build") })
            }),
        },
        {
          // The harness replaces the permission service, so the grant is written to the session's own rules, which the
          // tool snapshot merges with the agent's.
          name: "a grant",
          event: (id) =>
            s.session.setPermissions({
              sessionID: id,
              permissions: [{ action: "echo", resource: "*", effect: "allow" }],
            }),
        },
        {
          name: "a durable reminder on the second step",
          event: () =>
            Effect.sync(() => {
              s.reminders.durable = [
                {
                  name: "marker",
                  run: () => Effect.succeed([{ kind: "marker", text: "MARK", data: { label: "file", content: "payload" } }]),
                },
              ]
            }),
        },
        {
          name: "a deferred tool loaded after the first step",
          event: () => transformTools(registry, tool("late_deferred")),
          added: { deferred: true, tool: "late_deferred" },
        },
        {
          name: "a direct tool loaded after the first step",
          event: () => transformTools(registry, tool("late_direct"), { codemode: false }),
          added: { deferred: false, tool: "late_direct" },
        },
        {
          name: "an idle clearing",
          event: (id) =>
            Effect.gen(function* () {
              yield* seedStep(s.bus, id, { id: `msg_${id}`, calls: reads("c", 8) })
              yield* TestClock.adjust(61 * MINUTE)
            }),
        },
        {
          name: "a change of compaction.clear",
          event: () => compaction.transform((editor) => editor.configure({ clear: false })),
          update: "Clearing of old tool output is now off",
        },
      ]

      for (const row of rows) {
        // A reminder left by the row before would otherwise fire in this row's first request.
        s.reminders.durable = []
        inPlan.length = 0
        const id = yield* newSession(s, row.name.replaceAll(/\W+/g, "_"))
        const before = yield* ask(s, id, "One")
        expect(systemText(before)).toContain(ADVICE)
        yield* row.event(id)
        const after = yield* ask(s, id, "Two")
        // The system part is identical in every row, the direct tool's included.
        expect(after.system).toEqual(before.system)
        const names = (request: typeof before) => request.tools.map((definition) => definition.name)
        if (row.name.startsWith("a switch")) {
          expect(inPlan).toHaveLength(1)
          expect(inPlan[0].system).toEqual(before.system)
          expect(inPlan[0].tools).toEqual(before.tools)
        }
        if (row.added?.deferred === false) {
          expect(names(after).filter((name) => !names(before).includes(name))).toEqual([row.added.tool])
          // Only the new definition differs.
          expect(after.tools.filter((definition) => definition.name !== row.added?.tool)).toEqual([...before.tools])
        } else expect(after.tools).toEqual(before.tools)
        if (row.update !== undefined) expect(everything(after)).toContain(row.update)
        if (row.added?.deferred === true) expect(everything(after)).toContain(row.added.tool)
      }
    },
  )
})

