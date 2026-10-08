import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@orbit/core/session"
import { SessionTurnEnd } from "@orbit/core/session/turn-end"
import type { SessionTurn } from "@orbit/core/session/turn"

const sessionID = Session.ID.make("ses_turn_end")
const turn = (count?: number) =>
  ({
    boundary: undefined,
    options: undefined,
    fallback: undefined,
    notices: count === undefined ? {} : { [SessionTurnEnd.NOTICE]: count },
  }) satisfies SessionTurn.Current

const ask = (layer: Layer.Layer<SessionTurnEnd.Service>, current: SessionTurn.Current) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SessionTurnEnd.Service
      return yield* service.run({ sessionID, turn: current })
    }).pipe(Effect.provide(layer)),
  )

const run = (checks: ReadonlyArray<SessionTurnEnd.Check>, current: SessionTurn.Current) =>
  ask(SessionTurnEnd.layerWith(checks), current)

describe("SessionTurnEnd", () => {
  test("returns the first continuation and skips the checks after it", async () => {
    const asked: string[] = []
    const check = (name: string, continues: boolean): SessionTurnEnd.Check => ({
      name,
      run: () =>
        Effect.sync(() => void asked.push(name)).pipe(Effect.as(continues ? { check: name, text: name } : undefined)),
    })

    const result = await run([check("a", false), check("b", true), check("c", true)], turn())

    expect(result).toEqual({ check: "b", text: "b" })
    expect(asked).toEqual(["a", "b"])
  })

  test("lets the turn end when no check continues", async () => {
    expect(await run([{ name: "a", run: () => Effect.succeed(undefined) }], turn())).toBeUndefined()
    expect(await run([], turn())).toBeUndefined()
  })

  test.each([
    [0, true],
    [SessionTurnEnd.MAX_CONTINUATIONS - 1, true],
    [SessionTurnEnd.MAX_CONTINUATIONS, false],
    [SessionTurnEnd.MAX_CONTINUATIONS + 3, false],
  ])("with %d continuations already in the turn, a check is asked: %p", async (count, asked) => {
    let ran = false
    const result = await run(
      [
        {
          name: "a",
          run: () =>
            Effect.sync(() => {
              ran = true
              return { check: "a", text: "go" }
            }),
        },
      ],
      turn(count),
    )

    expect(ran).toBe(asked)
    expect(result !== undefined).toBe(asked)
  })

  test("the default list is empty, so no turn continues until a later task adds a check", async () => {
    expect(await ask(SessionTurnEnd.layer, turn())).toBeUndefined()
  })
})
