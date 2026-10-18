// The git snapshot among the sources of a session's baseline, on the real session context, the real trust and the real
// Git service, over a temporary repository that the Location is bound to. The repository has `core.fsmonitor` planted,
// which git runs for `status` and which writes a marker line, so that a test sees whether git did any work in the folder.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Document, Info } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
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
import { InstructionBlobTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { VcsInstructions } from "@orbit/core/vcs/instructions"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Context, Effect, Layer } from "effect"
import { currentDirectoryOnPath, plant } from "./fixture/decoy"
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
const ids = {
  main: SessionSchema.ID.make("ses_vcs_main"),
  child: SessionSchema.ID.make("ses_vcs_child"),
  fork: SessionSchema.ID.make("ses_vcs_fork"),
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
  found: undefined as { readonly root: string; readonly folder: string; readonly ran: () => Effect.Effect<readonly string[]> } | undefined,
  config: undefined as Config.TestInterface | undefined,
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
        ProjectTrust.node,
        Location.node,
        Global.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        // No implicit trust: the folder is untrusted until a test grants it, which is what the core tests would otherwise skip.
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
        Config.node.replace(
          Config.testLayer().pipe(
            Layer.tap((context) =>
              Effect.sync(() => {
                state.config = Context.get(context, Config.Test)
              }),
            ),
          ),
        ),
        SessionRunnerModel.node.replace(models),
        // A project whose instruction discovery is off, as `orb run --bare` has it: the snapshot does not follow it.
        InstructionDiscovery.node.replace(
          // What ORBIT_DISABLE_INSTRUCTIONS=1 builds (`project` and `global` off), as `orb run --bare` starts its server.
          Layer.mock(InstructionDiscovery.Service, { project: false, global: false, load: () => Effect.succeed(empty) }),
        ),
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
const itMercurial = harness((root) => ({ type: "hg", store: AbsolutePath.make(path.join(root, ".hg")) }))
const itPlain = harness(() => undefined)

const setup = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const context = yield* SessionContext.Service
  const trust = yield* ProjectTrust.Service
  const here = yield* Location.Service
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  const options = { directory: here.directory, agent: "build" }
  const elsewhere = path.join(path.dirname(here.directory), "elsewhere")
  yield* Effect.promise(() => fs.mkdir(elsewhere, { recursive: true }))
  yield* insertSession({ id: ids.main, ...options })
  yield* insertSession({ id: ids.child, parentID: ids.main, ...options })
  yield* insertSession({ id: ids.other, directory: elsewhere, agent: "build" })
  yield* insertSession({ id: ids.fork, fork: ids.main, ...options })
  const found = state.found!
  const control = state.config!
  // One step boundary: the delta that the step would admit, and what it admits.
  const step = (id: SessionSchema.ID) =>
    Effect.gen(function* () {
      const selected = yield* context.select(id)
      const observation = yield* InstructionState.observe(db, selected.instructions, id)
      const preview = yield* InstructionState.preview(db, id, selected.instructions, yield* Instructions.read(selected.instructions))
      yield* InstructionState.commit(db, bus, selected.instructions, observation)
      return { delta: observation.delta, text: observation.initial ? preview.initial : preview.update }
    })
  // The same boundary, with the git processes that it started.
  const stepped = (id: SessionSchema.ID) => traced(step(id))
  const stored = (id: SessionSchema.ID) => InstructionState.value(db, id, key)
  const setStatus = (value: boolean | undefined) =>
    control.setEntries([new Document({ type: "document", info: new Info(value === undefined ? {} : { git_status: value }) })])
  const grant = trust.grant({ persist: false, via: "test" })
  return { context, db, trust, found, step, stepped, stored, setStatus, grant, ran: found.ran }
})

const mentions = (git: readonly string[], command: string) => git.filter((line) => line.includes(command))

describe("the git snapshot in the baseline of a session", () => {
  it.live("is stored at the first step of a trusted folder, and a later step says nothing and starts no git", () =>
    Effect.gen(function* () {
      const { grant, stepped, found, stored } = yield* setup
      yield* grant

      const first = yield* stepped(ids.main)
      expect(Object.keys(first.value.delta)).toContain(key)
      const snapshot = yield* stored(ids.main)
      expect(snapshot).toMatchObject({ branch: "main", main: "main", user: "Test", late: false, truncated: false })
      expect(snapshot).toMatchObject({ status: " M a.txt", commits: [expect.stringMatching(/ one$/)] })
      expect(first.value.text).toContain("This is the state of the git repository when the session began.")
      // The trusted control: git ran, and ran the key that the folder plants.
      expect(mentions(first.git, "status")).not.toEqual([])
      expect(mentions(first.git, "log")).not.toEqual([])
      expect(mentions(first.git, "config")).not.toEqual([])
      expect((yield* found.ran()).length).toBeGreaterThan(0)

      // The tree changes, and the snapshot does not.
      yield* Effect.promise(() => Bun.write(path.join(found.root, "b.txt"), "new\n"))
      const second = yield* stepped(ids.main)
      expect(second.value.delta).toEqual({})
      expect(second.git).toEqual([])
      expect(yield* stored(ids.main)).toEqual(snapshot)
    }),
  )

  it.live("starts no git and holds no snapshot while the folder is untrusted, then admits one update after a grant", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored, ran } = yield* setup

      const before = yield* stepped(ids.main)
      expect(Object.keys(before.value.delta)).not.toContain(key)
      expect(before.git).toEqual([])
      expect(yield* ran()).toEqual([])
      expect(yield* stored(ids.main)).toBeUndefined()

      yield* grant
      // The folder was trusted partway through the session, which already holds its baseline.
      const after = yield* stepped(ids.main)
      expect(Object.keys(after.value.delta)).toEqual([key])
      expect(after.value.text).toContain("captured partway through the session")
      expect(after.value.text).toContain("Current branch: main")
      expect(mentions(after.git, "status")).toHaveLength(1)
      expect((yield* ran()).length).toBeGreaterThan(0)
      expect(yield* stored(ids.main)).toMatchObject({ late: true })

      const again = yield* stepped(ids.main)
      expect(again.value.delta).toEqual({})
      expect(again.git).toEqual([])
    }),
  )

  it.live("is removed at the next step when trust is taken away, with no git, and captured afresh on a new grant", () =>
    Effect.gen(function* () {
      const { grant, trust, stepped, stored, ran } = yield* setup
      yield* grant
      yield* stepped(ids.main)
      expect(yield* stored(ids.main)).toBeDefined()
      const runs = (yield* ran()).length

      yield* trust.revoke()
      const revoked = yield* stepped(ids.main)
      expect(revoked.value.delta[key]).toBe("removed")
      expect(revoked.value.text).toContain("no longer applies")
      expect(revoked.git).toEqual([])
      expect(yield* stored(ids.main)).toBeUndefined()
      expect((yield* ran()).length).toBe(runs)

      yield* grant
      const regranted = yield* stepped(ids.main)
      expect(Object.keys(regranted.value.delta)).toEqual([key])
      expect(mentions(regranted.git, "status")).toHaveLength(1)
    }),
  )

  it.live("is not stored when git_status is false, and a session that holds it gets one removal when it turns false", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored, setStatus } = yield* setup
      yield* grant
      yield* setStatus(false)
      const off = yield* stepped(ids.main)
      expect(Object.keys(off.value.delta)).not.toContain(key)
      expect(off.git).toEqual([])
      expect(yield* stored(ids.main)).toBeUndefined()

      yield* setStatus(undefined)
      yield* stepped(ids.child)
      expect(yield* stored(ids.child)).toBeDefined()
      yield* setStatus(false)
      const removed = yield* stepped(ids.child)
      expect(removed.value.delta[key]).toBe("removed")
      expect(yield* stored(ids.child)).toBeUndefined()
    }),
  )

  it.live("gives a subagent its parent's snapshot without running git", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored } = yield* setup
      yield* grant
      yield* stepped(ids.main)

      const child = yield* stepped(ids.child)

      expect(child.git).toEqual([])
      expect(yield* stored(ids.child)).toEqual(yield* stored(ids.main))
    }),
  )

  it.live("starts no git for a fork that starts from the values of its session", () =>
    Effect.gen(function* () {
      const { grant, stepped, db, found } = yield* setup
      yield* grant
      yield* stepped(ids.main)
      yield* Effect.promise(() => Bun.write(path.join(found.root, "c.txt"), "later\n"))
      const v = (yield* InstructionState.current(db, ids.main)) ?? {}
      yield* InstructionState.initialize(db, ids.fork, 0, { initial: v, current: v })

      const fork = yield* stepped(ids.fork)

      expect(fork.value.delta).toEqual({})
      expect(fork.git).toEqual([])
    }),
  )

  it.live("is captured once when a preview comes before the first step", () =>
    Effect.gen(function* () {
      const { grant, context, step, stored } = yield* setup
      yield* grant

      const run = yield* traced(
        Effect.gen(function* () {
          const selected = yield* context.select(ids.main)
          yield* Instructions.read(selected.instructions)
          return yield* step(ids.main)
        }),
      )

      expect(mentions(run.git, " status")).toHaveLength(1)
      expect(yield* stored(ids.main)).toMatchObject({ late: false })
    }),
  )

  it.live("leaves a session without a snapshot, and does not run git again, when status fails", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored, found } = yield* setup
      yield* grant
      yield* Effect.promise(() => fs.writeFile(path.join(found.root, ".git", "index"), "not an index"))

      const first = yield* stepped(ids.main)
      expect(Object.keys(first.value.delta)).not.toContain(key)
      expect(mentions(first.git, " status")).toHaveLength(1)
      expect(yield* stored(ids.main)).toBeUndefined()

      const second = yield* stepped(ids.main)
      expect(second.git).toEqual([])
      expect(Object.keys(second.value.delta)).not.toContain(key)
    }),
  )

  it.live("keeps the snapshot with project and global instruction discovery off, which is how orb run --bare starts", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored } = yield* setup
      yield* grant

      const run = yield* stepped(ids.main)

      expect(Object.keys(run.value.delta)).toContain(key)
      expect(yield* stored(ids.main)).toMatchObject({ branch: "main" })
    }),
  )

  it.live("keeps the same snapshot through compaction and starts no git", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored, db, context } = yield* setup
      yield* grant
      yield* stepped(ids.main)
      const before = yield* stored(ids.main)
      yield* InstructionState.advanceEpoch(db, ids.main, 7)

      const after = yield* stepped(ids.main)
      const selected = yield* context.select(ids.main)

      expect(after.git).toEqual([])
      expect(after.value.delta).toEqual({})
      expect(yield* stored(ids.main)).toEqual(before)
      expect(yield* InstructionState.initial(db, ids.main, selected.instructions)).toContain("Current branch: main")
    }),
  )

  it.live("captures its own snapshot for a child session in another location", () =>
    Effect.gen(function* () {
      const { grant, db } = yield* setup
      const vcs = yield* VcsInstructions.Service
      yield* grant
      // The parent lives in another folder and holds a snapshot of that folder's repository.
      const theirs = { branch: "theirs", main: "theirs", user: "", status: "", truncated: false, commits: [], late: false }
      const hash = Instructions.hash(theirs)
      yield* db.insert(InstructionBlobTable).values({ hash, value: theirs }).onConflictDoNothing().run()
      yield* InstructionState.initialize(db, ids.other, 0, { initial: { [key]: hash }, current: { [key]: hash } })

      const run = yield* traced(Instructions.read(vcs.source({ id: ids.child, parentID: ids.other })))

      expect(mentions(run.git, " status")).not.toEqual([])
      expect(run.value[0]?.value).toMatchObject({ branch: "main", user: "Test" })
    }),
  )

  it.live("admits the snapshot at the next step when the first step was interrupted during a slow status", () =>
    Effect.gen(function* () {
      const { grant, step, stored, found } = yield* setup
      yield* grant
      // The key program takes a while, so the first step is stopped while git status runs.
      yield* Effect.promise(() => Bun.write(path.join(found.folder, "program.sh"), "#!/bin/sh\nsleep 2\n"))
      const first = yield* Effect.exit(step(ids.main).pipe(Effect.timeout("500 millis")))
      expect(first._tag).toBe("Failure")
      expect(yield* stored(ids.main)).toBeUndefined()

      const second = yield* step(ids.main)
      const third = yield* step(ids.main)

      expect(Object.keys(second.delta)).toContain(key)
      expect(third.delta).toEqual({})
      expect(yield* stored(ids.main)).toMatchObject({ branch: "main" })
    }),
  )

  it.live("captures its own snapshot when the value of the parent no longer matches the schema", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored, db } = yield* setup
      yield* grant
      const old = { branch: "main" }
      const hash = Instructions.hash(old)
      yield* db.insert(InstructionBlobTable).values({ hash, value: old }).onConflictDoNothing().run()
      yield* InstructionState.initialize(db, ids.main, 0, { initial: { [key]: hash }, current: { [key]: hash } })

      const child = yield* stepped(ids.child)

      expect(mentions(child.git, " status")).not.toEqual([])
      expect(yield* stored(ids.child)).toMatchObject({ main: "main", user: "Test" })
    }),
  )

  it.live("never reports unavailable, so it cannot block the first admission", () =>
    Effect.gen(function* () {
      const { context } = yield* setup
      const selected = yield* context.select(ids.main)
      const read = yield* Instructions.read(selected.instructions)
      expect(read.find((entry) => entry.key === key)?.value).toBe(Instructions.removed)
    }),
  )
})

describe("the git snapshot outside a git repository", () => {
  for (const [name, test] of [
    ["a Mercurial", itMercurial],
    ["a plain", itPlain],
  ] as const)
    test.live(`is not taken in ${name} folder, even when trusted`, () =>
      Effect.gen(function* () {
        const { grant, stepped, stored } = yield* setup
        yield* grant

        const run = yield* stepped(ids.main)

        expect(Object.keys(run.value.delta)).not.toContain(key)
        expect(run.git).toEqual([])
        expect(yield* stored(ids.main)).toBeUndefined()
      }),
    )
})

// Windows looks in the working folder before PATH for a program started by its name (class 10). The folder is trusted, so
// the snapshot runs git, and the git that runs must be the one that was found, never a decoy that the clone ships.
describe.skipIf(process.platform !== "win32")("the git of the snapshot and decoys in the folder", () => {
  it.live("runs the real git and none of the programs named git that the folder holds", () =>
    Effect.gen(function* () {
      const { grant, stepped, stored, found } = yield* setup
      const lookup = currentDirectoryOnPath()
      yield* Effect.addFinalizer(() => Effect.sync(() => lookup[Symbol.dispose]()))
      const ran = yield* Effect.promise(() => plant(found.root, "git"))
      yield* Effect.promise(() => Bun.write(path.join(found.root, "git.bat"), "@echo off\r\necho ran> ran.txt\r\n"))
      yield* grant

      yield* stepped(ids.main)

      expect(yield* stored(ids.main)).toMatchObject({ branch: "main", user: "Test" })
      expect(yield* Effect.promise(ran)).toEqual([])
    }).pipe(Effect.scoped),
  )
})
