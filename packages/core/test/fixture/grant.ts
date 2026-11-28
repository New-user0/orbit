import { Effect } from "effect"
import { Config } from "@orbit/core/config"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"

/**
 * Trusts a folder the way the server does: nothing of a folder that is not trusted is read, so for one the config is
 * read again after the grant, as `ProjectTrust.grant` does, and the grant's effect is in place when this returns.
 */
export const grantFolder = (folder: string, input: { readonly persist: boolean; readonly via: string }) =>
  Effect.gen(function* () {
    const trust = yield* WorkspaceTrust.Service
    const config = yield* Config.Service
    const fresh = !(yield* trust.status(folder)).trusted
    const granted = yield* trust.grant(folder, input)
    const reload = config.reload
    if (fresh && reload !== undefined) yield* reload()
    return granted
  })
