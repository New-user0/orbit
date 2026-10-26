// context-memory-9: where the memory guide and index sit in a session's baseline, and which sessions carry them, on the
// real session context with the real memory sources. The index follows the instruction files, as the reference loads
// MEMORY.md after its instruction files; the guide is for the main thread, as the reference's memory section is part
// of the main system prompt only, and a system prompt that replaces Orbit's (`system_prompt`) drops it while the index
// stays; an agent that leaves the instruction files out (`context.instructions: false`) gets no index.
import { afterAll, describe, expect } from "bun:test"
import fsSync from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Agent } from "@orbit/core/agent"
import { AgentInstructions } from "@orbit/core/agent/instructions"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Project } from "@orbit/core/project"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { readInitial, readUpdate } from "./lib/instructions"
import { noScratchpad } from "./lib/scratchpad"
import { insertSession } from "./lib/session-row"
import { stubSnapshot } from "./lib/tool"

const directory = AbsolutePath.make(FSUtil.resolve("/repo"))
const GUIDE = "core/memory-guide"
const INDEX = "core/memory-index"
const TEAM_INDEX = "core/team-memory-index"
const AGENT_MEMORY = "core/agent-memory"
const ids = {
  main: SessionSchema.ID.make("ses_mem_ctx_main"),
  sub: SessionSchema.ID.make("ses_mem_ctx_sub"),
  forkOfMain: SessionSchema.ID.make("ses_mem_ctx_fork_main"),
  forkOfSub: SessionSchema.ID.make("ses_mem_ctx_fork_sub"),
  bare: SessionSchema.ID.make("ses_mem_ctx_bare"),
  own: SessionSchema.ID.make("ses_mem_ctx_own"),
  helper: SessionSchema.ID.make("ses_mem_ctx_helper"),
}

const source = (key: string) =>
  Instructions.make({
    key: Instructions.Key.make(key),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(key),
    render: { initial: (value) => `value of ${value}`, changed: (_previous, value) => `now ${value}` },
  })

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

const harness = (entries: Entry[] = [], at: AbsolutePath = directory) =>
  testEffect(
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
        FSUtil.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        Config.node.replace(Config.testLayer(entries)),
        SessionRunnerModel.node.replace(models),
        InstructionBuiltIns.node.replace(
          Layer.mock(InstructionBuiltIns.Service, {
            load: () => Effect.succeed(source("core/date")),
            preferences: () => Effect.succeed(Instructions.empty),
          }),
        ),
        AgentInstructions.node.replace(
          Layer.mock(AgentInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured()),
        SkillInstructions.node.replace(
          Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        ReferenceInstructions.node.replace(
          Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        McpInstructions.node.replace(
          Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        PluginSupervisor.node.replace(Layer.empty),
        noScratchpad,
        Tool.node.replace(
          Layer.mock(Tool.Service, {
            snapshot: () =>
              Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
          }),
        ),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: at }, { projectDirectory: at })),
          ),
        ),
      ],
    ),
  )

const it = harness()
const customPrompt = harness([
  new Document({
    type: "document",
    scope: "user",
    path: AbsolutePath.make(FSUtil.resolve("/config/orbit.json")),
    info: Schema.decodeUnknownSync(Info)({ system_prompt: "You are a custom assistant." }),
  }),
])
// The test config keeps this array as its entries, so a row that pushes a document changes the config mid-session.
const switchable: Entry[] = []
const switching = harness(switchable)
// A file of this run alone, which a row makes missing, empty and then filled.
const promptFile = path.join(os.tmpdir(), `orbit-memory-prompt-${crypto.randomUUID()}.md`)
const filePrompt = harness([
  new Document({
    type: "document",
    scope: "user",
    path: AbsolutePath.make(FSUtil.resolve("/config/orbit.json")),
    info: Schema.decodeUnknownSync(Info)({ system_prompt_file: promptFile }),
  }),
])

// The sources of a session's baseline, each with whether it holds a value.
const sources = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const context = yield* SessionContext.Service
    const instructions = (yield* context.select(id)).instructions
    const read = yield* Instructions.read(instructions)
    return {
      keys: instructions.map((item) => String(item.key)),
      present: read.flatMap((entry) => (entry.value === Instructions.removed ? [] : [String(entry.key)])),
    }
  })

const seed = Effect.gen(function* () {
  const global = yield* Global.Service
  yield* Effect.promise(async () => {
    const folder = path.join(global.data, "memory", Project.ID.global)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, "MEMORY.md"), "- [a](a.md): a memory\n")
  })
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
  yield* insertSession({ id: ids.bare, directory, agent: "bare" })
  yield* insertSession({ id: ids.own, directory, agent: "own" })
  yield* insertSession({ id: ids.helper, directory, agent: "helper" })
})

describe("memory in a session's baseline", () => {
  it.live("puts the guide and then the index right after the instruction files on the main thread", () =>
    Effect.gen(function* () {
      yield* seed
      const main = yield* sources(ids.main)
      expect(main.keys.indexOf(GUIDE)).toBe(main.keys.indexOf("core/instructions") + 1)
      expect(main.keys.indexOf(INDEX)).toBe(main.keys.indexOf(GUIDE) + 1)
      // The team index follows the private one, as the reference loads the team MEMORY.md after the private one
      // (context-memory-11); with team memory off it holds no value.
      expect(main.keys.indexOf(TEAM_INDEX)).toBe(main.keys.indexOf(INDEX) + 1)
      // The block of an agent with a memory scope comes last in the memory group (context-memory-10); this agent has
      // none, so it holds no value.
      expect(main.keys.indexOf(AGENT_MEMORY)).toBe(main.keys.indexOf(TEAM_INDEX) + 1)
      expect(main.keys.indexOf("core/date")).toBe(main.keys.indexOf(AGENT_MEMORY) + 1)
      expect(main.present).not.toContain(AGENT_MEMORY)
      expect(main.present).toContain(GUIDE)
      expect(main.present).toContain(INDEX)
      expect(main.present).not.toContain(TEAM_INDEX)
    }),
  )

  it.live("gives a subagent and a fork of one the index without the guide, and a fork of the main thread both", () =>
    Effect.gen(function* () {
      yield* seed
      for (const id of [ids.sub, ids.forkOfSub]) {
        const sub = yield* sources(id)
        expect(sub.present).not.toContain(GUIDE)
        expect(sub.present).toContain(INDEX)
      }
      const fork = yield* sources(ids.forkOfMain)
      expect(fork.present).toContain(GUIDE)
      expect(fork.present).toContain(INDEX)
    }),
  )

  it.live("leaves the index out for an agent that leaves the instruction files out", () =>
    Effect.gen(function* () {
      yield* seed
      const bare = yield* sources(ids.bare)
      expect(bare.present).not.toContain(INDEX)
      expect((yield* sources(ids.main)).present).toContain(INDEX)
    }),
  )
})

describe("memory under a system prompt of the person's", () => {
  customPrompt.live("drops the guide and keeps the index on the main thread", () =>
    Effect.gen(function* () {
      yield* seed
      const main = yield* sources(ids.main)
      expect(main.keys).toContain(GUIDE)
      expect(main.present).not.toContain(GUIDE)
      expect(main.present).toContain(INDEX)
    }),
  )

  // The person's system prompt is not applied to a subagent's definition, even when one runs as the main thread, so
  // Orbit's base and its guide stay for it.
  customPrompt.live("keeps the guide for a subagent's definition that runs as the main thread", () =>
    Effect.gen(function* () {
      yield* seed
      expect((yield* sources(ids.helper)).present).toContain(GUIDE)
      expect((yield* sources(ids.main)).present).not.toContain(GUIDE)
    }),
  )

  // A system_prompt_file that is missing or empty replaces nothing, so Orbit's base and its guide stay; once the file has
  // text, it takes the base's place and the guide goes.
  filePrompt.live(
    "keeps the guide while system_prompt_file is missing or empty, and drops it once the file has text",
    () =>
      Effect.gen(function* () {
        yield* seed
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(promptFile, { force: true })))
        const missing = yield* sources(ids.main)
        yield* Effect.promise(() => fs.writeFile(promptFile, ""))
        const empty = yield* sources(ids.main)
        yield* Effect.promise(() => fs.writeFile(promptFile, "You are a custom assistant."))
        const filled = yield* sources(ids.main)
        expect(missing.present).toContain(GUIDE)
        expect(empty.present).toContain(GUIDE)
        expect(filled.present).not.toContain(GUIDE)
        expect(filled.present).toContain(INDEX)
      }),
  )
})

// The guide goes for two reasons, and the update a session gets says which. A main thread that moves to an agent with
// a prompt of its own still has memory: the index stays, and the model must not be told that memory is off. When
// memory.enabled turns false, the same kind of update says that it is off; that row is the control.
describe("memory when a main thread's guide goes in the middle of a session", () => {
  const select = (id: SessionSchema.ID) =>
    SessionContext.Service.pipe(
      Effect.flatMap((context) => context.select(id)),
      Effect.map((selected) => selected.instructions),
    )

  it.live("does not say memory is off after a switch to an agent with its own prompt", () =>
    Effect.gen(function* () {
      yield* seed
      const before = yield* readInitial(yield* select(ids.main))
      expect(Object.keys(before.values)).toContain(GUIDE)
      const database = yield* Database.Service
      yield* database.db
        .update(SessionTable)
        .set({ agent: "own" })
        .where(eq(SessionTable.id, ids.main))
        .run()
        .pipe(Effect.orDie)
      const after = yield* readUpdate(yield* select(ids.main), before)
      expect(Object.keys(after.values)).not.toContain(GUIDE)
      expect(Object.keys(after.values)).toContain(INDEX)
      expect(after.text).toContain("not part of the current prompt")
      expect(after.text).not.toContain("Memory is switched off for this session")
      expect(after.text).not.toContain("do not read or write")
    }),
  )

  switching.live("says memory is off once memory.enabled turns false", () =>
    Effect.gen(function* () {
      yield* seed
      const before = yield* readInitial(yield* select(ids.main))
      expect(Object.keys(before.values)).toContain(GUIDE)
      switchable.push(
        new Document({
          type: "document",
          scope: "user",
          path: AbsolutePath.make(FSUtil.resolve("/config/orbit.json")),
          info: Schema.decodeUnknownSync(Info)({ memory: { enabled: false } }),
        }),
      )
      const after = yield* readUpdate(yield* select(ids.main), before)
      expect(Object.keys(after.values)).not.toContain(GUIDE)
      expect(after.text).toContain("Memory is switched off for this session")
    }),
  )
})

// An agent's own prompt takes the place of Orbit's base, as a system prompt of the person's does, so its main thread
// gets the index and no guide; an agent without one, in the same run, gets both.
describe("memory for an agent with a prompt of its own", () => {
  it.live("gives its main thread the index without the guide", () =>
    Effect.gen(function* () {
      yield* seed
      const own = yield* sources(ids.own)
      const plain = yield* sources(ids.main)
      expect(own.present).not.toContain(GUIDE)
      expect(own.present).toContain(INDEX)
      expect(plain.present).toContain(GUIDE)
      expect(plain.present).toContain(INDEX)
    }),
  )
})

// context-memory-10, class 12: the block of an agent with a memory scope goes with the agent, wherever it runs: as the
// main thread, as a subagent and in a fork, under the agent's own prompt, under the person's system prompt and without
// the instruction files, as the reference appends it to the agent's own prompt. It follows the private memory sources.
// The session folder is a real one of this run, since the project scope makes its folder there.
const agentRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "orbit-agent-memory-"))
const agentDirectory = AbsolutePath.make(fsSync.realpathSync(agentRoot))
afterAll(() => fsSync.rmSync(agentRoot, { recursive: true, force: true }))
// The test config keeps this array as its entries, so the row that turns memory off pushes a document into it.
const agentEntries: Entry[] = []
const withAgent = harness(agentEntries, agentDirectory)
const withAgentPrompt = harness(
  [
    new Document({
      type: "document",
      scope: "user",
      path: AbsolutePath.make(FSUtil.resolve("/config/orbit.json")),
      info: Schema.decodeUnknownSync(Info)({ system_prompt: "You are a custom assistant." }),
    }),
  ],
  agentDirectory,
)

const agentIds = {
  main: SessionSchema.ID.make("ses_agent_mem_main"),
  sub: SessionSchema.ID.make("ses_agent_mem_sub"),
  fork: SessionSchema.ID.make("ses_agent_mem_fork"),
  plain: SessionSchema.ID.make("ses_agent_mem_plain"),
  own: SessionSchema.ID.make("ses_agent_mem_own"),
  bare: SessionSchema.ID.make("ses_agent_mem_bare"),
}

const seedAgents = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("keeper"), (agent) => {
      agent.mode = "all"
      agent.memory = "project"
    })
    editor.update(Agent.ID.make("keeper-own"), (agent) => {
      agent.mode = "all"
      agent.memory = "user"
      agent.system = "You are an agent with a prompt of its own."
    })
    editor.update(Agent.ID.make("keeper-bare"), (agent) => {
      agent.mode = "all"
      agent.memory = "local"
      agent.context = { instructions: false }
    })
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
  })
  const options = { directory: agentDirectory }
  yield* insertSession({ id: agentIds.main, agent: "keeper", ...options })
  yield* insertSession({ id: agentIds.sub, parentID: agentIds.main, agent: "keeper", ...options })
  yield* insertSession({ id: agentIds.fork, fork: agentIds.main, agent: "keeper", ...options })
  yield* insertSession({ id: agentIds.plain, agent: "build", ...options })
  yield* insertSession({ id: agentIds.own, agent: "keeper-own", ...options })
  yield* insertSession({ id: agentIds.bare, agent: "keeper-bare", ...options })
})

describe("the memory of an agent with a memory scope", () => {
  withAgent.live("gives an agent with memory its block on the main thread, as a subagent and in a fork", () =>
    Effect.gen(function* () {
      yield* seedAgents
      for (const id of [agentIds.main, agentIds.sub, agentIds.fork]) {
        const view = yield* sources(id)
        expect({ id, present: view.present.includes(AGENT_MEMORY) }).toEqual({ id, present: true })
        expect(view.keys.indexOf(AGENT_MEMORY)).toBe(view.keys.indexOf(TEAM_INDEX) + 1)
      }
      const plain = yield* sources(agentIds.plain)
      expect(plain.keys).toContain(AGENT_MEMORY)
      expect(plain.present).not.toContain(AGENT_MEMORY)
      expect(fsSync.existsSync(path.join(agentDirectory, ".orbit", "agent-memory", "keeper"))).toBe(true)
    }),
  )

  withAgentPrompt.live(
    "keeps the agent block under the agent's own prompt, the person's system prompt and without instruction files",
    () =>
      Effect.gen(function* () {
        yield* seedAgents
        const own = yield* sources(agentIds.own)
        const bare = yield* sources(agentIds.bare)
        const main = yield* sources(agentIds.main)
        expect(own.present).toContain(AGENT_MEMORY)
        expect(own.present).not.toContain(GUIDE)
        expect(bare.present).toContain(AGENT_MEMORY)
        expect(bare.present).not.toContain(INDEX)
        expect(main.present).toContain(AGENT_MEMORY)
        expect(main.present).not.toContain(GUIDE)
      }),
  )

  // A switch to an agent without a scope takes the block away and says only that it no longer applies; memory is still
  // on. Turning memory off takes it away with the words that memory is off. The agent with its own prompt has no guide,
  // so what the update says there is the block's own.
  withAgent.live(
    "removes the agent block on a switch to an agent without memory, and says memory is off only when it is",
    () =>
      Effect.gen(function* () {
        yield* seedAgents
        const select = (id: SessionSchema.ID) =>
          SessionContext.Service.pipe(
            Effect.flatMap((context) => context.select(id)),
            Effect.map((selected) => selected.instructions),
          )
        const before = yield* readInitial(yield* select(agentIds.main))
        expect(Object.keys(before.values)).toContain(AGENT_MEMORY)
        const database = yield* Database.Service
        yield* database.db
          .update(SessionTable)
          .set({ agent: "build" })
          .where(eq(SessionTable.id, agentIds.main))
          .run()
          .pipe(Effect.orDie)
        const switched = yield* readUpdate(yield* select(agentIds.main), before)
        expect(Object.keys(switched.values)).not.toContain(AGENT_MEMORY)
        expect(switched.text).toContain("agent memory given earlier no longer applies")
        expect(switched.text).not.toContain("switched off")
        const own = yield* readInitial(yield* select(agentIds.own))
        expect(Object.keys(own.values)).toContain(AGENT_MEMORY)
        agentEntries.push(
          new Document({
            type: "document",
            scope: "user",
            path: AbsolutePath.make(FSUtil.resolve("/config/orbit.json")),
            info: Schema.decodeUnknownSync(Info)({ memory: { enabled: false } }),
          }),
        )
        const off = yield* readUpdate(yield* select(agentIds.own), own)
        expect(Object.keys(off.values)).not.toContain(AGENT_MEMORY)
        expect(off.text).toContain("switched off")
        expect(off.text).not.toContain("agent memory given earlier no longer applies")
      }),
  )
})
