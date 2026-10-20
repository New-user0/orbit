import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Git } from "@orbit/core/git"
import { AbsolutePath } from "@orbit/core/schema"
import { traced } from "./fixture/git-trace"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// The read-only queries that the git snapshot of a session is made from.
const it = testEffect(LayerNode.compile(Git.node))

const repo = Effect.gen(function* () {
  const root = AbsolutePath.make((yield* tmpdirScoped("orbit-git-snapshot-")).path)
  yield* Effect.promise(async () => {
    await $`git init -b main`.cwd(root).quiet()
    await $`git config commit.gpgsign false`.cwd(root).quiet()
    await $`git config user.email test@orbit.test`.cwd(root).quiet()
  })
  return root
})

const commits = (root: string, subjects: readonly string[]) =>
  Effect.promise(async () => {
    for (const subject of subjects) await $`git -c user.name=Committer commit --allow-empty -m ${subject}`.cwd(root).quiet()
  })

describe("the queries of the git snapshot", () => {
  it.live("lists the last 5 commits, newest first, as git prints them one per line", () =>
    Effect.gen(function* () {
      const root = yield* repo
      yield* commits(root, ["one", "two", "three", "four", "five", "six", "seven"])
      const git = yield* Git.Service

      const recent = yield* git.history.recent(root, 5)

      expect(recent.map((line) => line.replace(/^[0-9a-f]+ /, ""))).toEqual(["seven", "six", "five", "four", "three"])
      expect(recent[0]).toMatch(/^[0-9a-f]{7,} seven$/)
    }),
  )

  it.live("lists no commits for a repository without any, and does not fail", () =>
    Effect.gen(function* () {
      const root = yield* repo
      const git = yield* Git.Service

      expect(yield* git.history.recent(root, 5)).toEqual([])
    }),
  )

  it.live("reads user.name from the repository, and returns undefined when none is set anywhere", () =>
    Effect.gen(function* () {
      const root = yield* repo
      const git = yield* Git.Service
      expect(yield* git.history.userName(root)).toBeUndefined()

      yield* Effect.promise(() => $`git config user.name ${"Ada Lovelace"}`.cwd(root).quiet())
      expect(yield* git.history.userName(root)).toBe("Ada Lovelace")
    }),
  )

  it.live("puts --no-optional-locks before status, and runs it in the folder it is given, up to the folder above it", () =>
    Effect.gen(function* () {
      const root = yield* repo
      yield* commits(root, ["root"])
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(root, "sub"))
        await Bun.write(path.join(root, "top.txt"), "x\n")
        await Bun.write(path.join(root, "sub", "inner.txt"), "y\n")
      })
      const git = yield* Git.Service

      const run = yield* traced(git.status.short(AbsolutePath.make(path.join(root, "sub")), 64 * 1024, root))

      // A change at the root, seen from a subfolder, carries the `../` that git prints, and the untracked folder itself collapses to `./`.
      expect(run.value.split("\n").toSorted()).toEqual(["?? ../top.txt", "?? ./"])
      expect(run.git.filter((line) => line.includes("status"))).toHaveLength(1)
      expect(run.git.find((line) => line.includes("status"))).toMatch(
        /--no-optional-locks status --ignore-submodules=all --short/,
      )
    }),
  )

  it.live("keeps the leading space of the first entry", () =>
    Effect.gen(function* () {
      const root = yield* repo
      yield* Effect.promise(async () => {
        await Bun.write(path.join(root, "a.txt"), "one\n")
        await $`git add a.txt`.cwd(root).quiet()
        await $`git -c user.name=Committer commit -m one`.cwd(root).quiet()
        await Bun.write(path.join(root, "a.txt"), "two\n")
      })
      const git = yield* Git.Service

      expect(yield* git.status.short(root, 64 * 1024)).toBe(" M a.txt")
    }),
  )

  it.live("cuts the status to whole lines at the byte limit", () =>
    Effect.gen(function* () {
      const root = yield* repo
      yield* Effect.promise(async () => {
        for (const name of ["aaaa", "bbbb", "cccc", "dddd"]) await Bun.write(path.join(root, `${name}.txt`), "x\n")
      })
      const git = yield* Git.Service

      // Each line is `?? aaaa.txt` and a line end: 12 or 13 bytes. 30 bytes hold two whole lines and part of a third.
      expect(yield* git.status.short(root, 30)).toBe("?? aaaa.txt\n?? bbbb.txt")
    }),
  )

  it.live("fails visibly in a folder that is not a repository, so that it cannot pass for a clean tree", () =>
    Effect.gen(function* () {
      const root = AbsolutePath.make((yield* tmpdirScoped("orbit-git-snapshot-none-")).path)
      const git = yield* Git.Service

      const error = yield* git.status.short(root, 64 * 1024).pipe(Effect.flip)

      expect(error.operation).toBe("status")
    }),
  )

  describe("the main branch", () => {
    // A repository on `trunk`, with the remote-tracking refs given, and the symbolic head of origin when `head` is given.
    const main = (remoteRefs: readonly string[], head?: string) =>
      Effect.gen(function* () {
        const root = yield* repo
        yield* commits(root, ["root"])
        yield* Effect.promise(async () => {
          await $`git branch -M trunk`.cwd(root).quiet()
          await $`git remote add origin https://example.test/orbit/clone.git`.cwd(root).quiet()
          for (const name of remoteRefs) await $`git update-ref refs/remotes/origin/${name} HEAD`.cwd(root).quiet()
          if (head) await $`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${head}`.cwd(root).quiet()
        })
        const git = yield* Git.Service
        return yield* git.history.mainBranch(root)
      })

    it.live("is the branch that the head of origin points at", () =>
      Effect.gen(function* () {
        expect(yield* main(["main", "develop"], "develop")).toBe("develop")
      }),
    )

    it.live("is main when origin has a main and no head", () =>
      Effect.gen(function* () {
        expect(yield* main(["master", "main"])).toBe("main")
      }),
    )

    it.live("is master when origin has only a master", () =>
      Effect.gen(function* () {
        expect(yield* main(["master"])).toBe("master")
      }),
    )

    it.live("is main for a repository without a remote, whatever its only branch is called", () =>
      Effect.gen(function* () {
        const root = yield* repo
        yield* commits(root, ["root"])
        yield* Effect.promise(() => $`git branch -M master`.cwd(root).quiet())
        const git = yield* Git.Service

        expect(yield* git.history.mainBranch(root)).toBe("main")
        expect(yield* git.history.current(root)).toBe("master")
      }),
    )
  })
})
