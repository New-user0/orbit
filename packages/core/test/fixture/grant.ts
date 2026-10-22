import { realpath } from "fs/promises"
import { Effect } from "effect"
import { Config } from "@orbit/core/config"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"

/**
 * Trusts a folder the way the server does: with the executable config the config last read for it, which is what the
 * person was shown. A grant straight from the store records nothing, so every source of the folder would read as
 * changed. Nothing of a folder that is not trusted is read, so for one the config is read again after the grant and the
 * grant records what it finds then, as `ProjectTrust.grant` does.
 */
export const grantWithRecords = (folder: string, input: { readonly persist: boolean; readonly via: string }) =>
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    const config = yield* Config.Service
    const wanted = WorkspaceTrust.key(yield* Effect.promise(() => realpath(folder)))
    const observed = Effect.gen(function* () {
      return yield* Effect.filter(yield* config.fingerprints(), (item) =>
        Effect.promise(() => realpath(item.root)).pipe(Effect.map((real) => WorkspaceTrust.key(real) === wanted)),
      )
    })
    const fresh = !(yield* trust.status(folder)).trusted
    const granted = yield* trust.grant(folder, { ...input, observations: yield* observed })
    const reload = config.reload
    if (!fresh || reload === undefined) return granted
    yield* reload()
    const recorded = yield* observed
    if (recorded.length === 0) return granted
    const state = yield* trust.grant(folder, { ...input, observations: recorded })
    yield* reload()
    return state
  })
