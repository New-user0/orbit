export * as SessionOutput from "./output.js"

import { and, asc, eq, gt } from "drizzle-orm"
import { Effect } from "effect"
import { OUTPUT_TOOL } from "@orbit/schema/session-turn"
import { Tool } from "@orbit/schema/tool"
import { Database } from "../database/database.js"
import type { ToolTraits } from "../tool/traits.js"
import { SessionHistory } from "./history.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

/** The name the model uses for the tool that hands in the turn's answer. */
export const NAME = OUTPUT_TOOL

/** The `type` of the error a rejected hand-in fails with; the turn's attempt count reads it back from history. */
export const REJECTED = "output.rejected"

export const DESCRIPTION =
  "Delivers your final answer for this task. The answer must be a JSON object that follows the schema of this tool's parameters. Call it once, after the work is finished, with the complete answer. A reply written as prose does not count as the answer. If the call is rejected, the result lists what is wrong, so correct those fields and call it again."

const ACCEPTED_TEXT = "The answer was accepted. Nothing more is needed; end your turn."

/** Most characters of schema JSON, counted in bytes. */
export const MAX_SCHEMA_BYTES = 256 * 1024
/** Most levels of subschema inside subschema. */
export const MAX_SCHEMA_DEPTH = 64
// A backstop for the JSON that holds the schema, so a deeply nested constant cannot overflow the stack.
const MAX_JSON_DEPTH = 192
// A validation that recurses deeper than this reads an answer nested beyond anything a tool call carries.
const MAX_VALIDATION_DEPTH = 400
// Failures kept per hand-in, and characters of the message the model reads.
const MAX_FAILURES = 50
const MAX_MESSAGE_CHARS = 8_000

export interface Failure {
  /** RFC 6901 JSON Pointer into the answer, `""` for the answer itself. */
  readonly pointer: string
  readonly reason: string
}

export interface Validator {
  /** The schema as the person gave it; it is what the model is shown and what answers are checked against. */
  readonly schema: Readonly<Record<string, unknown>>
  /** Every way `value` fails the schema, or none when it follows it. */
  readonly validate: (value: unknown) => ReadonlyArray<Failure>
}

export type Compiled =
  | { readonly ok: true; readonly validator: Validator }
  | { readonly ok: false; readonly message: string }

type Draft = "07" | "2019-09" | "2020-12"

const DRAFTS: Readonly<Record<string, Draft>> = {
  "http://json-schema.org/draft-07/schema": "07",
  "https://json-schema.org/draft/2019-09/schema": "2019-09",
  "https://json-schema.org/draft/2020-12/schema": "2020-12",
}

const TYPES = new Set(["null", "boolean", "object", "array", "number", "string", "integer"])

// Keywords that describe a schema and never change what it accepts. `format` is one of them, as it is by default in
// 2020-12: a value is not checked against a named format.
const ANNOTATIONS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "$comment",
  "$id",
  "$schema",
  "deprecated",
  "readOnly",
  "writeOnly",
  "contentMediaType",
  "contentEncoding",
  "format",
])

const KEYWORDS = new Set([
  ...ANNOTATIONS,
  "$ref",
  "$defs",
  "definitions",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "items",
  "additionalItems",
  "prefixItems",
  "maxItems",
  "minItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "maxProperties",
  "minProperties",
  "required",
  "properties",
  "patternProperties",
  "additionalProperties",
  "propertyNames",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
])

// Compiled schemas by canonical JSON, so the runner does not rebuild one for every step of a turn.
const CACHE_SIZE = 16
const cache = new Map<string, Compiled>()

/**
 * Checks a schema the way the validator will read it and builds the validator, or says what is wrong and where. The
 * validator interprets the schema; it never builds code from it, so a schema that came from a file or a request is data
 * all the way down. Nothing is fetched: a `$ref` must point into the same document.
 */
export function compile(schema: unknown): Compiled {
  if (!isObject(schema)) return refuse("The schema must be a JSON object.")
  const text = canonical(schema, 0)
  if (text === undefined) return refuse(`The schema is nested more than ${MAX_JSON_DEPTH} levels deep.`)
  if (Buffer.byteLength(text) > MAX_SCHEMA_BYTES)
    return refuse(`The schema is larger than ${MAX_SCHEMA_BYTES / 1024} KiB.`)
  const hit = cache.get(text)
  if (hit) {
    cache.delete(text)
    cache.set(text, hit)
    return hit
  }
  const result = build(schema)
  cache.set(text, result)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return result
}

function refuse(message: string): Compiled {
  return { ok: false, message }
}

function build(schema: Readonly<Record<string, unknown>>): Compiled {
  if (schema.type !== "object")
    return refuse(
      'The root of the schema must declare "type": "object", because the answer is handed in as tool input.',
    )
  const declared = schema.$schema
  const draft =
    declared === undefined
      ? "07"
      : typeof declared === "string" && Object.hasOwn(DRAFTS, declared.replace(/#$/, ""))
        ? DRAFTS[declared.replace(/#$/, "")]
        : undefined
  if (!draft)
    return refuse(
      '"$schema" must name draft-07, 2019-09 or 2020-12 (https://json-schema.org/draft/2020-12/schema), or be left out.',
    )
  const checked = check(schema, { root: schema, draft, seen: new Set() })
  if (checked) return refuse(checked)
  const patterns = new Map<string, RegExp>()
  return {
    ok: true,
    validator: {
      schema,
      validate: (value) => {
        const run: Run = { draft, root: schema, patterns, failures: [], stack: [], depth: 0 }
        walk(schema, value, "", run)
        return run.failures
      },
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking the schema

interface Scope {
  readonly root: Readonly<Record<string, unknown>>
  readonly draft: Draft
  readonly seen: Set<object>
}

/** The first problem with a schema, written for the person who supplied it, or undefined when it can be enforced. */
function check(node: unknown, scope: Scope, pointer = "", level = 0): string | undefined {
  if (typeof node === "boolean") return undefined
  if (!isObject(node)) return `${where(pointer)} must be an object, or true or false.`
  if (scope.seen.has(node)) return undefined
  scope.seen.add(node)
  if (level > MAX_SCHEMA_DEPTH)
    return `The schema nests subschemas more than ${MAX_SCHEMA_DEPTH} levels deep, at ${where(pointer)}.`
  const sub = (value: unknown, key: string, extra?: string) =>
    check(value, scope, `${pointer}/${segment(key)}${extra === undefined ? "" : `/${segment(extra)}`}`, level + 1)
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) {
      const near = [...KEYWORDS].find((known) => distance(known, key) <= 1 && key.length > 3)
      return `Unknown keyword "${printable(key)}" at ${where(pointer)}${near ? `. Did you mean "${near}"?` : "."} Orbit refuses a keyword it cannot enforce.`
    }
    const value = node[key]
    const at = `${where(pointer)} keyword "${key}"`
    switch (key) {
      case "$id":
        // A nested $id would start a new base for the $refs inside it, which the validator does not model.
        if (node !== scope.root)
          return `${at} is only allowed at the root of the schema, because a nested "$id" changes what its references point at.`
        if (typeof value !== "string") return `${at} must be a string.`
        break
      case "$schema":
      case "$comment":
      case "title":
      case "description":
      case "contentMediaType":
      case "contentEncoding":
      case "format":
        if (typeof value !== "string") return `${at} must be a string.`
        break
      case "deprecated":
      case "readOnly":
      case "writeOnly":
      case "uniqueItems":
        if (typeof value !== "boolean") return `${at} must be true or false.`
        break
      case "default":
      case "const":
        break
      case "examples":
        if (!Array.isArray(value)) return `${at} must be an array.`
        break
      case "enum":
        if (!Array.isArray(value) || value.length === 0) return `${at} must be a non-empty array.`
        break
      case "type": {
        const names = Array.isArray(value) ? value : [value]
        if (names.length === 0 || names.some((name) => typeof name !== "string" || !TYPES.has(name)))
          return `${at} must be one of ${[...TYPES].join(", ")}, or an array of them.`
        break
      }
      case "multipleOf":
        if (typeof value !== "number" || !(value > 0)) return `${at} must be a number greater than 0.`
        break
      case "maximum":
      case "minimum":
      case "exclusiveMaximum":
      case "exclusiveMinimum":
        if (typeof value !== "number") return `${at} must be a number.`
        break
      case "maxLength":
      case "minLength":
      case "maxItems":
      case "minItems":
      case "maxProperties":
      case "minProperties":
      case "minContains":
      case "maxContains":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
          return `${at} must be a whole number, 0 or more.`
        break
      case "pattern":
        if (typeof value !== "string" || !regex(value)) return `${at} must be a valid regular expression.`
        break
      case "required":
        if (
          !Array.isArray(value) ||
          value.some((name) => typeof name !== "string") ||
          new Set(value).size !== value.length
        )
          return `${at} must be an array of distinct strings.`
        break
      case "properties":
      case "patternProperties":
      case "dependentSchemas":
      case "$defs":
      case "definitions": {
        if (!isObject(value)) return `${at} must be an object.`
        for (const name of Object.keys(value)) {
          if (key === "patternProperties" && !regex(name))
            return `${at} has the key "${printable(name)}", which is not a valid regular expression.`
          const problem = sub(value[name], key, name)
          if (problem) return problem
        }
        break
      }
      case "dependencies": {
        if (!isObject(value)) return `${at} must be an object.`
        for (const name of Object.keys(value)) {
          const entry = value[name]
          if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) continue
          const problem = sub(entry, key, name)
          if (problem) return problem
        }
        break
      }
      case "dependentRequired": {
        if (!isObject(value)) return `${at} must be an object.`
        for (const name of Object.keys(value)) {
          const entry = value[name]
          if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string"))
            return `${at} must map each property to an array of strings.`
        }
        break
      }
      case "items": {
        if (Array.isArray(value)) {
          if (scope.draft === "2020-12") return `${at} must be a schema in 2020-12; use "prefixItems" for positions.`
          const problem = value.map((entry, index) => sub(entry, key, String(index))).find(Boolean)
          if (problem) return problem
          break
        }
        const problem = sub(value, key)
        if (problem) return problem
        break
      }
      case "additionalItems": {
        if (scope.draft === "2020-12") return `${at} is not part of 2020-12; use "items" after "prefixItems".`
        const problem = sub(value, key)
        if (problem) return problem
        break
      }
      case "prefixItems":
      case "allOf":
      case "anyOf":
      case "oneOf": {
        if (!Array.isArray(value) || value.length === 0) return `${at} must be a non-empty array of schemas.`
        const problem = value.map((entry, index) => sub(entry, key, String(index))).find(Boolean)
        if (problem) return problem
        break
      }
      case "additionalProperties":
      case "contains":
      case "propertyNames":
      case "not":
      case "if":
      case "then":
      case "else": {
        const problem = sub(value, key)
        if (problem) return problem
        break
      }
      case "$ref": {
        if (typeof value !== "string") return `${at} must be a string.`
        if (!value.startsWith("#"))
          return `${at} is "${printable(value)}", which points outside the schema. Only references into the same document, such as "#/$defs/name", are allowed, because Orbit fetches nothing.`
        const target = resolve(value, scope.root)
        if (target === undefined)
          return `${at} is "${printable(value)}", which does not point at anything in the schema.`
        // The seen set bounds reference chains, so a hop is not another level of nesting.
        const problem = check(target, scope, `${pointer}/$ref`, level)
        if (problem) return problem
        break
      }
    }
  }
  return undefined
}

function resolve(ref: string, root: Readonly<Record<string, unknown>>): unknown {
  const fragment = ref.slice(1)
  if (fragment === "") return root
  if (!fragment.startsWith("/")) return undefined
  const decoded = decode(fragment)
  if (decoded === undefined) return undefined
  let node: unknown = root
  for (const part of decoded.split("/").slice(1)) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~")
    if (Array.isArray(node)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined
      node = node[Number(key)]
    } else if (isObject(node)) {
      if (!Object.hasOwn(node, key)) return undefined
      node = node[key]
    } else return undefined
    if (node === undefined) return undefined
  }
  return typeof node === "boolean" || isObject(node) ? node : undefined
}

// A malformed escape or expression is data from the person, not a defect, so it is caught here and refused with a message.
function decode(text: string) {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

function regex(source: string) {
  try {
    return new RegExp(source, "u")
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Checking an answer

interface Run {
  readonly draft: Draft
  readonly root: Readonly<Record<string, unknown>>
  readonly patterns: Map<string, RegExp>
  readonly failures: Array<Failure>
  /** The `$ref` targets being followed, each with the value it reads, to stop a reference that never reads anything. */
  readonly stack: Array<{ readonly target: unknown; readonly value: unknown }>
  depth: number
}

function fail(run: Run, pointer: string, reason: string) {
  if (run.failures.length < MAX_FAILURES) run.failures.push({ pointer, reason })
  return false
}

/** Checks `value` against one schema node, adding every failure to the run. */
function walk(node: unknown, value: unknown, pointer: string, run: Run): boolean {
  if (node === true) return true
  if (node === false) return fail(run, pointer, "no value is allowed here")
  if (!isObject(node)) return true
  if (run.depth > MAX_VALIDATION_DEPTH) return fail(run, pointer, "is nested too deeply to check")
  run.depth++
  const valid = apply(node, value, pointer, run)
  run.depth--
  return valid
}

/** Whether `value` follows `node`, without recording why not. */
function matches(node: unknown, value: unknown, pointer: string, run: Run) {
  const scratch: Run = { ...run, failures: [] }
  return walk(node, value, pointer, scratch)
}

function apply(node: Readonly<Record<string, unknown>>, value: unknown, pointer: string, run: Run): boolean {
  let valid = true
  const bad = (reason: string, at = pointer) => {
    valid = false
    fail(run, at, reason)
  }
  const has = (key: string) => Object.hasOwn(node, key)

  if (typeof node.$ref === "string") {
    const target = resolve(node.$ref, run.root)
    if (run.stack.some((entry) => entry.target === target && Object.is(entry.value, value)))
      bad("is checked by a schema that refers to itself without reading any of the answer")
    else {
      run.stack.push({ target, value })
      if (!walk(target, value, pointer, run)) valid = false
      run.stack.pop()
    }
  }

  if (has("type")) {
    const names = Array.isArray(node.type) ? node.type : [node.type]
    if (!names.some((name) => isType(value, String(name))))
      bad(`must be ${names.map((name) => article(String(name))).join(" or ")}, not ${article(kind(value))}`)
  }
  if (has("enum") && Array.isArray(node.enum) && !node.enum.some((item) => equal(item, value)))
    bad(`must be one of ${preview(node.enum)}`)
  if (has("const") && !equal(node.const, value)) bad(`must equal ${preview([node.const])}`)

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) bad(`must be at least ${node.minimum}`)
    if (typeof node.maximum === "number" && value > node.maximum) bad(`must be at most ${node.maximum}`)
    if (typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum)
      bad(`must be greater than ${node.exclusiveMinimum}`)
    if (typeof node.exclusiveMaximum === "number" && value >= node.exclusiveMaximum)
      bad(`must be less than ${node.exclusiveMaximum}`)
    if (typeof node.multipleOf === "number") {
      const quotient = value / node.multipleOf
      if (!Number.isFinite(quotient) || Math.abs(quotient - Math.round(quotient)) > 1e-9)
        bad(`must be a multiple of ${node.multipleOf}`)
    }
  }

  if (typeof value === "string") {
    const length = typeof node.minLength === "number" || typeof node.maxLength === "number" ? [...value].length : 0
    if (typeof node.minLength === "number" && length < node.minLength)
      bad(`must be at least ${node.minLength} characters long`)
    if (typeof node.maxLength === "number" && length > node.maxLength)
      bad(`must be at most ${node.maxLength} characters long`)
    if (typeof node.pattern === "string" && !pattern(run, node.pattern).test(value))
      bad(`must match the pattern ${printable(node.pattern)}`)
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems)
      bad(`must have at least ${node.minItems} items`)
    if (typeof node.maxItems === "number" && value.length > node.maxItems)
      bad(`must have at most ${node.maxItems} items`)
    if (
      node.uniqueItems === true &&
      value.some((item, index) => value.findIndex((other) => equal(item, other)) !== index)
    )
      bad("must not repeat an item")
    const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : []
    const positional = Array.isArray(node.items) ? node.items : []
    const leading = Math.max(prefix.length, positional.length)
    value.forEach((item, index) => {
      const here = `${pointer}/${index}`
      const schema = index < prefix.length ? prefix[index] : index < positional.length ? positional[index] : undefined
      if (schema !== undefined) {
        if (!walk(schema, item, here, run)) valid = false
        return
      }
      const rest = Array.isArray(node.items) ? node.additionalItems : node.items
      if (rest !== undefined && index >= leading && !walk(rest, item, here, run)) valid = false
    })
    if (has("contains")) {
      const count = value.filter((item, index) => matches(node.contains, item, `${pointer}/${index}`, run)).length
      const least = typeof node.minContains === "number" ? node.minContains : 1
      if (count < least)
        bad(
          least === 1
            ? 'must have an item that follows the "contains" schema'
            : `must have at least ${least} items that follow the "contains" schema`,
        )
      if (typeof node.maxContains === "number" && count > node.maxContains)
        bad(`must have at most ${node.maxContains} items that follow the "contains" schema`)
    }
  }

  if (isObject(value)) {
    const keys = Object.keys(value)
    if (typeof node.minProperties === "number" && keys.length < node.minProperties)
      bad(`must have at least ${node.minProperties} properties`)
    if (typeof node.maxProperties === "number" && keys.length > node.maxProperties)
      bad(`must have at most ${node.maxProperties} properties`)
    if (Array.isArray(node.required))
      for (const name of node.required)
        if (!Object.hasOwn(value, name)) bad("is required but missing", `${pointer}/${segment(String(name))}`)
    const properties = isObject(node.properties) ? node.properties : {}
    const patterns = isObject(node.patternProperties) ? Object.entries(node.patternProperties) : []
    for (const key of keys) {
      const here = `${pointer}/${segment(key)}`
      let covered = false
      if (Object.hasOwn(properties, key)) {
        covered = true
        if (!walk(properties[key], value[key], here, run)) valid = false
      }
      for (const [source, schema] of patterns)
        if (pattern(run, source).test(key)) {
          covered = true
          if (!walk(schema, value[key], here, run)) valid = false
        }
      if (!covered && has("additionalProperties")) {
        if (node.additionalProperties === false) bad("is not an allowed property", here)
        else if (!walk(node.additionalProperties, value[key], here, run)) valid = false
      }
      if (has("propertyNames") && !matches(node.propertyNames, key, here, run))
        bad("is not an allowed property name", here)
    }
    const dependents = [
      ...(isObject(node.dependentRequired) ? Object.entries(node.dependentRequired) : []),
      ...(isObject(node.dependencies)
        ? Object.entries(node.dependencies).filter(([, entry]) => Array.isArray(entry))
        : []),
    ]
    for (const [name, needed] of dependents)
      if (Object.hasOwn(value, name) && Array.isArray(needed))
        for (const other of needed)
          if (!Object.hasOwn(value, String(other)))
            bad(`is required when "${printable(name)}" is present`, `${pointer}/${segment(String(other))}`)
    const schemas = [
      ...(isObject(node.dependentSchemas) ? Object.entries(node.dependentSchemas) : []),
      ...(isObject(node.dependencies)
        ? Object.entries(node.dependencies).filter(([, entry]) => !Array.isArray(entry))
        : []),
    ]
    for (const [name, schema] of schemas)
      if (Object.hasOwn(value, name) && !walk(schema, value, pointer, run)) valid = false
  }

  if (Array.isArray(node.allOf)) for (const schema of node.allOf) if (!walk(schema, value, pointer, run)) valid = false
  if (Array.isArray(node.anyOf) && !node.anyOf.some((schema) => matches(schema, value, pointer, run)))
    bad(`must follow at least one of the ${node.anyOf.length} alternatives in "anyOf"`)
  if (Array.isArray(node.oneOf)) {
    const count = node.oneOf.filter((schema) => matches(schema, value, pointer, run)).length
    if (count !== 1)
      bad(`must follow exactly one of the ${node.oneOf.length} alternatives in "oneOf", but follows ${count}`)
  }
  if (has("not") && matches(node.not, value, pointer, run)) bad('must not follow the schema in "not"')
  if (has("if")) {
    const branch = matches(node.if, value, pointer, run) ? node.then : node.else
    if (branch !== undefined && !walk(branch, value, pointer, run)) valid = false
  }
  return valid
}

function pattern(run: Run, source: string) {
  const known = run.patterns.get(source)
  if (known) return known
  // Every pattern was compiled when the schema was checked.
  const made = new RegExp(source, "u")
  run.patterns.set(source, made)
  return made
}

// ---------------------------------------------------------------------------------------------------------------------
// The hand-in

/** The model-visible text of a rejected hand-in: every failure, each with where it is and why. */
export function rejection(failures: ReadonlyArray<Failure>) {
  const lines = failures.map((failure) => `- ${where(failure.pointer)}: ${failure.reason}`)
  const text = `The answer does not follow the schema, so it was not accepted. Fix these and call ${NAME} again:\n${lines.join("\n")}${failures.length >= MAX_FAILURES ? "\n- (more problems may follow once these are fixed)" : ""}`
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n- (list cut short)` : text
}

/**
 * Runs one hand-in. It fails with `REJECTED` when the input does not follow the schema, and also when the check itself
 * throws: an answer that could not be checked is never accepted.
 */
export const execute = (validator: Validator, input: unknown) =>
  Effect.gen(function* () {
    const failures = yield* Effect.try({
      try: () => (isObject(input) ? validator.validate(input) : [{ pointer: "", reason: "must be a JSON object" }]),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("The structured output validator failed, so the answer was rejected").pipe(
          Effect.annotateLogs({ cause: cause instanceof Error ? cause.message : String(cause) }),
          Effect.as([{ pointer: "", reason: "could not be checked against the schema" }] as ReadonlyArray<Failure>),
        ),
      ),
    )
    if (failures.length > 0) return yield* new Tool.Error({ message: rejection(failures), code: REJECTED })
    return { content: [{ type: "text" as const, text: ACCEPTED_TEXT }], metadata: { structuredOutput: true } }
  })

/** What the hand-in tool is to a call: read-only, safe beside other calls, never asks. */
export const TRAITS = {
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  openWorld: false,
  requiresUserInteraction: false,
  cancelSiblingsOnFailure: false,
  interruptBehavior: "block",
} as const

/** The traits of the tool that do not depend on the call. */
export const STATIC_TRAITS: ToolTraits.Static = {
  openWorld: false,
  requiresUserInteraction: false,
  cancelSiblingsOnFailure: false,
  interruptBehavior: "block",
}

export interface Progress {
  /** How the latest hand-in of the turn ended; undefined when the turn made none. */
  readonly latest: "accepted" | "rejected" | "failed" | undefined
  /** Responses that handed in an answer that was rejected, and no accepted one beside it. */
  readonly rejected: number
}

/**
 * The turn's hand-ins since `since`, read from the stored rows rather than the model-visible history so that a
 * compaction cannot hide an accepted one. A call cut off by the output limit, interrupted or otherwise unsettled never
 * ran, so it is "failed": it is not an accepted answer and it is not an attempt either. A row that cannot be read
 * counts as nothing, so the turn does not pass on it.
 */
export const progress = Effect.fn("SessionOutput.progress")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  since: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, since),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  let latest: Progress["latest"]
  let rejected = 0
  for (const row of rows) {
    const message = yield* SessionHistory.decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
    if (message?.type !== "assistant") continue
    const calls = message.content.flatMap((part) => (part.type === "tool" && part.name === NAME ? [part] : []))
    if (calls.length === 0) continue
    const outcomes = calls.map((call) =>
      call.state.status === "completed"
        ? ("accepted" as const)
        : call.state.status === "error" && call.state.error.type === REJECTED
          ? ("rejected" as const)
          : ("failed" as const),
    )
    if (outcomes.includes("rejected") && !outcomes.includes("accepted")) rejected++
    latest = outcomes.at(-1)
  }
  return { latest, rejected } satisfies Progress
})

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isType(value: unknown, name: string) {
  if (name === "integer") return typeof value === "number" && Number.isInteger(value)
  return kind(value) === name
}

function kind(value: unknown) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value === "number" ? "number" : typeof value === "object" ? "object" : typeof value
}

function article(name: string) {
  return `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right) || left === right) return true
  if (Array.isArray(left))
    return (
      Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index]))
    )
  if (!isObject(left) || !isObject(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  )
}

/** Canonical JSON: keys sorted, so equal schemas share a cache entry. Undefined when the nesting is too deep. */
function canonical(value: unknown, depth: number): string | undefined {
  if (depth > MAX_JSON_DEPTH) return undefined
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, depth + 1))
    return items.includes(undefined) ? undefined : `[${items.join(",")}]`
  }
  if (!isObject(value)) return JSON.stringify(value) ?? "null"
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, canonical(value[key], depth + 1)] as const)
  return entries.some(([, text]) => text === undefined)
    ? undefined
    : `{${entries.map(([key, text]) => `${JSON.stringify(key)}:${text}`).join(",")}}`
}

// RFC 6901 escaping, then control characters, so a property name the model chose cannot add lines or escape codes.
function segment(key: string) {
  return printable(key.replaceAll("~", "~0").replaceAll("/", "~1"))
}

function printable(text: string) {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

function where(pointer: string) {
  return pointer === "" ? "the answer" : pointer
}

function preview(values: ReadonlyArray<unknown>) {
  const text = values.map((value) => JSON.stringify(value) ?? "null").join(", ")
  return printable(text.length > 200 ? `${text.slice(0, 200)}...` : text)
}

function distance(left: string, right: string) {
  if (Math.abs(left.length - right.length) > 1) return 2
  let row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const next = [i]
    for (let j = 1; j <= right.length; j++)
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1))
    row = next
  }
  return row[right.length]
}
