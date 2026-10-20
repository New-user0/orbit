import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Logger, Schedule, Scope } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { ProjectTrust } from "@orbit/core/project-trust"
import { VcsGitPlugin } from "@orbit/core/plugin/vcs/git"
import { AbsolutePath } from "@orbit/core/schema"
import { Vcs } from "@orbit/core/vcs"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { AppProcess } from "@orbit/util/process"
import { git } from "./fixture/git"
import { outer, pointers } from "./fixture/git-passed-over"
import { traced } from "./fixture/git-trace"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

// Classes 1, 3 and 14 (M4 verification round 9): the Git provider and `Lsp.ignored` start git only when
// `ProjectTrust.git` says so. It reads the trust of the project and of each folder of the repository that git uses at
// every call, and it keeps git's answer to which repository that is, and the refusals it has logged, until a trust event
// clears them. So a revoke takes effect at the next call: of the folder, or of the repository above a granted folder
// whose `.git` leads there. The oracle is git's trace of every process it starts (`GIT_TRACE2`).
//
// Mutations (recorded in the commit): `ProjectTrust.git` answering yes for a folder for good once it has said yes fails
// the four revoke rows; the `trust.updated` subscription no longer clearing the kept answers and refusals fails the row
// "asks git again and logs a refusal again after a trust event".

const it = testEffect(Layer.empty)
const SLOW = 120_000
const abs = AbsolutePath.make

// A Location whose project is `folder`, a git repository, in a graph where nothing is trusted until the test grants it.
const named = (folder: string) => [
  ...untrustedProjectNodes,
  Location.node.replace(
    Layer.succeed(
      Location.Service,
      Location.Service.of(
        location({ directory: abs(folder) }, { vcs: { type: "git", store: abs(path.join(folder, ".git")) } }),
      ),
    ),
  ),
]

// The git processes that did more than ask which repository git uses.
const further = (lines: readonly string[]) => lines.filter((line) => !/\srev-parse\s/.test(` ${line} `))

type Body = (
  call: Effect.Effect<unknown, unknown>,
) => Effect.Effect<void, unknown, ProjectTrust.Service | WorkspaceTrust.Service | Scope.Scope>

interface Surface {
  readonly name: string
  /** Runs `body` for a Location whose project is `folder`, with the call of the surface that starts its git. */
  readonly use: (folder: string, body: Body) => Effect.Effect<void, unknown>
}

const surfaces: readonly Surface[] = [
  {
    name: "the Git provider (VcsGit)",
    use: (folder, body) =>
      Effect.gen(function* () {
        const vcs = yield* Vcs.Service
        const context = host()
        yield* VcsGitPlugin.Plugin.effect({
          ...context,
          vcs: { ...context.vcs, transform: vcs.transform, reload: vcs.reload },
        })
        yield* body(Effect.all([vcs.info(), vcs.status(), Effect.exit(vcs.diff("working"))]))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              Vcs.node,
              Bus.node,
              Location.node,
              ProjectTrust.node,
              WorkspaceTrust.node,
              AppProcess.node,
              FSUtil.node,
            ]),
            named(folder),
          ),
        ),
      ),
  },
  {
    name: "the ignore check of language server results (Lsp.ignored)",
    use: (folder, body) =>
      Effect.gen(function* () {
        const lsp = yield* Lsp.Service
        yield* body(lsp.ignored([path.join(folder, "hidden.txt")]))
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Lsp.node, ProjectTrust.node, WorkspaceTrust.node]), named(folder)),
        ),
      ),
  },
]

describe("a revoke stops the git of the Git provider and of Lsp.ignored at the next call", () => {
  for (const surface of surfaces) {
    it.live(
      `${surface.name}: a revoke of the folder after a first call that ran git`,
      () =>
        Effect.gen(function* () {
          const found = yield* outer()
          yield* surface.use(found.root, (call) =>
            Effect.gen(function* () {
              const project = yield* ProjectTrust.Service
              yield* project.grant({ persist: false, via: "test" })

              expect(further((yield* traced(call)).git).length).toBeGreaterThan(0)
              yield* project.revoke()
              expect((yield* traced(call)).git).toEqual([])
            }),
          )
        }),
      SLOW,
    )

    it.live(
      `${surface.name}: a revoke of the repository above a granted folder whose .git leads there`,
      () =>
        Effect.gen(function* () {
          const found = yield* outer(pointers[0]![1])
          yield* surface.use(found.sub, (call) =>
            Effect.gen(function* () {
              const project = yield* ProjectTrust.Service
              const store = yield* WorkspaceTrust.Service
              yield* project.grant({ persist: false, via: "test" })
              yield* store.grant(found.root, { persist: false, via: "test" })

              expect(further((yield* traced(call)).git).length).toBeGreaterThan(0)
              yield* store.revoke(found.root)
              expect(further((yield* traced(call)).git)).toEqual([])
              expect((yield* store.status(found.sub)).trusted).toBe(true)
            }),
          )
        }),
      SLOW,
    )
  }
})

describe("ProjectTrust.git", () => {
  it.live(
    "asks git again and logs a refusal again after a trust event, and keeps both until one",
    () =>
      Effect.gen(function* () {
        const found = yield* outer(pointers[0]![1])
        const logged: unknown[] = []
        const logger = Logger.make((entry) => {
          const [message] = Array.isArray(entry.message) ? entry.message : [entry.message]
          if (message === "git not used for this folder") logged.push(message)
        })
        yield* Effect.gen(function* () {
          const project = yield* ProjectTrust.Service
          const store = yield* WorkspaceTrust.Service
          yield* project.grant({ persist: false, via: "test" })
          const elsewhere = path.join(found.folder, "elsewhere")

          // The `.git` of `sub` leads into the repository above, which nobody trusted: refused, and logged once.
          const first = yield* traced(project.git())
          expect([first.value, first.git.length > 0, logged.length]).toEqual([false, true, 1])
          const second = yield* traced(project.git())
          expect([second.value, second.git, logged.length]).toEqual([false, [], 1])

          // A trust event clears what was kept: git is asked again, and the refusal is logged again.
          yield* store.grant(elsewhere, { persist: false, via: "test" })
          const again = yield* traced(
            Effect.suspend(() => project.git()).pipe(
              Effect.filterOrFail(() => logged.length === 2),
              Effect.retry(Schedule.spaced("20 millis")),
              Effect.timeout("10 seconds"),
            ),
          )
          expect([again.value, again.git.some((line) => / rev-parse /.test(line)), logged.length]).toEqual([
            false,
            true,
            2,
          ])

          // `sub` becomes a repository of its own. The kept answer still names the repository above until the next event.
          yield* Effect.promise(async () => {
            await fs.rm(path.join(found.sub, ".git"), { force: true })
            await git(found.sub, "init", "-b", "main")
          })
          const kept = yield* traced(project.git())
          expect([kept.value, kept.git, logged.length]).toEqual([false, [], 2])
          yield* store.revoke(elsewhere)
          const fresh = yield* Effect.suspend(() => project.git()).pipe(
            Effect.filterOrFail((allowed) => allowed),
            Effect.retry(Schedule.spaced("20 millis")),
            Effect.timeout("10 seconds"),
          )
          expect([fresh, logged.length]).toEqual([true, 2])
        }).pipe(
          Effect.provide(Logger.layer([logger])),
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([ProjectTrust.node, WorkspaceTrust.node, Bus.node]), named(found.sub)),
          ),
        )
      }),
    SLOW,
  )
})
