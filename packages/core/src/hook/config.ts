export * as HookConfig from "./config.js"

import { isRecord } from "@orbit/ai/utils/record"
import { ConfigHooks } from "@orbit/schema/config/hooks"
import { Option, Schema } from "effect"

/**
 * Decodes the raw `hooks` value of a settings document entry by entry, so one bad hook costs only itself. Survivors
 * come back in encoded form, ready for the final `Config.Info` validation. Every skipped entry is reported at its
 * exact path: `invalid` when it is malformed, `unsupported` when it is well formed but its event or hook type cannot
 * honor it as written. A key that no field of the schema names is dropped from its entry, which survives, and is
 * reported as `unsupported` too, so a misspelled `matcher` or a field written in another format never vanishes
 * unnoticed.
 */

export interface Diagnostic {
  readonly kind: "invalid" | "unsupported"
  readonly path: readonly string[]
  readonly message: string
}

export interface Result {
  /** The surviving hooks, or undefined when the value is not an object at all. */
  readonly hooks: Readonly<Record<string, unknown>> | undefined
  readonly diagnostics: readonly Diagnostic[]
}

type EncodedHook = (typeof ConfigHooks.Hook)["Encoded"]

const options = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
// A group's own fields are checked here; its hooks are decoded one by one so a bad hook leaves its siblings alone.
const Group = Schema.Struct({ matcher: ConfigHooks.Matcher.fields.matcher, hooks: Schema.Array(Schema.Unknown) })
const hookFields = {
  command: ConfigHooks.Command.fields,
  prompt: ConfigHooks.Prompt.fields,
  agent: ConfigHooks.Agent.fields,
  http: ConfigHooks.Http.fields,
} as const satisfies Record<EncodedHook["type"], object>

export function decode(input: unknown): Result {
  if (!isRecord(input)) return { hooks: undefined, diagnostics: [invalid(["hooks"])] }
  const diagnostics: Diagnostic[] = []
  const hooks = Object.entries(input).flatMap(([key, value]): [string, unknown][] => {
    const decoded = decodeKey(key, value, ["hooks", key], diagnostics)
    return decoded === undefined ? [] : [[key, decoded]]
  })
  return { hooks: Object.fromEntries(hooks), diagnostics }
}

function decodeKey(key: string, input: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (isEvent(key)) return decodeEvent(key, input, path, diagnostics)
  if (key === "disabled" || key === "managed_only")
    return decodeLeaf(ConfigHooks.Info.fields[key], input, path, diagnostics)
  if (key === "http") return decodeHttp(input, path, diagnostics)
  diagnostics.push({ kind: "unsupported", path, message: "omitted unknown hook event" })
  return undefined
}

function decodeEvent(event: ConfigHooks.Event, input: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!Array.isArray(input)) {
    diagnostics.push(invalid(path))
    return undefined
  }
  return input.flatMap((raw, index) => decodeGroup(event, raw, [...path, String(index)], diagnostics))
}

function decodeGroup(event: ConfigHooks.Event, raw: unknown, path: string[], diagnostics: Diagnostic[]) {
  const group = Schema.decodeUnknownOption(Group, options)(raw)
  if (Option.isNone(group)) {
    diagnostics.push(invalid(path))
    return []
  }
  reportExcess(raw, Group.fields, path, diagnostics)
  const hooks = group.value.hooks.flatMap((hook, index) =>
    decodeHook(event, hook, [...path, "hooks", String(index)], diagnostics),
  )
  return [group.value.matcher === undefined ? { hooks } : { matcher: group.value.matcher, hooks }]
}

function decodeHook(event: ConfigHooks.Event, raw: unknown, path: string[], diagnostics: Diagnostic[]) {
  const hook = canonical(ConfigHooks.Hook, raw)
  if (Option.isNone(hook)) {
    diagnostics.push(invalid(path))
    return []
  }
  const reason = unsupportedReason(event, hook.value, raw)
  if (reason !== undefined) {
    diagnostics.push({ kind: "unsupported", path, message: reason })
    return []
  }
  reportExcess(raw, hookFields[hook.value.type], path, diagnostics)
  return [hook.value]
}

/** Why no engine can run this hook as written, if that is so. */
function unsupportedReason(event: ConfigHooks.Event, hook: EncodedHook, raw: unknown) {
  if ((hook.type === "prompt" || hook.type === "agent") && !isDecisionEvent(event))
    return "omitted prompt or agent hook on an event that does not accept them"
  // The schema only models these two on commands, so the raw entry is the one place that still shows the request.
  // Anything but an explicit false asks for a background hook, and it is never run in a mode its author did not write.
  if (
    hook.type !== "command" &&
    isRecord(raw) &&
    [raw.async, raw.async_rewake].some((value) => value !== undefined && value !== false)
  )
    return "omitted background hook that is not a command"
  if (hook.type === "command" && event === "WorktreeCreate" && (hook.async === true || hook.async_rewake === true))
    return "omitted background hook on an event that waits for its result"
  return undefined
}

/** The decoded entry already lacks the keys that have no field; this tells the author which ones they were. */
function reportExcess(raw: unknown, fields: object, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(raw)) return
  Object.keys(raw)
    .filter((key) => !Object.hasOwn(fields, key))
    .forEach((key) => diagnostics.push({ kind: "unsupported", path: [...path, key], message: "omitted unknown field" }))
}

/** `http` limits are checked per list, so one malformed list leaves the other in force. */
function decodeHttp(input: unknown, path: string[], diagnostics: Diagnostic[]) {
  if (!isRecord(input)) {
    diagnostics.push(invalid(path))
    return undefined
  }
  reportExcess(input, ConfigHooks.HttpPolicy.fields, path, diagnostics)
  return Object.fromEntries(
    Object.entries(ConfigHooks.HttpPolicy.fields).flatMap(([key, field]): [string, unknown][] => {
      if (!Object.hasOwn(input, key)) return []
      const decoded = decodeLeaf(field, input[key], [...path, key], diagnostics)
      return decoded === undefined ? [] : [[key, decoded]]
    }),
  )
}

function decodeLeaf<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
  path: string[],
  diagnostics: Diagnostic[],
) {
  const decoded = canonical(schema, input)
  if (Option.isSome(decoded)) return decoded.value
  diagnostics.push(invalid(path))
  return undefined
}

function canonical<S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, input: unknown) {
  return Schema.decodeUnknownOption(
    schema,
    options,
  )(input).pipe(Option.flatMap((decoded) => Schema.encodeUnknownOption(schema, options)(decoded)))
}

function isEvent(key: string): key is ConfigHooks.Event {
  return ConfigHooks.Events.some((event) => event === key)
}

function isDecisionEvent(event: ConfigHooks.Event) {
  return ConfigHooks.DecisionEvents.some((decision) => decision === event)
}

function invalid(path: readonly string[]): Diagnostic {
  return { kind: "invalid", path, message: "skipped malformed recognized value" }
}
