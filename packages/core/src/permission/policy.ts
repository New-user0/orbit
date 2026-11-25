export * as PermissionPolicy from "./policy.js"

import { Context, Effect, Layer, type Scope } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"

/**
 * The configuration policies' answer for the checks that run no plugin hook (`Permission.denied` and
 * `Permission.allowed`: the editor field, the file-change reminder, the shell guard's probes). The configuration policy
 * plugin installs its own decision here, the same one its `permission.evaluate` hook applies, so a policy refuses a
 * file there as it refuses the tool, and no other plugin code runs on those paths. It only refuses: nothing here
 * allows what the rules do not (classes 3 and 8).
 */

/** What a check asks about, in the shape the `permission.evaluate` hook is shown it. */
export interface Subject {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly aliases?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly leads?: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>>
}

/** The message of the statement that refuses `subject`, or undefined when none does. */
export type Refusal = (subject: Subject) => string | undefined

export interface Interface {
  /** Installs the policies' decision for as long as the scope is open. */
  readonly install: (refusal: Refusal) => Effect.Effect<void, never, Scope.Scope>
  readonly refuses: Refusal
}

export class Service extends Context.Service<Service, Interface>()("@orbit/PermissionPolicy") {}

const layer = Layer.sync(Service, () => {
  const state: { refusal?: Refusal } = {}
  return Service.of({
    install: (refusal) =>
      Effect.acquireRelease(
        Effect.sync(() => void (state.refusal = refusal)),
        () => Effect.sync(() => void (state.refusal === refusal && delete state.refusal)),
      ),
    refuses: (subject) => state.refusal?.(subject),
  })
})

export const node = makeLocationNode({ service: Service, layer, deps: [] })
