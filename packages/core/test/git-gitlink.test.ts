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
import { plain } from "./fixture/git-keys"
import { opened, outer } from "./fixture/git-passed-over"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

// Classes 1 and 3 (M4 verification round 9): a folder `sub` that a person trusted is a repository of its own, inside a
// repository `clone` that nobody trusted. The index of `sub` holds a gitlink `inner`, and `inner/.git` names the git
// directory of `clone`. Orbit asks git which repository it uses in `sub` (`GitAccess`) and finds `sub`'s own, so its git
// goes on there. `git status`, `git diff` against the work tree and `git checkout` of a branch then start another git in
// `inner` to ask whether that folder changed, and that git takes the config of `clone`: its file system monitor and its
// clean filter run. Every git that Orbit starts leaves submodules alone (`GitSubmodules.skip`).
//
// The matrix: the surfaces that start git in a trusted folder (the git snapshot, the Git provider, `Lsp.ignored`, the undo
// snapshot, the worktree strategy's list and create, and the branch checkout of the repository cache) x two gitlinks:
// one that names the commit `clone` has checked out, so that even `git diff` looks inside it, and the same with a
// `.gitmodules` that asks git to look inside it whatever the config says (`ignore = none`). The oracles are git's event
// trace, which names the repository each git process works in, and the program of `clone`, which records its runs. Git
// still reads the `HEAD` of the gitlink's repository inside the process that compares it; that starts no program, and the
// trace numbers that repository apart from the process's own. Every row first runs a plain `git status` in `sub`, which
// does run the program, and checks that the surface did start git in `sub`. Controls: in `clone`, once it is trusted
// itself, the surfaces that run its programs do.
//
// Mutations (recorded in the commit): `GitSubmodules.skip` returning its arguments fails every row of the git snapshot, the
// provider, the undo snapshot and the checkout; leaving out only `--ignore-submodules=all` fails the `ignore = none`
// rows of the git snapshot and the provider and both rows of the undo snapshot (plumbing reads no config); leaving out only
// `-c diff.ignoreSubmodules=all` fails the row of the checkout.

const it = testEffect(Layer.empty)
const SLOW = 120_000
const abs = AbsolutePath.make

const output = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
    .stdout.toString()
    .trim()

/**
 * Makes `sub` a repository whose index holds a gitlink `inner` naming the commit that `clone` has checked out, with
 * `inner/.git` naming the git directory of `clone`, and attributes in `clone` that give its clean filter and text
 * conversion every `.txt` file. `inner/a.txt` differs from the `a.txt` of `clone`'s index at the same size, so git has to
 * run the filter to compare them. With `none`, `.gitmodules` asks git to look inside the gitlink.
 */
const nested = (found: { readonly root: string; readonly sub: string }, none: boolean) =>
  Effect.promise(async () => {
    const head = output(found.root, "rev-parse", "HEAD")
    await Bun.write(path.join(found.root, ".git", "info", "attributes"), "*.txt filter=marker diff=marker\n")
    await git(found.sub, "init", "-b", "main")
    await git(found.sub, "config", "user.email", "test@orbit.test")
    await git(found.sub, "config", "user.name", "Test")
    await git(found.sub, "config", "commit.gpgsign", "false")
    await Bun.write(path.join(found.sub, "x.txt"), "x\n")
    await git(found.sub, "add", "x.txt")
    await git(found.sub, "update-index", "--add", "--cacheinfo", `160000,${head},inner`)
    if (none) {
      await Bun.write(
        path.join(found.sub, ".gitmodules"),
        '[submodule "inner"]\n\tpath = inner\n\turl = ./inner\n\tignore = none\n',
      )
      await git(found.sub, "add", ".gitmodules")
    }
    await git(found.sub, "commit", "-m", "sub")
    await fs.mkdir(path.join(found.sub, "inner"), { recursive: true })
    await fs.writeFile(path.join(found.sub, "inner", ".git"), "gitdir: ../../.git\n")
    await Bun.write(path.join(found.sub, "inner", "a.txt"), "six\n")
  })

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

const grant = Effect.gen(function* () {
  const trust = yield* ProjectTrust.Service
  yield* trust.grant({ persist: false, via: "test" })
})

const worktrees = <A, E>(
  folder: string,
  act: (strategy: Effect.Success<typeof WorktreeGit.make>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    yield* trust.grant(folder, { persist: false, via: "test" })
    return yield* Effect.exit(act(yield* WorktreeGit.make))
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([WorkspaceTrust.node, Git.node, FSUtil.node]), untrustedProjectNodes),
    ),
  )

interface Surface {
  readonly name: string
  /** Whether the surface runs a program of the repository it works in, which the control in `clone` shows. */
  readonly programs: boolean
  /**
   * False for a command that takes no `--ignore-submodules` and is kept out of a gitlink by the setting alone, which an
   * `ignore` in `.gitmodules` overrules: it has no `ignore = none` row.
   */
  readonly modules?: false
  /**
   * Runs the surface for a Location whose project is `folder`, once the person has trusted that folder. A surface that
   * shows what changed in the folder answers with those lines in `changed`.
   */
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
        const read = yield* vcs.source({ id: SessionSchema.ID.make("ses_gitlink") })[0]!.read
        return { changed: read === Instructions.removed ? [] : (read as VcsInstructions.Snapshot).status.split("\n") }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([VcsInstructions.node, ProjectTrust.node, WorkspaceTrust.node, Database.node, Bus.node]),
            named(folder),
          ),
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
        yield* VcsGitPlugin.Plugin.effect({
          ...context,
          vcs: { ...context.vcs, transform: vcs.transform, reload: vcs.reload },
        })
        yield* vcs.info()
        yield* Effect.exit(vcs.base())
        const status = yield* vcs.status()
        const working = yield* vcs.diff("working")
        return { changed: [...status, ...working].map((item) => item.file) }
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
    programs: false,
    run: (folder) =>
      Effect.gen(function* () {
        yield* grant
        const lsp = yield* Lsp.Service
        return [...(yield* lsp.ignored([path.join(folder, "x.txt"), path.join(folder, "inner", "a.txt")]))]
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Lsp.node, ProjectTrust.node, WorkspaceTrust.node]), named(folder)),
        ),
      ),
  },
  {
    name: "the undo snapshot of a step and its comparison (Snapshot)",
    programs: false,
    run: (folder) =>
      Effect.gen(function* () {
        yield* grant
        const snapshot = yield* Snapshot.Service
        const first = yield* snapshot.capture()
        yield* Effect.promise(() => Bun.write(path.join(folder, "x.txt"), "y\n"))
        const second = yield* snapshot.capture()
        if (!first || !second) return { first, second }
        return { first, second, files: yield* snapshot.files({ from: first, to: second }) }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Snapshot.node, ProjectTrust.node, WorkspaceTrust.node]), named(folder)),
        ),
      ),
  },
  {
    name: "the worktree list of the git strategy (WorktreeGit.list)",
    programs: false,
    run: (folder) => worktrees(folder, (strategy) => strategy.list(abs(folder))),
  },
  {
    name: "a new worktree of the git strategy (WorktreeGit.create)",
    programs: false,
    run: (folder) =>
      worktrees(folder, (strategy) =>
        strategy.create({
          sourceDirectory: abs(folder),
          directory: abs(path.join(path.dirname(folder), `made-${path.basename(folder)}`)),
        }),
      ),
  },
  {
    // The repository cache checks out the branch it keeps, and `git checkout <branch>` reports what changed in the work
    // tree. The cache checks out only clones that Orbit made, where no gitlink has a `.git`, so its `.gitmodules` cannot
    // lead it into a repository; this runs it in `sub` to show that the setting keeps it out of a gitlink.
    name: "the branch checkout of the repository cache (Git.sync.checkoutRemoteBranch)",
    programs: true,
    modules: false,
    run: (folder) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const repository = yield* git.repo.discover(abs(folder))
        if (!repository) return "no repository"
        return yield* Effect.exit(git.sync.checkoutRemoteBranch(repository, { branch: "main", reset: false }))
      }).pipe(Effect.provide(AppNodeBuilder.build(Git.node, []))),
  },
]

const gitlinks = [
  ["a gitlink that names the commit the repository above has checked out", false],
  ["the same gitlink with a .gitmodules that asks git to look inside it (ignore = none)", true],
] as const

/**
 * Runs `effect` with git told to write its event trace, and returns the result with the commands of the git processes
 * that started and the work tree each of them works in. Git numbers the repositories one process opens: its own is 1, and
 * a submodule's whose `HEAD` it reads to compare a gitlink, without starting git there, comes later and is not counted.
 */
const processes = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const file = path.join((yield* tmpdirScoped("orbit-git-events-")).path, "events.json")
    const before = process.env.GIT_TRACE2_EVENT
    const value = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        process.env.GIT_TRACE2_EVENT = file
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          if (before === undefined) delete process.env.GIT_TRACE2_EVENT
          else process.env.GIT_TRACE2_EVENT = before
        }),
    )
    const text = (yield* Effect.promise(() => Bun.file(file).exists()))
      ? yield* Effect.promise(() => Bun.file(file).text())
      : ""
    const events = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; repo?: number; worktree?: string; argv?: string[] })
    return {
      value,
      started: events.flatMap((event) => (event.event === "start" ? [(event.argv ?? []).join(" ")] : [])),
      worktrees: events.flatMap((event) =>
        event.event === "def_repo" && event.repo === 1 && event.worktree ? [path.resolve(event.worktree)] : [],
      ),
    }
  })

// The git processes that did more than ask which repository git uses.
const further = (lines: readonly string[]) => lines.filter((line) => !/\srev-parse\s/.test(` ${line} `))

describe("git that Orbit starts in a trusted repository leaves a gitlink that names an untrusted repository alone", () => {
  for (const surface of surfaces)
    for (const [name, none] of gitlinks.filter(([, none]) => !none || surface.modules !== false))
      it.live(
        `${surface.name}, for ${name}`,
        () =>
          Effect.gen(function* () {
            const found = yield* outer()
            yield* nested(found, none)
            // The gitlink is live: a plain `git status` in `sub` runs the program of the repository above.
            yield* Effect.promise(() => plain(found.sub, ["status"]))
            const before = (yield* found.ran()).length
            expect(before).toBeGreaterThan(0)

            const result = yield* processes(surface.run(found.sub))

            expect(further(result.started).length).toBeGreaterThan(0)
            // What the surface shows as changed lists the untracked file of `sub`, and not the gitlink.
            const changed = (result.value as { readonly changed?: readonly string[] }).changed
            if (changed)
              expect([
                changed.some((line) => line.includes("hidden.txt")),
                changed.some((line) => line.includes("inner")),
              ]).toEqual([true, false])
            expect(opened(result.worktrees, found.sub)).toBe(true)
            expect(opened(result.worktrees, path.join(found.sub, "inner"))).toBe(false)
            expect(opened(result.worktrees, found.root)).toBe(false)
            expect((yield* found.ran()).length).toBe(before)
            expect((yield* (yield* WorkspaceTrust.Service).status(found.root)).trusted).toBe(false)
          }).pipe(Effect.provide(AppNodeBuilder.build(WorkspaceTrust.node, untrustedProjectNodes))),
        SLOW,
      )

  for (const surface of surfaces.filter((item) => item.programs))
    it.live(
      `${surface.name}: runs the program of the repository above in that repository once it is trusted (control)`,
      () =>
        Effect.gen(function* () {
          const found = yield* outer()

          const result = yield* processes(surface.run(found.root))

          expect(opened(result.worktrees, found.root)).toBe(true)
          expect((yield* found.ran()).length).toBeGreaterThan(0)
        }),
      SLOW,
    )
})
