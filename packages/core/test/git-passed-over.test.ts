import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { Git } from "@orbit/core/git"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { VcsGitPlugin } from "@orbit/core/plugin/vcs/git"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionSchema } from "@orbit/core/session/schema"
import { Vcs } from "@orbit/core/vcs"
import { VcsInstructions } from "@orbit/core/vcs/instructions"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { AppProcess } from "@orbit/util/process"
import { inner, opened, outer, shapes } from "./fixture/git-passed-over"
import { traced } from "./fixture/git-trace"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

// Classes 1 and 3: git passes over a `.git` directory that it does not take for a repository and uses the repository
// above, with that repository's config. A clone ships `sub/.git` in such a shape, and its own config names programs for
// git to run: a file system monitor (status), a clean filter (status, diff), a text conversion (diff) and a signature
// checker (log). Two things keep those programs from running when a person trusts `sub`:
//
// - `Project.resolve` passes over the `.git` directories that git passes over, so the folder it names, which is the folder
//   the person is asked about, is the repository git uses (`GitLayout.locate`). Mutation: taking a `.git` directory with a
//   `HEAD` file for a repository, as before, fails every row of "names the repository that git uses".
// - Every git that Orbit starts for a Location looks for the repository no further up than the folder the trust decision
//   covers (`Git.ceiling`, `GIT_CEILING_DIRECTORIES`). Each surface below runs for a Location whose project is `sub`, as
//   a resolve that took the `.git` for a repository named it, after the person trusted `sub`. Mutation: `Git.ceiling`
//   answering `{}` fails every row of the first four surfaces (the outer program runs, or git opens the outer
//   repository). `Project.resolve` names the repository above by itself now, so its rows fail when both mutations are
//   made together.
//
// The oracles are git's trace, which names the work tree of each repository a git process opened, and the outer
// repository's program, which records its runs. Every row first checks with a plain git that git does pass over the
// shape. Two controls show each surface is live: `sub` made a repository that git takes is opened once trusted (and the
// snapshot and the provider run its own program), and the outer repository is opened, and runs its program for those two,
// once it is trusted itself.

const it = testEffect(Layer.empty)
const SLOW = 120_000
const abs = AbsolutePath.make

// A Location whose project is `folder`, a git repository by the Location's account, in a graph where nothing is trusted
// until the test grants it.
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

// The person trusts the Location's project, which is the folder the dialog named.
const grant = Effect.gen(function* () {
  const trust = yield* ProjectTrust.Service
  yield* trust.grant({ persist: false, via: "test" })
})

interface Surface {
  readonly name: string
  /** Whether a command of the surface runs a program that the planted config names, once its repository is trusted. */
  readonly programs: boolean
  /** Runs the surface for a Location whose project is `folder`, once the person has trusted that folder. */
  readonly run: (folder: string) => Effect.Effect<unknown, unknown>
}

const surfaces: readonly Surface[] = [
  {
    name: "the git snapshot of a session (VcsInstructions)",
    programs: true,
    run: (folder) =>
      Effect.gen(function* () {
        yield* grant
        const vcs = yield* VcsInstructions.Service
        const read = yield* vcs.source({ id: SessionSchema.ID.make("ses_passed_over") })[0]!.read
        return read === Instructions.removed ? "none" : read
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([VcsInstructions.node, ProjectTrust.node, Database.node, Bus.node]), named(folder)),
        ),
      ),
  },
  {
    name: "the Git provider's info, status, diff and review base (VcsGit)",
    programs: true,
    run: (folder) =>
      Effect.gen(function* () {
        yield* grant
        const vcs = yield* Vcs.Service
        const context = host()
        yield* VcsGitPlugin.Plugin.effect({ ...context, vcs: { ...context.vcs, transform: vcs.transform, reload: vcs.reload } })
        return {
          info: yield* vcs.info(),
          status: yield* vcs.status(),
          working: yield* Effect.exit(vcs.diff("working")),
          base: yield* Effect.exit(vcs.base()),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([Vcs.node, Bus.node, Location.node, ProjectTrust.node, WorkspaceTrust.node, AppProcess.node, FSUtil.node]),
            named(folder),
          ),
        ),
      ),
  },
  {
    name: "the ignore check of language server results (Lsp.ignored)",
    programs: false,
    run: (folder) =>
      Effect.gen(function* () {
        yield* grant
        const lsp = yield* Lsp.Service
        return [...(yield* lsp.ignored([path.join(folder, "hidden.txt")]))]
      }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([Lsp.node, ProjectTrust.node]), named(folder)))),
  },
  {
    // Snapshot, InstructionNotes.keepOut and the git worktree strategy call it with the folder the decision covers.
    name: "Git.repo.discover",
    programs: false,
    run: (folder) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        return (yield* git.repo.discover(abs(folder)))?.worktree
      }).pipe(Effect.provide(AppNodeBuilder.build(Git.node, []))),
  },
  {
    name: "Project.resolve",
    programs: false,
    run: (folder) =>
      Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folder, { persist: false, via: "test" })
        const project = yield* Project.Service
        return yield* project.resolve(abs(folder))
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, WorkspaceTrust.node]), untrustedProjectNodes),
        ),
      ),
  },
]

// What a plain git in `folder` takes for the work tree of its repository.
const toplevel = (folder: string) =>
  Effect.sync(() => {
    const child = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: folder, stdout: "pipe", stderr: "ignore" })
    return path.resolve(child.stdout.toString().trim())
  })

describe("Project.resolve names the repository that git uses, for a folder whose .git git passes over", () => {
  for (const [name, fill] of shapes)
    it.live(
      `names the repository above while it is untrusted, and starts no git, for ${name}`,
      () =>
        Effect.gen(function* () {
          const found = yield* outer(fill)
          expect(yield* toplevel(found.sub)).toBe(found.root)

          const resolved = yield* traced(
            Effect.gen(function* () {
              const project = yield* Project.Service
              return yield* project.resolve(abs(found.sub))
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, WorkspaceTrust.node]), untrustedProjectNodes),
              ),
            ),
          )

          expect(resolved.git).toEqual([])
          expect({ directory: resolved.value.directory, canonical: resolved.value.canonical }).toEqual({
            directory: abs(found.root),
            canonical: abs(found.root),
          })
          expect(resolved.value.vcs).toEqual({ type: "git", store: abs(path.join(found.root, ".git")) })
        }),
      SLOW,
    )
})

describe("git that Orbit starts for a trusted folder stays out of the untrusted repository above it", () => {
  for (const surface of surfaces)
    for (const [name, fill] of shapes)
      it.live(
        `${surface.name}, for ${name}`,
        () =>
          Effect.gen(function* () {
            const found = yield* outer(fill)
            expect(yield* toplevel(found.sub)).toBe(found.root)

            const result = yield* traced(surface.run(found.sub))

            expect(opened(result.worktrees, found.root)).toBe(false)
            expect(yield* found.ran()).toEqual([])
            expect((yield* (yield* WorkspaceTrust.Service).status(found.root)).trusted).toBe(false)
          }).pipe(Effect.provide(AppNodeBuilder.build(WorkspaceTrust.node, untrustedProjectNodes))),
        SLOW,
      )

  for (const surface of surfaces)
    it.live(
      `${surface.name}: a folder whose .git git takes runs its own repository's git once trusted (control)`,
      () =>
        Effect.gen(function* () {
          const found = yield* outer()
          const own = yield* inner(found)
          expect(yield* toplevel(found.sub)).toBe(found.sub)

          const result = yield* traced(surface.run(found.sub))

          expect(opened(result.worktrees, found.sub)).toBe(true)
          expect(opened(result.worktrees, found.root)).toBe(false)
          if (surface.programs) expect((yield* own.ran()).length).toBeGreaterThan(0)
          expect(yield* found.ran()).toEqual([])
        }),
      SLOW,
    )

  for (const surface of surfaces)
    it.live(
      `${surface.name}: the repository above runs its git once it is trusted itself (control)`,
      () =>
        Effect.gen(function* () {
          const found = yield* outer()

          const result = yield* traced(surface.run(found.root))

          expect(opened(result.worktrees, found.root)).toBe(true)
          if (surface.programs) expect((yield* found.ran()).length).toBeGreaterThan(0)
        }),
      SLOW,
    )
})

// Git reads GIT_CEILING_DIRECTORIES as a list split at the path list separator, so a folder whose path holds one cannot be
// a ceiling, and a command there would look above the project's folder. Mutation: `ceiling` returning the variable for
// such a folder too fails both rows (in the second, `status.short` starts git).
describe("Git.ceiling", () => {
  const root = path.parse(process.cwd()).root

  it.live("is the folder above, nothing for a filesystem root, and none for a folder above that holds the list separator", () =>
    Effect.sync(() => {
      expect(Git.ceiling(path.join(root, "work", "repo"))).toEqual({ GIT_CEILING_DIRECTORIES: path.join(root, "work") })
      expect(Git.ceiling(root)).toEqual({})
      expect(Git.ceiling(path.join(root, `a${path.delimiter}b`, "repo"))).toBeUndefined()
    }),
  )

  it.live(
    "starts no git for a repository whose folder above holds the list separator",
    () =>
      Effect.gen(function* () {
        const found = yield* outer()
        const own = yield* inner(found)
        const parent = path.join(found.folder, `a${path.delimiter}b`)
        const repository = abs(path.join(parent, "repo"))
        yield* Effect.promise(async () => {
          await fs.mkdir(parent)
          await fs.rename(found.sub, repository)
        })

        const result = yield* traced(
          Effect.gen(function* () {
            const git = yield* Git.Service
            return yield* Effect.exit(git.status.short(repository, 64 * 1024, repository))
          }).pipe(Effect.provide(AppNodeBuilder.build(Git.node, []))),
        )

        expect(result.value._tag).toBe("Failure")
        expect(result.git).toEqual([])
        expect(yield* own.ran()).toEqual([])
      }),
    SLOW,
  )
})
