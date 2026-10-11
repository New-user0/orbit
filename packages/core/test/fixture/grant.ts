import { realpath } from "fs/promises"
import { Effect } from "effect"
import { Config } from "@orbit/core/config"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"

/**
 * Trusts a folder the way the server does: with the executable config the config last read for it, which is what the
 * person was shown. A grant straight from the store records nothing, so every source of the folder would read as
 * changed.
 */
export const grantWithRecords = (folder: string, input: { readonly persist: boolean; readonly via: string }) =>
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    const config = yield* Config.Service
    const wanted = WorkspaceTrust.key(yield* Effect.promise(() => realpath(folder)))
    const observations = yield* Effect.filter(yield* config.fingerprints(), (item) =>
      Effect.promise(() => realpath(item.root)).pipe(Effect.map((real) => WorkspaceTrust.key(real) === wanted)),
    )
    return yield* trust.grant(folder, { ...input, observations })
  })
