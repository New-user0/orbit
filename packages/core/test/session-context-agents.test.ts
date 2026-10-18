// What an agent's `context` switches leave out of its baseline: the instruction files and the git snapshot, on the real
// session context, the real trust and the real Git service, over a temporary repository that the Location is bound to.
// The repository has `core.fsmonitor` planted, which git runs for `status` and which writes a marker line, so that a
// test sees whether git did any work in the folder.
import { describe, expect } from "bun:test"
import path from "path"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Document, Info } from "@orbit/schema/config"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { ConfigAgentPlugin } from "@orbit/core/config/plugin/agent"
import { ConfigTrust } from "@orbit/core/config/trust"
import { agentHost, host } from "./plugin/host"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { InstructionState } from "@orbit/core/session/instruction-state"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { VcsInstructions } from "@orbit/core/vcs/instructions"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { keys, live, planted } from "./fixture/git-keys"
import { traced } from "./fixture/git-trace"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { noScratchpad } from "./lib/scratchpad"
import { insertSession } from "./lib/session-row"
import { stubSnapshot } from "./lib/tool"

const fsmonitor = keys.find((key) => key.name === "core.fsmonitor")!
const key = VcsInstructions.key
const filesKey = "core/instructions"
const ids = {
  main: SessionSchema.ID.make("ses_vcs_main"),
  child: SessionSchema.ID.make("ses_vcs_child"),
  plain: SessionSchema.ID.make("ses_vcs_plain"),
  other: SessionSchema.ID.make("ses_vcs_other"),
}

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
const empty = Instructions.empty

const state = {
  found: undefined as
    | { readonly root: string; readonly folder: string; readonly ran: () => Effect.Effect<readonly string[]> }
    | undefined,
}

// A repository with the key planted, as the folder of the Location. `vcs` says what the project resolved it as.
const harness = (vcs: (root: string) => Project.Vcs | undefined) =>
  testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Project.node,
        SessionProjector.node,
        SessionStore.node,
        Agent.node,
        InstructionEntry.node,
        SessionContext.node,
        VcsInstructions.node,
        InstructionDiscovery.node,
        ProjectTrust.node,
        Location.node,
        Global.node,
        FSUtil.node,
        ManagedPolicy.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        // No implicit trust: the folder is untrusted until a test grants it, which is what the core tests would otherwise skip.
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
        Config.node.replace(Config.testLayer()),
        SessionRunnerModel.node.replace(models),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured()),
        SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(empty) })),
        ReferenceInstructions.node.replace(
          Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(empty) }),
        ),
        McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(empty) })),
        PluginSupervisor.node.replace(Layer.empty),
        noScratchpad,
        Tool.node.replace(
          Layer.mock(Tool.Service, {
            snapshot: () =>
              Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
          }),
        ),
        Location.node.replace(
          Layer.unwrap(
            Effect.gen(function* () {
              expect(yield* live(fsmonitor)).not.toEqual([])
              const found = yield* planted(fsmonitor)
              state.found = found
              const ref = Location.Ref.make({ directory: AbsolutePath.make(found.root) })
              return Layer.succeed(Location.Service, Location.Service.of(location(ref, { vcs: vcs(found.root) })))
            }).pipe(Effect.orDie),
          ),
        ),
      ],
    ),
  )


const git = (root: string): Project.Vcs => ({ type: "git", store: AbsolutePath.make(path.join(root, ".git")) })
const it = harness(git)

const agentIDs = {
  lean: Agent.ID.make("lean"),
  worker: Agent.ID.make("worker"),
  tweaked: Agent.ID.make("tweaked"),
}

const MARK = "PROJECT-CONVENTION-MARKER"

const setup = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const context = yield* SessionContext.Service
  const trust = yield* ProjectTrust.Service
  const here = yield* Location.Service
  const discovery = yield* InstructionDiscovery.Service
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    editor.update(agentIDs.lean, (agent) => {
      agent.mode = "subagent"
      agent.context = { instructions: false, git_status: false }
    })
    editor.update(agentIDs.worker, (agent) => {
      agent.mode = "subagent"
    })
    editor.update(agentIDs.tweaked, (agent) => {
      agent.mode = "subagent"
      agent.context = { instructions: true, git_status: true }
    })
  })
  yield* discovery.transform((editor) =>
    editor.add(
      new InstructionDiscovery.File({ path: AbsolutePath.make(path.join(here.directory, "AGENTS.md")), content: MARK }),
    ),
  )
  const options = { directory: here.directory }
  yield* insertSession({ id: ids.main, agent: "build", ...options })
  yield* insertSession({ id: ids.child, parentID: ids.main, agent: agentIDs.lean, ...options })
  yield* insertSession({ id: ids.plain,parentID: ids.main, agent: agentIDs.worker, ...options })
  yield* insertSession({ id: ids.other, parentID: ids.main, agent: agentIDs.tweaked, ...options })
  const found = state.found!
  const step = (id: SessionSchema.ID) =>
    Effect.gen(function* () {
      const selected = yield* context.select(id)
      const observation = yield* InstructionState.observe(db, selected.instructions, id)
      const preview = yield* InstructionState.preview(db, id, selected.instructions, yield* Instructions.read(selected.instructions))
      yield* InstructionState.commit(db, bus, selected.instructions, observation)
      return { delta: observation.delta, text: observation.initial ? preview.initial : preview.update }
    })
  const stepped = (id: SessionSchema.ID) => traced(step(id))
  const stored = (id: SessionSchema.ID, name: string) => InstructionState.value(db, id, Instructions.Key.make(name))
  const switchTo = (id: SessionSchema.ID, agent: string) =>
    db.update(SessionTable).set({ agent }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)
  const grant = trust.grant({ persist: false, via: "test" })
  return { agents, step, stepped, stored, switchTo, grant, ran: found.ran }
})

describe("what an agent's context switches leave out of its baseline", () => {
  it.live("gives a lean subagent no instruction file and no git snapshot, and keeps the date and the environment", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored } = yield* setup
      yield* grant
      yield* stepped(ids.main)
      expect(yield* stored(ids.main, key)).toBeDefined()

      const lean = yield* stepped(ids.child)

      expect(lean.value.text).not.toContain(MARK)
      expect(lean.value.text).not.toContain("Current branch")
      expect(Object.keys(lean.value.delta)).not.toContain(filesKey)
      expect(Object.keys(lean.value.delta)).not.toContain(key)
      expect(lean.value.text).toContain("Today's date")
      expect(lean.value.text).toContain("<env>")
      expect(lean.git).toEqual([])
    }),
  )

  it.live("gives a general subagent the instruction files and its parent's snapshot, as the control", () =>
    Effect.gen(function* () {
      const { grant, stepped } = yield* setup
      yield* grant
      yield* stepped(ids.main)

      const worker = yield* stepped(ids.plain)

      expect(worker.value.text).toContain(MARK)
      expect(worker.value.text).toContain("Current branch: main")
      expect(worker.git).toEqual([])
    }),
  )

  it.live("records one removal when a session switches to a lean agent, and the files as new when it switches back", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored, switchTo } = yield* setup
      yield* grant
      const first = yield* stepped(ids.main)
      expect(first.value.text).toContain(MARK)

      yield* switchTo(ids.main, agentIDs.lean)
      const lean = yield* stepped(ids.main)
      expect(lean.value.delta[filesKey]).toBe("removed")
      expect(lean.value.delta[key]).toBe("removed")
      expect(lean.value.text).toContain("Previously loaded instructions no longer apply.")
      expect(lean.value.text).toContain("no longer applies")
      expect(yield* stored(ids.main, key)).toBeUndefined()
      expect((yield* stepped(ids.main)).value.delta).toEqual({})

      yield* switchTo(ids.main, "build")
      const back = yield* stepped(ids.main)
      expect(Object.keys(back.value.delta).sort()).toEqual([filesKey, key].sort())
      expect(back.value.text).toContain(MARK)
      expect(back.value.text).toContain("Current branch: main")
    }),
  )

  it.live("lets an agent turn one switch back on while the other stays off", () =>
    Effect.gen(function* () {
      const { agents, grant, stepped } = yield* setup
      yield* grant
      yield* agents.transform((editor) =>
        editor.update(agentIDs.lean, (agent) => {
          agent.context = { instructions: true, git_status: false }
        }),
      )

      const result = yield* stepped(ids.child)

      expect(result.value.text).toContain(MARK)
      expect(result.value.text).not.toContain("Current branch")
      expect(result.git).toEqual([])
    }),
  )

  it.live("starts no git in an untrusted folder even for an agent that turns both switches on", () =>
    Effect.gen(function* () {
      const { stepped, stored, ran } = yield* setup

      const untrusted = yield* stepped(ids.other)

      expect(untrusted.git).toEqual([])
      expect(yield* ran()).toEqual([])
      expect(yield* stored(ids.other, key)).toBeUndefined()
      expect(Object.keys(untrusted.value.delta)).not.toContain(key)
    }),
  )
})

// Class 8, switching the instruction files off: a document of an untrusted folder cannot hide the user's own files
// (the global file and the memory index come from the same source) from an agent. Columns: the document is trusted or
// not; rows: an existing primary agent, an existing subagent. A new agent is pinned in agent-definition.test.ts.
describe("an agent's context in the document of an untrusted folder", () => {
  const decode = Schema.decodeUnknownSync(Info)
  const document = (input: unknown) => {
    const result = ConfigNormalize.normalize(input)
    if (result.type !== "normalized") throw new Error("expected normalized config")
    return new Document({ type: "document", scope: "project", info: decode(result.encoded) })
  }
  const off = { agents: { build: { context: { instructions: false, git_status: false } }, worker: { context: { instructions: false } } } }

  const configured = (trusted: boolean) =>
    Effect.gen(function* () {
      const result = yield* setup
      const here = yield* Location.Service
      const stamped = document(off)
      const entry = trusted ? stamped : ConfigTrust.stamp(stamped, { roots: [here.directory], directory: here.directory })
      const agents = yield* Agent.Service
      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer([entry])),
      )
      yield* result.grant
      return result
    })

  it.live("keeps the instruction files of build and of a subagent in their baselines, and honours the git switch", () =>
    Effect.gen(function* () {
      const { stepped } = yield* configured(false)
      const main = yield* stepped(ids.main)
      expect(main.value.text).toContain(MARK)
      expect(main.value.text).not.toContain("Current branch")
      expect((yield* stepped(ids.plain)).value.text).toContain(MARK)
    }),
  )

  it.live("removes them when the document is trusted, as the control", () =>
    Effect.gen(function* () {
      const { stepped } = yield* configured(true)
      expect((yield* stepped(ids.main)).value.text).not.toContain(MARK)
      expect((yield* stepped(ids.plain)).value.text).not.toContain(MARK)
    }),
  )
})
