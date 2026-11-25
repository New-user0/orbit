import { expect } from "bun:test"
import { Effect } from "effect"
import { advance } from "./clock"
import { it } from "./effect"

// `advance` drives the TestClock while real work (an import, a file write, a subprocess) finishes between its steps.
// It gave that real work 100 one-millisecond macrotask ticks and then failed with "condition never became true after
// 100 advances", so a plugin import that took longer on a loaded machine failed the PluginSupervisor reload rows
// (docs/known-failures.md) with a wrong result rather than a timeout. The real work has no promise of how long it takes;
// the bound on waiting for it is the test's own time limit, which reports a timeout as a timeout.
it.effect(
  "advance waits for real work that outlasts a hundred macrotask ticks",
  () =>
    Effect.gen(function* () {
      let done = false
      // Real work that takes far longer than 100 macrotask ticks on any machine.
      const timer = setTimeout(() => (done = true), 3_000)
      yield* advance(() => done).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))
      expect(done).toBe(true)
    }),
  15_000,
)

it.effect("advance returns at once when the condition already holds: the control for the row above", () =>
  Effect.gen(function* () {
    yield* advance(() => true)
  }),
)
