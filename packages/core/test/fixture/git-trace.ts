import path from "path"
import { Effect } from "effect"
import { tmpdirScoped } from "./tmpdir"

/**
 * Runs `effect` with git told to trace every process it starts into a file, and returns the result with what git was asked:
 * one entry per git process, as its program and arguments. Git writes the line when it starts, before it reads a config or
 * looks for a repository, so a command that stops at once (a folder that is not a repository, a config that names a missing
 * program) is counted as much as one that works, and a git that Orbit starts by any route is counted. `[]` means that none
 * was started.
 */
export const traced = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const file = path.join((yield* tmpdirScoped("orbit-git-trace-")).path, "trace.txt")
    const before = process.env.GIT_TRACE2
    const value = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        process.env.GIT_TRACE2 = file
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          if (before === undefined) delete process.env.GIT_TRACE2
          else process.env.GIT_TRACE2 = before
        }),
    )
    const trace = (yield* Effect.promise(() => Bun.file(file).exists())) ? yield* Effect.promise(() => Bun.file(file).text()) : ""
    return {
      value,
      git: [...trace.matchAll(/\sstart (.*)$/gm)].map((line) => line[1]!.trim()),
      // The work tree of each repository that a git process opened, which git writes once it has found one: a process
      // that found none writes no such line. The event is the third field of a line, so a command named `worktree` in a
      // `start` line is not taken for one.
      worktrees: [...trace.matchAll(/^\S+\s+\S+\s+worktree (.*)$/gm)].map((line) => path.resolve(line[1]!.trim())),
    }
  })
