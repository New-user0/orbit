export * as ManagedPolicy from "./managed-policy.js"

import { ConfigPolicy } from "@orbit/schema/config/policy"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@orbit/util/effect/app-node"

/** Policy statements supplied by a managed configuration source for the authenticated user. */
export interface State {
  readonly statements: ReadonlyArray<ConfigPolicy.Info>
  /** Organization name for denial messages, when the connection knows it. */
  readonly organization?: string
}

export interface Interface {
  /** Synchronous so catalog transforms can consult the statements while they run. */
  readonly current: () => State
  /** Replaces the whole state; statements never merge across connections. */
  readonly set: (state: State) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ManagedPolicy") {}

const layer = Layer.sync(Service, () => {
  const state: { current: State } = { current: { statements: [] } }
  return Service.of({
    current: () => state.current,
    set: (next) =>
      Effect.sync(() => {
        state.current = next
      }),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
