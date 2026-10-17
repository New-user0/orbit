export * as LegacyAgent from "./legacy-agent.js"

import { ConfigAgent } from "@orbit/schema/config/agent"
import { ConfigAgentV1 } from "../v1/config/agent.js"

const nativeOnly = Object.keys(ConfigAgent.Info.fields).filter((key) => !ConfigAgentV1.KNOWN_KEYS.has(key))
const tiers = new Set<string>(["inherit", "small", "large"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether `tools` is the legacy map of tool names to booleans (a string or a list is the native allow list). */
export function isToolMap(value: unknown) {
  return isRecord(value)
}

/** A model that names a tier instead of a provider and model, which the legacy decoder cannot hold. */
export function isTier(value: unknown) {
  return typeof value === "string" && tiers.has(value.trim().toLowerCase())
}

/**
 * Splits an entry that is routed through the legacy decoder into what that decoder owns and what is native. A native
 * key must never reach the legacy decoder, which would forward it to the provider as a request option, so the deny list
 * or the rules written beside a tools map would quietly turn into request fields. Keys that neither schema knows stay
 * with the legacy side, as they always did.
 */
export function split(entry: Record<string, unknown>) {
  const native = (key: string, value: unknown) =>
    nativeOnly.includes(key) || (key === "tools" && !isToolMap(value)) || (key === "model" && isTier(value))
  return {
    legacy: Object.fromEntries(Object.entries(entry).filter(([key, value]) => !native(key, value))),
    native: Object.fromEntries(Object.entries(entry).filter(([key, value]) => native(key, value))),
  }
}

/**
 * Puts the natively decoded keys over the migrated agent. Rules the native side wrote come after the ones migrated from
 * the tools map, and the request merges, so nothing of either side is lost. Both arguments are in encoded form.
 */
export function merge(migrated: Record<string, unknown>, native: Record<string, unknown>) {
  const { permissions, request, ...rest } = native
  const rules = [
    ...(Array.isArray(migrated.permissions) ? migrated.permissions : []),
    ...(Array.isArray(permissions) ? permissions : []),
  ]
  const before = isRecord(migrated.request) ? migrated.request : {}
  const after = isRecord(request) ? request : {}
  const headers = {
    ...(isRecord(before.headers) ? before.headers : {}),
    ...(isRecord(after.headers) ? after.headers : {}),
  }
  const body = { ...(isRecord(before.body) ? before.body : {}), ...(isRecord(after.body) ? after.body : {}) }
  const combined = {
    ...before,
    ...after,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(Object.keys(body).length === 0 ? {} : { body }),
  }
  return {
    ...migrated,
    ...rest,
    ...(rules.length === 0 ? {} : { permissions: rules }),
    ...(Object.keys(combined).length === 0 ? {} : { request: combined }),
  }
}
