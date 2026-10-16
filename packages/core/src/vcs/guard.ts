import { Effect } from "effect"
import type { Adapter } from "../vcs.js"

/**
 * An adapter that answers as a folder with no history and no changes while `trusted` says no, and starts no command. Git and
 * Mercurial apply the config of the folder they run in, and a clone chooses that file, so the terminal UI asking for the
 * branch of the folder it opens is enough to run a program that the clone names (class 1). The answer is asked at each call,
 * so that a grant or a revoke takes effect on the next one.
 */
export function guard(adapter: Adapter, trusted: () => Effect.Effect<boolean>) {
  const when = <A, E>(run: () => Effect.Effect<A, E>, otherwise: A) =>
    trusted().pipe(Effect.flatMap((yes) => (yes ? run() : Effect.succeed(otherwise))))
  return {
    info: () => when(() => adapter.info(), { branch: {} }),
    base: () => when(() => adapter.base?.() ?? Effect.succeed(null), null),
    branches: (options) => when(() => adapter.branches(options), []),
    status: () => when(() => adapter.status(), []),
    diff: (mode, options) => when(() => adapter.diff(mode, options), []),
  } satisfies Adapter
}
