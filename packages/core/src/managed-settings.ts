export * as ManagedSettings from "./managed-settings.js"

import path from "path"
import { isDeepStrictEqual } from "node:util"
import { parse, type ParseError } from "jsonc-parser"
import { Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { Info } from "@orbit/schema/config"
import { ConfigManaged } from "@orbit/schema/config/managed"
import { FSUtil } from "@orbit/util/fs-util"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { ManagedPath } from "@orbit/util/managed-path"
import { ConfigNormalize } from "./config/normalize.js"
import { ConfigVariable } from "./config/variable.js"
import { Watcher } from "./filesystem/watcher.js"
import { ManagedPolicy } from "./managed-policy.js"

/** A problem found in one managed settings file. It costs only the file or the entry it names. */
export interface Diagnostic {
  /** The file the problem is in. */
  readonly source: string
  /** `$` for the file, or `$.managed.mcp.deny` style for a field or entry. */
  readonly path: string
  readonly kind: "invalid" | "unsupported"
  readonly message: string
}

export interface Snapshot {
  readonly directory: string
  /** The files that were read, in the order they were merged: the base file, then the drop-ins by name. */
  readonly sources: ReadonlyArray<string>
  /** Every config field the files set, merged. */
  readonly info: Info
  /** The `managed` restrictions the files set, merged. */
  readonly restrictions: ConfigManaged.Restrictions
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

export interface Interface {
  /** What the files said when they were last read. */
  readonly current: () => Snapshot
  /** The snapshot after each reload that changed it. */
  readonly changes: () => Stream.Stream<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ManagedSettings") {}

export const Options = Schema.Struct({
  directory: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
const decodeRestrictions = Schema.decodeUnknownOption(ConfigManaged.Restrictions, decodeOptions)

const flags = ["disable_bypass_permissions", "managed_permissions_only", "managed_hooks_only", "disable_hooks"] as const
const lists = {
  mcp: ["allow", "deny"],
  plugins: ["allow", "block", "marketplaces"],
  network: ["allowed_domains", "denied_domains"],
} as const

interface Loaded {
  readonly present: boolean
  /** The file's config fields in canonical form, when they decoded. */
  readonly rest?: Record<string, unknown>
  /** The file's restrictions that decoded, entry by entry. */
  readonly restrictions?: Record<string, unknown>
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

/**
 * Reads the managed settings in `directory`: `managed-settings.json`, then `managed-settings.d/*.json` by filename.
 * A missing directory is an empty snapshot. A file that cannot be used, or an entry in one, costs only itself and
 * shows in `diagnostics`; its siblings still apply. Needs only the filesystem, so it works before the application
 * layer exists.
 */
export const read = Effect.fn("ManagedSettings.read")(function* (directory: string) {
  const fs = yield* FSUtil.Service
  const dropins = yield* fs.readDirectoryEntries(path.join(directory, "managed-settings.d")).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.type !== "directory" && entry.name.endsWith(".json"))
        .map((entry) => path.join(directory, "managed-settings.d", entry.name))
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    Effect.orElseSucceed((): string[] => []),
  )
  const loaded = yield* Effect.forEach([path.join(directory, "managed-settings.json"), ...dropins], (file) =>
    loadFile(fs, file),
  )
  const diagnostics = loaded.flatMap((file) => file.diagnostics)
  const rest = loaded.reduce<unknown>((merged, file) => (file.rest ? merge(merged, file.rest) : merged), {})
  const info = decodeInfo(rest)
  const restrictions = decodeRestrictions(
    loaded.reduce<unknown>((merged, file) => merge(merged, file.restrictions), {}),
  )
  return {
    directory,
    sources: loaded.filter((file) => file.present).map((file) => file.source),
    info: Option.getOrElse(info, () => new Info({})),
    restrictions: Option.getOrElse(restrictions, (): ConfigManaged.Restrictions => ({})),
    diagnostics: [
      ...diagnostics,
      ...(Option.isNone(info)
        ? [
            {
              source: directory,
              path: "$",
              kind: "invalid" as const,
              message: "ignored the merged settings, which no longer validate",
            },
          ]
        : []),
    ],
  } satisfies Snapshot
})

const loadFile = Effect.fnUntraced(function* (fs: FSUtil.Interface, file: string) {
  const source = file
  const problem = (kind: Diagnostic["kind"], at: string, message: string): Diagnostic => ({
    source,
    path: at,
    kind,
    message,
  })
  const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(null)))
  if (text === undefined) return { source, present: false, diagnostics: [] }
  if (text === null)
    return { source, present: true, diagnostics: [problem("invalid", "$", "skipped a file that cannot be read")] }
  const substituted = yield* ConfigVariable.substitute({ type: "path", path: file, text }).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (substituted === undefined)
    return {
      source,
      present: true,
      diagnostics: [problem("invalid", "$", "skipped a file with a variable that cannot be resolved")],
    }
  const errors: ParseError[] = []
  const input: unknown = parse(substituted, errors, { allowTrailingComma: true })
  if (errors.length > 0 || typeof input !== "object" || input === null || Array.isArray(input))
    return {
      source,
      present: true,
      diagnostics: [problem("invalid", "$", "skipped a file that is not a JSON or JSONC object")],
    }
  const { managed, ...others } = input as Record<string, unknown>
  const restrictions = cleanRestrictions(managed)
  const normalized = ConfigNormalize.normalize(others)
  const normalizedProblems = normalized.diagnostics.map((diagnostic) =>
    problem(
      diagnostic.kind === "unsupported" ? "unsupported" : "invalid",
      `$.${diagnostic.path.join(".")}`,
      diagnostic.message,
    ),
  )
  const encoded =
    normalized.type === "normalized" && Option.isSome(decodeInfo(normalized.encoded)) ? normalized.encoded : undefined
  return {
    source,
    present: true,
    rest: encoded as Record<string, unknown> | undefined,
    restrictions: restrictions.value,
    diagnostics: [
      ...restrictions.problems.map((item) => problem(item.kind, item.path, item.message)),
      ...normalizedProblems,
      ...(normalized.type === "rejected" || encoded
        ? []
        : [problem("invalid", "$", "ignored the settings of a file that do not validate")]),
    ],
  } satisfies Loaded & { source: string }
})

type Problem = { readonly kind: Diagnostic["kind"]; readonly path: string; readonly message: string }

// Keeps what decodes, entry by entry, so one bad value costs only itself and never the denies next to it.
function cleanRestrictions(raw: unknown) {
  if (raw === undefined) return { value: undefined, problems: [] as Problem[] }
  if (!isRecord(raw))
    return {
      value: undefined,
      problems: [
        { kind: "invalid", path: "$.managed", message: "ignored restrictions that are not an object" },
      ] as Problem[],
    }
  const problems: Problem[] = []
  const value: Record<string, unknown> = {}
  const bad = (at: string, message: string) => problems.push({ kind: "invalid", path: `$.managed.${at}`, message })
  if (typeof raw.organization === "string") value.organization = raw.organization
  else if (raw.organization !== undefined) bad("organization", "ignored a value that is not a string")
  flags.forEach((key) => {
    if (typeof raw[key] === "boolean") value[key] = raw[key]
    else if (raw[key] !== undefined) bad(key, "ignored a value that is not a boolean")
  })
  Object.entries(lists).forEach(([group, keys]) => {
    const section = raw[group]
    if (section === undefined) return
    if (!isRecord(section)) return bad(group, "ignored a value that is not an object")
    const kept: Record<string, string[]> = {}
    keys.forEach((key) => {
      const entries = section[key]
      if (entries === undefined) return
      if (!Array.isArray(entries)) return bad(`${group}.${key}`, "ignored a value that is not a list")
      kept[key] = entries.flatMap((entry, index) => {
        if (typeof entry === "string") return [entry]
        bad(`${group}.${key}.${index}`, "ignored an entry that is not a string")
        return []
      })
    })
    value[group] = kept
  })
  if (raw.env !== undefined)
    problems.push({
      kind: "unsupported",
      path: "$.managed.env",
      message: "ignored env here; set it with the top-level env of the managed settings",
    })
  return { value, problems }
}

// Objects merge by key, lists concatenate (a list of strings loses its repeats) and any other value takes the later one.
function merge(base: unknown, next: unknown): unknown {
  if (next === undefined) return base
  if (Array.isArray(base) && Array.isArray(next)) {
    const all = [...base, ...next]
    return all.every((item) => typeof item === "string") ? [...new Set(all)] : all
  }
  if (isRecord(base) && isRecord(next))
    return Object.fromEntries(
      [...new Set([...Object.keys(base), ...Object.keys(next)])].map((key) => [key, merge(base[key], next[key])]),
    )
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const watcher = yield* Watcher.Service
      const policy = yield* ManagedPolicy.Service
      const directory = options?.directory ?? ManagedPath.directory(process.platform, process.env)
      const changes = yield* PubSub.unbounded<Snapshot>()
      const reloads = yield* PubSub.sliding<void>(1)

      const load = read(directory).pipe(Effect.provideService(FSUtil.Service, fs))
      const apply = (snapshot: Snapshot) =>
        policy.set("file", {
          statements: snapshot.info.experimental?.policies ?? [],
          rules: snapshot.info.permissions ?? [],
          restrictions: snapshot.restrictions,
          ...(snapshot.restrictions.organization === undefined
            ? {}
            : { organization: snapshot.restrictions.organization }),
        })
      const report = (snapshot: Snapshot) =>
        Effect.forEach(
          snapshot.diagnostics,
          (diagnostic) => Effect.logWarning("managed settings diagnostic", { ...diagnostic }),
          { discard: true },
        )

      let current = yield* load
      yield* apply(current)
      yield* report(current)

      const reload = Effect.gen(function* () {
        const next = yield* load
        if (isDeepStrictEqual(next, current)) return
        // Only a change in what the files say is reported again, so a watcher that fires often does not repeat itself.
        if (!isDeepStrictEqual(next.diagnostics, current.diagnostics)) yield* report(next)
        current = next
        yield* apply(next)
        yield* PubSub.publish(changes, next)
      }).pipe(Effect.catchCause((cause) => Effect.logError("failed to reload managed settings", { cause })))

      // The folder is watched only if it exists now: Orbit never creates it, and a folder made later is read on restart.
      if (yield* fs.isDir(directory)) {
        const pending = yield* PubSub.subscribe(reloads)
        yield* Stream.fromSubscription(pending).pipe(
          Stream.debounce("100 millis"),
          Stream.runForEach(() => reload),
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* watcher
          .subscribe({ path: directory, type: "directory" })
          .pipe(
            Effect.flatMap(Stream.runForEach(() => PubSub.publish(reloads, undefined))),
            Effect.forkScoped({ startImmediately: true }),
          )
      }

      return Service.of({
        current: () => current,
        changes: () => Stream.fromPubSub(changes),
      })
    }),
  )

/** No managed settings at all, for a runtime that has no filesystem to read them from. */
export const emptyLayer = Layer.succeed(
  Service,
  Service.of({
    current: () => ({
      directory: "",
      sources: [],
      info: new Info({}),
      restrictions: {},
      diagnostics: [],
    }),
    changes: () => Stream.empty,
  }),
)

export function configured(options?: Options) {
  return makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [FSUtil.node, Watcher.node, ManagedPolicy.node],
  })
}

export const node = configured()
