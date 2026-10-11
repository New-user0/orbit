export * as ConfigEnv from "./env.js"

import type { Entry } from "@orbit/schema/config"
import { EnvConfig } from "@orbit/schema/config/env-config"
import { Environment } from "@orbit/util/environment"

/**
 * The `env` of every document, folded name by name in the order `entries` is given (lowest scope first, managed last).
 * Withholding has already happened: an untrusted document has no `env` left.
 */
export function resolve(entries: readonly Entry[], platform: NodeJS.Platform = process.platform) {
  const result: Record<string, string> = {}
  entries.forEach((entry) => {
    if (entry.type !== "document" || entry.info.env === undefined) return
    Environment.assign(
      result,
      Object.fromEntries(Object.entries(entry.info.env).filter(([name]) => !EnvConfig.isReserved(name))),
      platform,
    )
  })
  return result
}

/** Puts `values` into `target`, which is a copy the caller owns. It never touches `process.env` unless handed it. */
export function applyTo<V extends string | undefined>(
  target: Record<string, V>,
  values: Readonly<Record<string, V>>,
  platform: NodeJS.Platform = process.platform,
) {
  return Environment.assign(target, values, platform)
}
