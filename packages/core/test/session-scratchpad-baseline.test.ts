// The scratchpad in the baseline of a session: where it stands among the sources, and who shares it. The sources are the
// real ones for the date, the environment, the scratchpad and the entries of the API, on the real session context.
import { SessionRehydration } from "@orbit/core/session/rehydration"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { Project } from "@orbit/core/project"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { InstructionState } from "@orbit/core/session/instruction-state"
import { SessionHistory } from "@orbit/core/session/history"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Tool } from "@orbit/core/tool"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Effect, Layer } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { noMemory } from "./lib/memory"
import { testEffect } from "./lib/effect"
import { insertSession } from "./lib/session-row"
import { stubSnapshot } from "./lib/tool"

const directory = "/project"
const ids = {
  main: SessionSchema.ID.make("ses_baseline_main"),
  child: SessionSchema.ID.make("ses_baseline_child"),
  fork: SessionSchema.ID.make("ses_baseline_fork"),
  forkOfChild: SessionSchema.ID.make("ses_baseline_forkchild"),
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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionEntry.node,
      SessionScratchpad.node,
      SessionContext.node,
      Global.node,
    ]),
    [
      Global.node.replace(tempGlobalLayer),
      noMemory,
      Config.node.replace(Config.testLayer()),
      SessionRunnerModel.node.replace(models),
      // No files, jobs or plan to restore here; session-rehydration.test.ts covers them.
      SessionRehydration.node.replace(SessionRehydration.noopLayer),
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
            Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
        }),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(directory) })),
    ],
  ),
)

const setup = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const context = yield* SessionContext.Service
  const scratchpad = yield* SessionScratchpad.Service
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  const options = { directory, agent: "build" }
  yield* insertSession({ id: ids.main, ...options })
  yield* insertSession({ id: ids.child, parentID: ids.main, ...options })
  yield* insertSession({ id: ids.fork, fork: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfChild, fork: ids.child, ...options })
  const select = (id: SessionSchema.ID) => context.select(id)
  // The value that a session's baseline would hold for the scratchpad, as it reads it now.
  const value = (id: SessionSchema.ID) =>
    select(id).pipe(
      Effect.flatMap((selected) => Instructions.read(selected.instructions)),
      Effect.map((read) => read.find((entry) => entry.key === "core/scratchpad")?.value),
    )
  const prepare = (id: SessionSchema.ID) =>
    select(id).pipe(Effect.flatMap((selected) => InstructionState.prepare(db, bus, selected.instructions, id)))
  return { context, scratchpad, db, select, value, prepare }
})

describe("the scratchpad among the sources of the baseline", () => {
  it.live("comes after the date and the environment, and before the entries of the API", () =>
    Effect.gen(function* () {
      const { select } = yield* setup
      const entries = yield* InstructionEntry.Service
      yield* entries.put({ sessionID: ids.main, key: InstructionEntry.Key.make("notes"), value: "from the API" })
      const keys: string[] = (yield* select(ids.main)).instructions.map((source) => source.key)
      expect(
        keys.filter((key) => /^(core\/date|core\/environment|core\/vcs-snapshot|core\/scratchpad|core\/tool-results|api\/)/.test(key)),
      ).toEqual(["core/date", "core/environment", "core/vcs-snapshot", "core/scratchpad", "core/tool-results", "api/notes"])
      // The git snapshot sits directly after the environment and the scratchpad directly after it; the tool-results section follows, before the entries.
      expect(keys[keys.indexOf("core/environment") + 1]).toBe("core/vcs-snapshot")
      expect(keys[keys.indexOf("core/vcs-snapshot") + 1]).toBe("core/scratchpad")
      expect(keys[keys.indexOf("core/scratchpad") + 1]).toBe("core/tool-results")
      expect(keys[keys.indexOf("core/tool-results") + 1]).toBe("api/notes")
    }),
  )

  it.live(
    "holds the same folder for a session, its subagent and its fork, and another for a fork of the subagent",
    () =>
      Effect.gen(function* () {
        const { value, scratchpad } = yield* setup
        const folder = scratchpad.path({ id: ids.main })
        expect(typeof folder).toBe("string")
        expect(yield* value(ids.main)).toBe(folder)
        expect(yield* value(ids.child)).toBe(folder)
        expect(yield* value(ids.fork)).toBe(folder)
        // A fork of the subagent goes back only as far as the subagent.
        const forkOfChild = yield* value(ids.forkOfChild)
        expect(forkOfChild).toBe(scratchpad.path({ id: ids.child }))
        expect(forkOfChild).not.toBe(folder)
      }),
  )

  it.live("says nothing of the scratchpad when a subagent or a fork starts from its session's values", () =>
    Effect.gen(function* () {
      const { db, select, prepare } = yield* setup
      yield* prepare(ids.main)
      yield* prepare(ids.child)
      const main = yield* InstructionState.current(db, ids.main)
      // The subagent's first baseline holds the same folder as its session, so the scratchpad is not said again.
      expect((yield* InstructionState.current(db, ids.child))?.["core/scratchpad"]).toBe(main?.["core/scratchpad"])
      expect(main?.["core/scratchpad"]).toBeDefined()

      // A fork starts from the newest values of its session, as `Session.fork` hands them over.
      yield* InstructionState.initialize(db, ids.fork, 0, { initial: main ?? {}, current: main ?? {} })
      const selected = yield* select(ids.fork)
      const observation = yield* InstructionState.observe(db, selected.instructions, ids.fork)
      expect(Object.keys(observation.delta)).not.toContain("core/scratchpad")
      const preview = yield* InstructionState.preview(
        db,
        ids.fork,
        selected.instructions,
        yield* Instructions.read(selected.instructions),
      )
      expect(preview.update).not.toContain("scratchpad")
    }),
  )

  it.live("says once that the folder moved when a fork of a subagent starts from the subagent's values", () =>
    Effect.gen(function* () {
      const { db, select, prepare, scratchpad } = yield* setup
      yield* prepare(ids.child)
      const child = (yield* InstructionState.current(db, ids.child)) ?? {}
      yield* InstructionState.initialize(db, ids.forkOfChild, 0, { initial: child, current: child })
      const selected = yield* select(ids.forkOfChild)
      const observation = yield* InstructionState.observe(db, selected.instructions, ids.forkOfChild)
      expect(Object.keys(observation.delta)).toContain("core/scratchpad")
      const preview = yield* InstructionState.preview(
        db,
        ids.forkOfChild,
        selected.instructions,
        yield* Instructions.read(selected.instructions),
      )
      expect(preview.update).toContain("Your scratchpad moved.")
      expect(preview.update).toContain(`\`${scratchpad.path({ id: ids.child })}\``)
    }),
  )

  it.live("makes nothing when the baseline is selected, read or previewed", () =>
    Effect.gen(function* () {
      const { db, select, scratchpad } = yield* setup
      const selected = yield* select(ids.main)
      yield* Instructions.read(selected.instructions)
      yield* SessionHistory.preview(db, ids.main, selected.instructions, "local")
      const folder = scratchpad.path({ id: ids.main })
      if (folder === undefined) return yield* Effect.die(new Error("Expected the session to have a scratchpad"))
      expect(
        yield* Effect.promise(() =>
          fs.lstat(path.dirname(folder)).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )
})
