// Run by effect.test.ts as its own `bun test`, because its first row fails on purpose. The first row passes Bun's time
// limit while its Effect still has a question to record; the second row records its own and reads what was recorded.
import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "./effect"

const recorded: string[] = []

it.live(
  "a row that passes its time limit",
  () =>
    Effect.gen(function* () {
      recorded.length = 0
      yield* Effect.sleep("300 millis")
      recorded.push("late question of the first row")
    }),
  100,
)

it.live("the next row reads only what it recorded", () =>
  Effect.gen(function* () {
    recorded.length = 0
    recorded.push("question of the second row")
    // Long enough for the first row's question to arrive, were its Effect still running.
    yield* Effect.sleep("500 millis")
    expect(recorded).toEqual(["question of the second row"])
  }),
)
