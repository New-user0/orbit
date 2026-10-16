import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Hash } from "@orbit/util/hash"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { git, repository } from "./fixture/git"
import { type Found, folders, forgeries } from "./fixture/git-forged"
import { keys, live, planted } from "./fixture/git-keys"
import { traced } from "./fixture/git-trace"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it, testEffect } from "./lib/effect"

// Class 1 (register FU-M1-022): `Project.resolve` ran `git rev-parse`, `git remote get-url`, `git rev-list` and
// `git worktree list` in any folder that holds `.git`, when a client opened it and before anyone was asked, and git applies
// the folder's own `.git/config` to each. A clone can name programs there (`core.fsmonitor`, hooks, filter and text
// conversion drivers, `gpg.program` ...), so a folder that is not trusted is read from its files and no git starts in it.
//
// The oracle is git's own trace of every process it starts, together with a program that the folder's config names and that
// records its runs. Every row has a control: the plain git command that makes git run the program shows that the key is
// live in a repository like the folder's, and a trusted folder shows that `Project.resolve` does start git where it may.
// The core tests trust every folder unless a graph says otherwise, which hides the attack, so `untrusted` says it.

const graph = (implicit: boolean) =>
  AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, WorkspaceTrust.node]), [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
    Global.node.replace(tempGlobalLayer),
  ])
const untrusted = testEffect(graph(false))
const trusted = testEffect(graph(true))

const abs = AbsolutePath.make
const SLOW = 90_000

const remoteID = (name: string) => Project.ID.make(Hash.fast(`git-remote:${name}`))
const pathID = (folder: string) => Project.ID.make(Hash.fast(`directory:${folder}`))
const real = (file: string) => Effect.promise(() => fs.realpath(file)).pipe(Effect.map(abs))

/** Resolves a folder in a graph of its own that trusts every folder, or none. */
const resolveIn = (implicit: boolean, folder: string) =>
  Project.Service.use((project) => project.resolve(abs(folder))).pipe(Effect.provide(graph(implicit)))

describe("Project.resolve in a git folder that is not trusted, whatever its config names", () => {
  for (const key of keys)
    untrusted.live(
      `starts no git and runs no program for ${key.name}`,
      () =>
        Effect.gen(function* () {
          // The control: the key is live, so no marker below means that nothing ran it.
          if (key.trigger) expect(yield* live(key)).not.toEqual([])
          const found = yield* planted(key)
          const project = yield* Project.Service

          const { value, git } = yield* traced(project.resolve(abs(found.root)))

          expect(git).toEqual([])
          expect(yield* found.ran()).toEqual([])
          expect(value.vcs).toEqual({ type: "git", store: abs(path.join(yield* real(found.root), ".git")) })
          expect(value.directory).toBe(yield* real(found.root))
          // The remote is in the config file: a clone of the same remote is the same project, and never `global`, whose saved
          // answers every folder would share.
          expect(value.id).toBe(remoteID("example.test/orbit/clone"))
        }),
      SLOW,
    )

  for (const key of keys)
    trusted.live(
      `starts git in a trusted folder that sets ${key.name} (control)`,
      () =>
        Effect.gen(function* () {
          const found = yield* planted(key)
          const project = yield* Project.Service

          const { value, git } = yield* traced(project.resolve(abs(found.root)))

          expect(git.some((command) => command.includes("rev-parse"))).toBe(true)
          expect(git.some((command) => command.includes("remote"))).toBe(true)
          expect(value.id).toBe(remoteID("example.test/orbit/clone"))
        }),
      SLOW,
    )

  untrusted.live(
    "starts no git in a folder below the repository, and finds the same project",
    () =>
      Effect.gen(function* () {
        const found = yield* planted(keys[0]!)
        yield* Effect.promise(() => fs.mkdir(path.join(found.root, "a", "b"), { recursive: true }))
        const project = yield* Project.Service

        const { value, git } = yield* traced(project.resolve(abs(path.join(found.root, "a", "b"))))

        expect(git).toEqual([])
        expect(value.directory).toBe(yield* real(found.root))
        expect(value.id).toBe(remoteID("example.test/orbit/clone"))
      }),
    SLOW,
  )

  untrusted.live(
    "gives a repository with no remote its own project, never global, and the same one each time",
    () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        yield* repository(path.join(root, "one"))
        yield* repository(path.join(root, "two"))
        const project = yield* Project.Service

        const { value: first, git } = yield* traced(project.resolve(abs(path.join(root, "one"))))
        const second = yield* project.resolve(abs(path.join(root, "two")))

        expect(git).toEqual([])
        expect(first.id).toBe(pathID(yield* real(path.join(root, "one"))))
        expect(first.id).not.toBe(Project.ID.global)
        expect(second.id).not.toBe(first.id)
        expect((yield* project.resolve(abs(path.join(root, "one")))).id).toBe(first.id)
      }),
    SLOW,
  )
})

// Class 3: a clone ships every file under its `.git`, so it can name a trusted repository there, and the trust decision for a
// linked worktree is its main checkout's. The folder must not take it: nothing but a repository that listed the folder
// (`git worktree add`) counts, and every other layout leaves the folder its own canonical folder, so that git does not start.
describe("Project.resolve gives a folder that names a trusted repository none of its trust", () => {
  const grantVictim = (found: Found) =>
    WorkspaceTrust.Service.use((trust) => trust.grant(found.victim, { persist: false, via: "test" }))

  for (const [name, make] of forgeries)
    untrusted.live(
      `starts no git, and names the folder itself, for ${name}`,
      () =>
        Effect.gen(function* () {
          const found = yield* folders
          yield* Effect.promise(() => make(found))
          yield* grantVictim(found)

          const { value, git } = yield* traced(Project.Service.use((project) => project.resolve(abs(found.crafted))))

          expect(git).toEqual([])
          expect(value.directory).toBe(found.crafted)
          expect(value.canonical).toBe(found.crafted)
          // The victim's remote is not the folder's, and its git directory is not the folder's store.
          expect(value.id).toBe(pathID(found.crafted))
          expect(value.vcs).toEqual({ type: "git", store: abs(path.join(found.crafted, ".git")) })
        }),
      SLOW,
    )

  untrusted.live(
    "gives a linked worktree that git added the decision of its main checkout, which is trusted (control)",
    () =>
      Effect.gen(function* () {
        const found = yield* folders
        yield* grantVictim(found)

        const { value, git } = yield* traced(Project.Service.use((project) => project.resolve(abs(found.linked))))

        expect(git.some((command) => command.includes("rev-parse"))).toBe(true)
        expect(value.canonical).toBe(found.victim)
        expect(value.id).toBe(remoteID("example.test/victim/repo"))
      }),
    SLOW,
  )

  untrusted.live(
    "starts no git for a linked worktree of a main checkout that is not trusted, and still names its main checkout",
    () =>
      Effect.gen(function* () {
        const found = yield* folders

        const { value, git } = yield* traced(Project.Service.use((project) => project.resolve(abs(found.linked))))

        expect(git).toEqual([])
        expect(value.canonical).toBe(found.victim)
        expect(value.directory).toBe(found.linked)
        expect(value.id).toBe(remoteID("example.test/victim/repo"))
      }),
    SLOW,
  )

  untrusted.live(
    "starts git for the same folder once it is trusted, with no restart",
    () =>
      Effect.gen(function* () {
        const found = yield* planted(keys[0]!)
        const project = yield* Project.Service

        const before = yield* traced(project.resolve(abs(found.root)))
        yield* WorkspaceTrust.Service.use((trust) => trust.grant(found.root, { persist: false, via: "test" }))
        const after = yield* traced(project.resolve(abs(found.root)))

        expect(before.git).toEqual([])
        expect(after.git.some((command) => command.includes("rev-parse"))).toBe(true)
        expect(after.value.id).toBe(before.value.id)
      }),
    SLOW,
  )
})

describe("Project.resolve names a folder that is not trusted as it names a trusted one", () => {
  // Each shape is resolved twice, in a graph that trusts nothing and in one that trusts everything. The answers differ only
  // in the project ID of a repository with no remote, which git names by its first commit.
  const shapes = {
    "a repository with an scp remote": (root: string) =>
      Effect.gen(function* () {
        yield* repository(path.join(root, "repo"), "git@example.test:Owner/Repo.git")
        return { start: "repo", id: remoteID("example.test/Owner/Repo") }
      }),
    "a repository with an https remote": (root: string) =>
      Effect.gen(function* () {
        yield* repository(path.join(root, "repo"), "https://User@Example.test/Owner/Repo.git")
        return { start: "repo", id: remoteID("example.test/Owner/Repo") }
      }),
    "a linked worktree of a repository with a remote": (root: string) =>
      Effect.gen(function* () {
        yield* repository(path.join(root, "main"), "git@example.test:Owner/Repo.git")
        yield* Effect.promise(() => git(path.join(root, "main"), "worktree", "add", "--detach", path.join(root, "linked")))
        return { start: "linked", id: remoteID("example.test/Owner/Repo") }
      }),
    "a repository with a file remote": (root: string) =>
      Effect.gen(function* () {
        yield* repository(path.join(root, "repo"), "file:///elsewhere/repo.git")
        return { start: "repo", id: undefined }
      }),
    "a repository with no remote": (root: string) =>
      Effect.gen(function* () {
        yield* repository(path.join(root, "repo"))
        return { start: "repo", id: undefined }
      }),
    "a linked worktree of a repository with no remote": (root: string) =>
      Effect.gen(function* () {
        yield* repository(path.join(root, "main"))
        yield* Effect.promise(() => git(path.join(root, "main"), "worktree", "add", "--detach", path.join(root, "linked")))
        return { start: "linked", id: undefined }
      }),
  }

  for (const [name, make] of Object.entries(shapes))
    it.live(
      `${name}: the same folder, canonical folder and git directory`,
      () =>
        Effect.gen(function* () {
          const root = (yield* tmpdirScoped()).path
          const shape = yield* make(root)
          const start = path.join(root, shape.start)

          const here = yield* resolveIn(false, start)
          const there = yield* resolveIn(true, start)

          expect(here.directory).toBe(there.directory)
          expect(here.canonical).toBe(there.canonical)
          expect(here.vcs).toEqual(there.vcs)
          if (shape.id) {
            expect(here.id).toBe(shape.id)
            expect(there.id).toBe(shape.id)
            return
          }
          // Git names a repository with no remote by its first commit, which is not read from the files, so the folder is
          // named by its path until it is trusted.
          expect(here.id).toBe(pathID(here.directory))
          expect(there.id).not.toBe(here.id)
        }),
      SLOW,
    )
})
