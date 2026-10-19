export * as LegacyAgent from "./legacy-agent.js"

import { ConfigAgent } from "@orbit/schema/config/agent"
import { Option, Schema } from "effect"
import { ConfigPermissionV1 } from "../v1/config/permission.js"

const isAction = Schema.is(ConfigPermissionV1.Action)
const decodePermission = Schema.decodeUnknownOption(ConfigPermissionV1.Info)
// Whether the legacy decoder accepts `rule` under `name`: question, websearch and doom_loop take an action only.
const accepts = (name: string, rule: unknown) => Option.isSome(decodePermission({ [name]: rule }))

const tiers = new Set<string>(["inherit", "small", "large"])
// Another product spells these keys in camelCase. The legacy decoder forwards a key it does not know to the provider as
// a request option, so a deny list written this way would quietly turn into a request field. They are set aside.
const foreign: Readonly<Record<string, string>> = {
  disallowedTools: "disallowed_tools",
  permissionMode: "permission_mode",
  mcpServers: "mcp_servers",
  maxTurns: "max_turns",
  initialPrompt: "initial_prompt",
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
 * Sets aside the keys written for another product and settles a `variant` beside a model, so every door reads an entry
 * the same way. Each key that is dropped or changed has a note, which the caller reports at that key.
 */
export function prepare(entry: Record<string, unknown>) {
  const notes: { key: string; message: string }[] = []
  const unforeign = Object.fromEntries(
    Object.entries(entry).filter(([key]) => {
      const native = Object.hasOwn(foreign, key) ? foreign[key] : undefined
      if (native === undefined) return true
      notes.push({ key, message: `ignored "${key}"; use "${native}"` })
      return false
    }),
  )
  // A tools map and a permission object are lists of independent entries: one bad entry costs only itself, so a deny
  // written beside it still holds.
  const kept: Record<string, unknown> = {
    ...unforeign,
    ...(isToolMap(unforeign.tools) ? { tools: onlyBooleans(unforeign.tools, notes) } : {}),
    ...(isRecord(unforeign.permission) ? { permission: onlyActions(unforeign.permission, notes) } : {}),
  }
  if (!("variant" in kept)) return { entry: kept, notes }
  const { variant, ...unvaried } = kept
  // A tier is no model, so a variant has nowhere to go; it becomes the effort when none is given.
  if (isTier(kept.model)) {
    const effort = kept.effort === undefined && typeof variant === "string"
    notes.push({
      key: "variant",
      message: `a model tier takes no variant; ${effort ? "used it as the effort" : "ignored it"}`,
    })
    return { entry: { ...unvaried, ...(effort ? { effort: variant } : {}) }, notes }
  }
  // A model written as a string takes the variant in its name; an embedded or structured selection keeps its own.
  if (
    typeof kept.model === "string" &&
    !kept.model.includes("#") &&
    typeof variant === "string" &&
    /^[^#]+$/.test(variant)
  )
    return { entry: { ...unvaried, model: `${kept.model}#${variant}` }, notes }
  return { entry: kept, notes }
}

function onlyBooleans(tools: Record<string, unknown>, notes: { key: string; message: string }[]) {
  return Object.fromEntries(
    Object.entries(tools).filter(([name, value]) => {
      if (typeof value === "boolean") return true
      notes.push({ key: `tools.${name}`, message: `dropped the invalid "tools.${name}"; it must be true or false` })
      return false
    }),
  )
}

function onlyActions(permission: Record<string, unknown>, notes: { key: string; message: string }[]) {
  return Object.fromEntries(
    Object.entries(permission).flatMap(([name, rule]): [string, unknown][] => {
      if (accepts(name, rule)) return [[name, rule]]
      if (isRecord(rule) && accepts(name, {})) {
        const patterns = Object.entries(rule).filter(([pattern, action]) => {
          if (isAction(action)) return true
          notes.push({
            key: `permission.${name}.${pattern}`,
            message: `dropped the invalid "permission.${name}.${pattern}"; use ask, allow or deny`,
          })
          return false
        })
        return patterns.length === 0 ? [] : [[name, Object.fromEntries(patterns)]]
      }
      notes.push({
        key: `permission.${name}`,
        message: `dropped the invalid "permission.${name}"; use ask, allow or deny`,
      })
      return []
    }),
  )
}

/**
 * Splits an entry that is routed through the legacy decoder into what that decoder owns (a tools map, the keys only the
 * legacy format has, and keys neither schema knows) and what is native. A native key, including the ones both formats
 * share, never goes to the legacy decoder: it would fail the entry as one object and take the native half, its deny
 * rules included, with it, and the decoder would forward every key it does not know to the provider as a request option.
 */
export function split(entry: Record<string, unknown>) {
  const native = (key: string, value: unknown) =>
    key in ConfigAgent.Info.fields && (key !== "tools" || !isToolMap(value))
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
