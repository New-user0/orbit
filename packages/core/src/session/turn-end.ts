export * as SessionTurnEnd from "./turn-end.js"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { SessionSchema } from "./schema.js"
import type { SessionTurn } from "./turn.js"

/** Turn-end continuations one turn may hold. Every one leaves a `turn-end` notice, so the turn's own history counts them. */
export const MAX_CONTINUATIONS = 8

/** The `metadata.notice` kind of the synthetic message a continuation adds. */
export const NOTICE = "turn-end"

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly turn: SessionTurn.Current
}

/** What a check asks the model to do instead of ending the turn. */
export interface Continuation {
  /** Names the check that continued, so the notice says why the turn went on. */
  readonly check: string
  /** The model-visible notice. */
  readonly text: string
  readonly description?: string
}

/** One check at the end of a turn: a continuation keeps the turn going, and undefined lets it end. */
export interface Check {
  readonly name: string
  readonly run: (input: Input) => Effect.Effect<Continuation | undefined>
}

export interface Interface {
  /**
   * Runs the checks in order and returns the first continuation, so later checks do not run for a turn that already
   * continues. A turn that already holds `MAX_CONTINUATIONS` continuations ends without asking any check.
   */
  readonly run: (input: Input) => Effect.Effect<Continuation | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionTurnEnd") {}

/**
 * The checks, in the order they run. Plan-exit, teammate-idle and the Stop hook plug in here, as later tasks; nothing
 * registers a check at runtime.
 */
const checks: ReadonlyArray<Check> = []

/** Builds the service over an explicit list; tests replace the node with their own. */
export const layerWith = (list: ReadonlyArray<Check>) =>
  Layer.succeed(
    Service,
    Service.of({
      run: Effect.fnUntraced(function* (input) {
        if ((input.turn.notices[NOTICE] ?? 0) >= MAX_CONTINUATIONS) return undefined
        for (const check of list) {
          const continuation = yield* check.run(input)
          if (continuation) return continuation
        }
        return undefined
      }),
    }),
  )

export const layer = layerWith(checks)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
