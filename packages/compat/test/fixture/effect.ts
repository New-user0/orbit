import { test } from "bun:test"
import { Effect, type Scope } from "effect"

/** Runs a test body against the real filesystem, closing everything it acquires when it ends. */
export const live = <A, E>(name: string, body: () => Effect.Effect<A, E, Scope.Scope>) =>
  test(name, () => Effect.runPromise(Effect.scoped(Effect.suspend(body))))
