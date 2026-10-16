import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Schedule } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { VcsGitPlugin } from "@orbit/core/plugin/vcs/git"
import { AbsolutePath } from "@orbit/core/schema"
import { Vcs } from "@orbit/core/vcs"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { AppProcess } from "@orbit/util/process"
import { keys, live, planted } from "./fixture/git-keys"
import { traced } from "./fixture/git-trace"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

// Class 1 (register FU-M1-022): the Git provider runs `git status`, `git diff` and `git reflog show` in the folder, and the
// terminal UI asks for the branch of the folder it opens before anyone is asked about it. Git applies the folder's own
// `.git/config`, so `status` runs the `filter.<driver>.clean` that it names, `diff` the `diff.<driver>.textconv`, and
// `reflog show` the `gpg.program` for a commit that carries a signature. The provider starts no git until the folder is
// trusted. The oracle is git's trace of every process it starts and a program that the config names and that records its runs;
// the trusted rows are the control, and the plain git command of each key shows that the key is live.

const graph = (folder: string, implicit: boolean) =>
  AppNodeBuilder.build(
    LayerNode.group([Vcs.node, Bus.node, Location.node, ProjectTrust.node, WorkspaceTrust.node, AppProcess.node, FSUtil.node]),
    [
      ...untrustedProjectNodes,
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(
            location(
              { directory: AbsolutePath.make(folder) },
              { vcs: { type: "git", store: AbsolutePath.make(path.join(folder, ".git")) } },
            ),
          ),
        ),
      ),
    ],
  )

/** The provider, registered the way the plugin host does, and what the server's `vcs.*` handlers ask of it. */
const answers = Effect.gen(function* () {
  const vcs = yield* Vcs.Service
  const context = host()
  yield* VcsGitPlugin.Plugin.effect({ ...context, vcs: { ...context.vcs, transform: vcs.transform, reload: vcs.reload } })
  // The commands may fail in a folder that is set up to fail; what they ran is what the test reads.
  return {
    info: yield* vcs.info(),
    branches: yield* vcs.branches(),
    status: yield* vcs.status(),
    working: yield* Effect.exit(vcs.diff("working")),
    branch: yield* Effect.exit(vcs.diff("branch")),
    base: yield* Effect.exit(vcs.base()),
  }
})

const it = testEffect(Layer.empty)
const SLOW = 90_000

describe("the Git provider in a folder that is not trusted, whatever its config names", () => {
  for (const key of keys)
    it.live(
      `starts no git and runs no program for ${key.name}`,
      () =>
        Effect.gen(function* () {
          if (key.trigger) expect(yield* live(key)).not.toEqual([])
          const found = yield* planted(key)

          const { value, git } = yield* traced(answers.pipe(Effect.provide(graph(found.root, false))))

          expect(git).toEqual([])
          expect(yield* found.ran()).toEqual([])
          // The branch is unknown, nothing has changed, and there is no diff or review base.
          expect(value.info).toEqual({ provider: "git", branch: {} })
          expect(value.branches).toEqual([])
          expect(value.status).toEqual([])
          expect(value.working._tag === "Success" ? value.working.value : "failed").toEqual([])
          expect(value.branch._tag === "Success" ? value.branch.value : "failed").toEqual([])
          expect(value.base._tag === "Success" ? value.base.value : "failed").toBeNull()
        }),
      SLOW,
    )

  for (const key of keys)
    it.live(
      `starts git in a trusted folder that sets ${key.name}, and runs the program only where git reaches it (control)`,
      () =>
        Effect.gen(function* () {
          const found = yield* planted(key)

          const { value, git } = yield* traced(answers.pipe(Effect.provide(graph(found.root, true))))

          expect(git.some((command) => command.includes("status"))).toBe(true)
          expect(value.info.branch.current).toBe("main")
          // `true`: a command of the provider runs the program, which is the hole. `false`: the provider switches the key
          // off (`-c core.fsmonitor=false`, `--no-ext-diff`). Where git decides, nothing is asserted.
          if (key.provider === true) expect((yield* found.ran()).length).toBeGreaterThan(0)
          if (key.provider === false) expect(yield* found.ran()).toEqual([])
        }),
      SLOW,
    )

  it.live(
    "answers from git without a reconnect once the folder is trusted",
    () =>
      Effect.gen(function* () {
        const found = yield* planted(keys[0]!)
        yield* Effect.gen(function* () {
          const vcs = yield* Vcs.Service
          const context = host()
          yield* VcsGitPlugin.Plugin.effect({
            ...context,
            vcs: { ...context.vcs, transform: vcs.transform, reload: vcs.reload },
          })
          expect((yield* vcs.info()).branch).toEqual({})
          expect(yield* vcs.status()).toEqual([])

          yield* (yield* WorkspaceTrust.Service).grant(found.root, { persist: false, via: "test" })

          // The grant publishes `trust.updated`, which reloads the provider.
          yield* Effect.suspend(() => vcs.info()).pipe(
            Effect.filterOrFail((info) => info.branch.current === "main"),
            Effect.retry(Schedule.spaced("20 millis")),
            Effect.timeout("10 seconds"),
          )
          expect((yield* vcs.status()).map((row) => row.file)).toEqual(["a.txt"])
        }).pipe(Effect.provide(graph(found.root, false)))
      }),
    SLOW,
  )
})
