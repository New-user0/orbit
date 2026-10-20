import { describe, expect } from "bun:test"
import { realpathSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Logger } from "effect"
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
import { Snapshot } from "@orbit/core/snapshot"
import { Vcs } from "@orbit/core/vcs"
import { VcsInstructions } from "@orbit/core/vcs/instructions"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { WorktreeGit } from "@orbit/core/worktree/git"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { AppProcess } from "@orbit/util/process"
import { git } from "./fixture/git"
import { inner, opened, outer, pointers, shapes } from "./fixture/git-passed-over"
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
//   answering `{}` fails every row of the git snapshot, the provider, `Lsp.ignored`, the undo snapshot and `discover`
//   (git opens the outer repository, if only to say which repository it uses). `Project.resolve` and the worktree
//   strategy read the `.git` with `GitLayout` first, so their rows fail when both mutations are made together, all but
//   the `commondir` shape's.
//
// The oracles are git's trace, which names the work tree of each repository a git process opened, and the outer
// repository's program, which records its runs. Every row first checks with a plain git that git does pass over the
// shape. Two controls show each surface is live: `sub` made a repository that git takes is opened once trusted (and the
// snapshot and the provider run its own program), and the outer repository is opened, and runs its program for those two,
// once it is trusted itself.

const it = testEffect(Layer.empty)
const SLOW = 120_000
const abs = AbsolutePath.make

/** What a person trusted besides the Location's project, and the main checkout of that project when it is not its folder. */
interface Options {
  readonly also?: readonly string[]
  readonly canonical?: string
}

// A Location whose project is `folder`, a git repository by the Location's account, in a graph where nothing is trusted
// until the test grants it.
const named = (folder: string, options: Options = {}) => {
  const found = location({ directory: abs(folder) }, { vcs: { type: "git", store: abs(path.join(folder, ".git")) } })
  return [
    ...untrustedProjectNodes,
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of({ ...found, project: { ...found.project, canonical: abs(options.canonical ?? folder) } }),
      ),
    ),
  ]
}

// The person trusts the Location's project, which is the folder the dialog named, and the folders of `also`.
const grant = (options: Options) =>
  Effect.gen(function* () {
    const trust = yield* ProjectTrust.Service
    yield* trust.grant({ persist: false, via: "test" })
    const store = yield* WorkspaceTrust.Service
    for (const folder of options.also ?? []) yield* store.grant(folder, { persist: false, via: "test" })
  })

// The git worktree strategy, run in `folder` once the person has trusted it and the folders of `also`. A refusal is a value.
const worktrees = <A, E>(
  folder: string,
  options: Options,
  act: (strategy: Effect.Success<typeof WorktreeGit.make>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    for (const item of [folder, ...(options.also ?? [])]) yield* trust.grant(item, { persist: false, via: "test" })
    return yield* Effect.exit(act(yield* WorktreeGit.make))
  }).pipe(
    Effect.provide(AppNodeBuilder.build(LayerNode.group([WorkspaceTrust.node, Git.node, FSUtil.node]), untrustedProjectNodes)),
  )

interface Surface {
  readonly name: string
  /** Whether a command of the surface runs a program that the planted config names, once its repository is trusted. */
  readonly programs: boolean
  /** Whether the surface starts git for more than the question which repository git uses, once it may. */
  readonly beyond: boolean
  /** Runs the surface for a Location whose project is `folder`, once the person has trusted that folder. */
  readonly run: (folder: string, options?: Options) => Effect.Effect<unknown, unknown>
}

const surfaces: readonly Surface[] = [
  {
    name: "the git snapshot of a session (VcsInstructions)",
    programs: true,
    beyond: true,
    run: (folder, options = {}) =>
      Effect.gen(function* () {
        yield* grant(options)
        const vcs = yield* VcsInstructions.Service
        const read = yield* vcs.source({ id: SessionSchema.ID.make("ses_passed_over") })[0]!.read
        return read === Instructions.removed ? "none" : read
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([VcsInstructions.node, ProjectTrust.node, WorkspaceTrust.node, Database.node, Bus.node]),
            named(folder, options),
          ),
        ),
      ),
  },
  {
    name: "the Git provider's info, status, diff and review base (VcsGit)",
    programs: true,
    beyond: true,
    run: (folder, options = {}) =>
      Effect.gen(function* () {
        yield* grant(options)
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
            named(folder, options),
          ),
        ),
      ),
  },
  {
    name: "the ignore check of language server results (Lsp.ignored)",
    programs: false,
    beyond: true,
    run: (folder, options = {}) =>
      Effect.gen(function* () {
        yield* grant(options)
        const lsp = yield* Lsp.Service
        return [...(yield* lsp.ignored([path.join(folder, "hidden.txt")]))]
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Lsp.node, ProjectTrust.node, WorkspaceTrust.node]), named(folder, options)),
        ),
      ),
  },
  {
    name: "the undo snapshot of a step and its comparison (Snapshot)",
    programs: false,
    beyond: true,
    run: (folder, options = {}) =>
      Effect.gen(function* () {
        yield* grant(options)
        const snapshot = yield* Snapshot.Service
        const taken = yield* snapshot.capture()
        // A comparison opens the repository too; with no snapshot taken here, it compares one that a name stands for.
        const tree = taken ?? Snapshot.ID.make("0000000000000000000000000000000000000000")
        return { taken, compared: yield* Effect.exit(snapshot.files({ from: tree, to: tree })) }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Snapshot.node, ProjectTrust.node, WorkspaceTrust.node]), named(folder, options)),
        ),
      ),
  },
  {
    name: "the worktree list of the git strategy (WorktreeGit.list)",
    programs: false,
    beyond: true,
    run: (folder, options = {}) => worktrees(folder, options, (strategy) => strategy.list(abs(folder))),
  },
  {
    name: "a new worktree of the git strategy (WorktreeGit.create)",
    programs: false,
    beyond: true,
    run: (folder, options = {}) =>
      worktrees(folder, options, (strategy) =>
        strategy.create({
          sourceDirectory: abs(folder),
          directory: abs(path.join(path.dirname(folder), `made-${path.basename(folder)}`)),
        }),
      ),
  },
  {
    // InstructionNotes.keepOut calls it with the folder the decision covers.
    name: "Git.repo.discover",
    programs: false,
    beyond: false,
    run: (folder) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        return (yield* git.repo.discover(abs(folder)))?.worktree
      }).pipe(Effect.provide(AppNodeBuilder.build(Git.node, []))),
  },
  {
    name: "Project.resolve",
    programs: false,
    beyond: true,
    run: (folder, options = {}) =>
      Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        for (const item of [folder, ...(options.also ?? [])]) yield* trust.grant(item, { persist: false, via: "test" })
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

// Classes 1 and 3: a `.git` in `sub` that git does take for a repository, and that leads it into the untrusted repository
// above (`pointers`). The ceiling cannot help, because git follows the pointer and does not walk up. Resolving `sub` names
// `sub` (it is its own project until it is trusted, and keeps that name), so the person is asked about `sub`, and once
// they trust it each surface asks git which work tree, git directory and common directory it uses there, finds a
// directory of the repository above among them, and runs nothing more (`ProjectTrust.git`, `GitAccess`). Every row first
// checks with a plain git that git does use a directory of the repository above. Mutation: `GitAccess.check` answering
// with git's repository whatever folders it is in fails the outer program rows of the snapshot and the provider, and the
// "starts no other git" assertion of every surface but `discover` (which only asks).
// Controls: once the repository above is trusted as well, each surface goes on and the snapshot and the provider run its
// program; and a linked worktree that its repository lists goes on once its main checkout is trusted.
describe("git that Orbit starts for a trusted folder does not follow its .git into an untrusted repository", () => {
  // The common directory that a plain git in `folder` uses, as a real path.
  const common = (folder: string) =>
    Effect.sync(() => {
      const child = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: folder,
        stdout: "pipe",
        stderr: "ignore",
      })
      return realpathSync.native(child.stdout.toString().trim())
    })
  // The git processes that did more than ask which repository git uses.
  const further = (lines: readonly string[]) => lines.filter((line) => !/\srev-parse\s/.test(` ${line} `))
  // Runs `effect` and keeps the folder that each refusal it logged names.
  const refusals = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const folders: unknown[] = []
      const logger = Logger.make((entry) => {
        const [message, fields] = Array.isArray(entry.message) ? entry.message : [entry.message]
        if (message === "git not used for this folder") folders.push((fields as { folder?: unknown } | undefined)?.folder)
      })
      const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])))
      return { value, folders }
    })

  for (const surface of surfaces)
    for (const [name, fill] of pointers) {
      it.live(
        `${surface.name}, for ${name}`,
        () =>
          Effect.gen(function* () {
            const found = yield* outer(fill)
            const used = yield* common(found.sub)
            expect(FSUtil.contains(path.join(found.root, ".git"), used)).toBe(true)

            const result = yield* traced(refusals(surface.run(found.sub)))

            expect(yield* found.ran()).toEqual([])
            expect(further(result.git)).toEqual([])
            // One line, however often the surface asked, names the folder to trust; `discover` asks nothing.
            expect(result.value.folders).toEqual(surface.beyond ? [found.root] : [])
            expect((yield* (yield* WorkspaceTrust.Service).status(found.root)).trusted).toBe(false)
          }).pipe(Effect.provide(AppNodeBuilder.build(WorkspaceTrust.node, untrustedProjectNodes))),
        SLOW,
      )

      it.live(
        `${surface.name}, for ${name}: goes on once the repository above is trusted too (control)`,
        () =>
          Effect.gen(function* () {
            const found = yield* outer(fill)

            const result = yield* traced(surface.run(found.sub, { also: [found.root] }))

            if (surface.beyond) expect(further(result.git).length).toBeGreaterThan(0)
            if (surface.programs) expect((yield* found.ran()).length).toBeGreaterThan(0)
          }),
        SLOW,
      )
    }

  for (const surface of surfaces)
    it.live(
      `${surface.name}: a linked worktree that its repository lists goes on once its main checkout is trusted (control)`,
      () =>
        Effect.gen(function* () {
          const found = yield* outer()
          const worktree = path.join(found.folder, "linked")
          yield* Effect.promise(async () => {
            await git(found.root, "worktree", "add", "-q", "--detach", worktree)
            // A changed file that the attributes give the planted filter and text conversion.
            await Bun.write(path.join(worktree, ".gitattributes"), "*.txt filter=marker diff=marker\n")
            await Bun.write(path.join(worktree, "a.txt"), "three\n")
          })
          const linked = realpathSync.native(worktree)
          const before = (yield* found.ran()).length

          const result = yield* traced(surface.run(linked, { also: [found.root], canonical: found.root }))

          if (surface.beyond) expect(further(result.git).length).toBeGreaterThan(0)
          if (surface.programs) expect((yield* found.ran()).length).toBeGreaterThan(before)
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
