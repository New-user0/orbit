export * as ManagedSettings from "./managed-settings.js"

import path from "path"
import { isDeepStrictEqual } from "node:util"
import { parse, type ParseError } from "jsonc-parser"
import { Context, Effect, Layer, Option, PubSub, Schema, SchemaAST, Stream } from "effect"
import { Document, Info } from "@orbit/schema/config"
import { ConfigManaged } from "@orbit/schema/config/managed"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { ManagedPath } from "@orbit/util/managed-path"
import { ConfigPermissionExpand } from "./config/expand-permissions.js"
import { ConfigEnv } from "./config/env.js"
import { ConfigNormalize } from "./config/normalize.js"
import { ConfigVariable } from "./config/variable.js"
import { Watcher } from "./filesystem/watcher.js"
import { ManagedNetwork } from "./managed-network.js"
import { ManagedPolicy } from "./managed-policy.js"
import { PluginRestriction } from "@orbit/plugin/restriction"

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

// The one boolean in `managed.network`; the other keys there are lists of hosts.
const domainsOnly = "allow_managed_domains_only"
// The one boolean in `managed.mcp`; the other keys there are lists of selectors.
const mcpOnly = "managed_only"

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
  const folder = path.join(directory, "managed-settings.d")
  // Only a folder that is not there is empty. One that cannot be listed (permissions, a file in its place) is reported.
  const listing = yield* fs.readDirectoryEntries(folder).pipe(
    Effect.map((entries) => ({ entries, problem: undefined })),
    Effect.catch((error) =>
      Effect.succeed({
        entries: [] as FSUtil.DirEntry[],
        problem: isNotFound(error)
          ? undefined
          : ({
              source: folder,
              path: "$",
              kind: "invalid",
              message: "skipped a folder that cannot be listed",
            } satisfies Diagnostic),
      }),
    ),
  )
  // File names are case-insensitive on Windows and macOS, so `10-a.JSON` is a drop-in there; elsewhere it is reported.
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
  const files = listing.entries.filter((entry) => entry.type !== "directory")
  const dropins = files
    .filter((entry) => (caseInsensitive ? /\.json$/i : /\.json$/).test(entry.name))
    .map((entry) => path.join(folder, entry.name))
    .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const skipped = files
    .filter((entry) => /\.jsonc?$/i.test(entry.name) && !dropins.includes(path.join(folder, entry.name)))
    .map(
      (entry): Diagnostic => ({
        source: path.join(folder, entry.name),
        path: "$",
        kind: "unsupported",
        message: "skipped a file that is not named *.json",
      }),
    )
  // A name the folder lists is there even when its target is not (a broken link), so reading it as absent is a loss.
  const baseListed = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) =>
      entries.some((entry) =>
        caseInsensitive ? entry.name.toLowerCase() === "managed-settings.json" : entry.name === "managed-settings.json",
      ),
    ),
    Effect.catch(() => Effect.succeed(false)),
  )
  const loaded = yield* Effect.forEach(
    [
      { file: path.join(directory, "managed-settings.json"), listed: baseListed },
      ...dropins.map((file) => ({ file, listed: true })),
    ],
    (item) => loadFile(fs, item.file, item.listed),
  )
  const rest = loaded.reduce<unknown>((merged, file) => (file.rest ? merge(merged, file.rest) : merged), {})
  const restrictions = decodeRestrictions(
    loaded.reduce<unknown>((merged, file) => merge(merged, file.restrictions), {}),
  )
  return {
    directory,
    sources: loaded.filter((file) => file.present).map((file) => file.source),
    info: Option.getOrElse(decodeInfo(rest), () => new Info({})),
    restrictions: Option.getOrElse(restrictions, (): ConfigManaged.Restrictions => ({})),
    diagnostics: [
      ...(listing.problem ? [listing.problem] : []),
      ...skipped,
      ...loaded.flatMap((file) => file.diagnostics),
    ],
  } satisfies Snapshot
})

const loadFile = Effect.fnUntraced(function* (fs: FSUtil.Interface, source: string, listed: boolean) {
  const file = source
  const problem = (kind: Diagnostic["kind"], at: string, message: string): Diagnostic => ({
    source,
    path: at,
    kind,
    message,
  })
  // Only a file that is not there is absent. One that is there and cannot be read is reported, because its
  // restrictions are lost.
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.catch((error) => Effect.succeed(isNotFound(error) && !listed ? undefined : null)))
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
  const reported: Problem[] = normalized.diagnostics.map((diagnostic) => ({
    kind: diagnostic.kind === "unsupported" ? "unsupported" : "invalid",
    path: `$.${diagnostic.path.join(".")}`,
    message: diagnostic.message,
  }))
  // The normalizer ignores a key it does not know, so a typo such as `permisions` or `sandbox.enabeld` would turn an
  // organization's setting off without a word. A path it already reported is not reported twice.
  const normalizedProblems = [
    ...reported,
    ...unknownKeys(others).filter((item) => !reported.some((known) => item.path === known.path)),
  ].map((item) => problem(item.kind, item.path, item.message))
  return {
    source,
    present: true,
    // The normalizer decodes entry by entry, so what it encodes validates; it rejects only a root that is not an
    // object, which is excluded above.
    rest: normalized.type === "normalized" ? (normalized.encoded as Record<string, unknown>) : undefined,
    restrictions: restrictions.value,
    diagnostics: [
      ...restrictions.problems.map((item) => problem(item.kind, item.path, item.message)),
      ...normalizedProblems,
    ],
  } satisfies Loaded & { source: string }
})

// The legacy spellings the normalizer migrates at the top level. Their shapes belong to the V1 schemas, so only the
// native fields are walked.
const legacyKeys: readonly string[] = [
  ...["agent", "attachment", "autoshare", "autoupdate", "command", "mode", "permission", "plugin", "provider"],
  ...["reference", "small_model", "snapshot", "tools", "enabled_providers", "disabled_providers"],
]
// Migrated by the normalizer, so it works although the schema has no such field.
const legacyPaths: readonly string[] = [
  "$.experimental.mcp_timeout",
  "$.compaction.preserve_recent_tokens",
  "$.compaction.reserved",
]
// Under `mcp` the normalizer reads `servers` and `timeout`; any other key is a legacy server it migrates, or reports
// itself when it does not decode.
const mcpKeys: readonly string[] = ["servers", "timeout"]
const encodedInfo = Schema.toEncoded(Info).ast

/** Every key the schema does not know, at any depth: struct fields, record values, union members and list items. */
function unknownKeys(others: Record<string, unknown>): Problem[] {
  const native = Object.fromEntries(Object.entries(others).filter(([key]) => !legacyKeys.includes(key)))
  const found = walk(encodedInfo, native, "$").filter(
    (item) => !legacyPaths.includes(item.path) && !isLegacyMcp(item.path),
  )
  return found.filter((item, index) => found.findIndex((other) => other.path === item.path) === index)
}

function isLegacyMcp(at: string) {
  const [root, section, name] = at.split(".")
  return root === "$" && section === "mcp" && name !== undefined && !mcpKeys.includes(name)
}

function walk(ast: SchemaAST.AST, value: unknown, at: string): Problem[] {
  const nodes = members(ast)
  if (Array.isArray(value)) {
    const lists = nodes.filter(SchemaAST.isArrays)
    return value.flatMap((item, index) =>
      lists
        .flatMap((list) => list.elements[index] ?? list.rest[0] ?? [])
        .flatMap((type) => walk(type, item, `${at}.${index}`)),
    )
  }
  if (!isRecord(value)) return []
  const structs = nodes.filter(SchemaAST.isObjects)
  if (structs.length === 0) return []
  return Object.entries(value).flatMap(([key, child]) => {
    const types = structs.flatMap((struct) => {
      const field = struct.propertySignatures.find((item) => item.name === key)
      return field ? [field.type] : struct.indexSignatures.map((item) => item.type)
    })
    if (types.length === 0)
      return [{ kind: "unsupported", path: `${at}.${key}`, message: "ignored an unknown key" } satisfies Problem]
    return types.flatMap((type) => walk(type, child, `${at}.${key}`))
  })
}

// The shapes a value may take: the members of a union, followed through lazy references.
function members(ast: SchemaAST.AST): SchemaAST.AST[] {
  if (SchemaAST.isUnion(ast)) return ast.types.flatMap(members)
  if (SchemaAST.isSuspend(ast)) return members(ast.thunk())
  return [ast]
}

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
        if (typeof entry !== "string") {
          bad(`${group}.${key}.${index}`, "ignored an entry that is not a string")
          return []
        }
        if (
          group === "plugins" &&
          key !== "marketplaces" &&
          entry.includes("*") &&
          !PluginRestriction.wildcard(entry)
        ) {
          bad(
            `${group}.${key}.${index}`,
            "ignored a selector whose * is not the whole entry or the end of a .* or /* prefix",
          )
          return []
        }
        if (group !== "network") return [entry]
        // A domain is checked once here, so the matchers only ever see a normalized host or `*.` pattern.
        const domain = ManagedNetwork.pattern(entry)
        if (domain !== undefined) return [domain]
        bad(`${group}.${key}.${index}`, "ignored an entry that is not a host name or a *.domain pattern")
        return []
      })
    })
    const booleanKey = group === "network" ? domainsOnly : group === "mcp" ? mcpOnly : undefined
    const flag = booleanKey === undefined ? undefined : section[booleanKey]
    if (booleanKey === undefined || flag === undefined) {
      value[group] = kept
      return
    }
    if (typeof flag !== "boolean") bad(`${group}.${booleanKey}`, "ignored a value that is not a boolean")
    value[group] = typeof flag === "boolean" ? { ...kept, [booleanKey]: flag } : kept
  })
  const unknown = (at: string) =>
    problems.push({ kind: "unsupported", path: `$.managed.${at}`, message: "ignored an unknown key" })
  const known: readonly string[] = ["organization", "env", ...flags, ...Object.keys(lists)]
  Object.keys(raw)
    .filter((key) => !known.includes(key))
    .forEach(unknown)
  Object.entries(lists).forEach(([group, keys]) => {
    const section = raw[group]
    if (!isRecord(section)) return
    Object.keys(section)
      .filter(
        (key) =>
          !(keys as readonly string[]).includes(key) &&
          !(group === "network" && key === domainsOnly) &&
          !(group === "mcp" && key === mcpOnly),
      )
      .forEach((key) => unknown(`${group}.${key}`))
  })
  if (raw.env !== undefined)
    problems.push({
      kind: "unsupported",
      path: "$.managed.env",
      message: "ignored env here; set it with the top-level env of the managed settings",
    })
  return { value, problems }
}

// Objects merge by key, lists of independent entries concatenate (a list of strings loses its repeats) and any other
// value takes the later one. A `command` is one argument list, and so is a tiered `cost`: joining two files' lists
// would run a command that no file contains. An entry of these records is one definition, as it is across documents
// (`Config.latest` for lsp and formatter, per-name adds for references and commands): a later file's `url` must not
// keep an earlier file's `headers` or `oauth` client secret, an LSP `env` must not reach another server, and a
// `disabled` must not outlive the definition that replaced it. `providers` and `agents` overlay across documents,
// so they merge by key.
const wholeValues = ["command", "cost"]
const wholeEntries = ["lsp", "formatter", "references", "commands"]

function merge(base: unknown, next: unknown, at: readonly string[] = []): unknown {
  if (next === undefined) return base
  if (at.length === 3 && at[0] === "mcp" && at[1] === "servers") return next
  if (at.length === 2 && wholeEntries.includes(at[0])) return next
  // A later agent entry that leaves out `disabled` brings the agent back.
  if (at.length === 2 && at[0] === "agents" && isRecord(base) && isRecord(next) && !("disabled" in next))
    return merge(Object.fromEntries(Object.entries(base).filter(([key]) => key !== "disabled")), next, [...at, ""])
  if (Array.isArray(base) && Array.isArray(next) && !wholeValues.includes(at.at(-1) ?? "")) {
    const all = [...base, ...next]
    return all.every((item) => typeof item === "string") ? [...new Set(all)] : all
  }
  // A model selection is one value: a later file that names a model does not inherit the variant of an earlier one.
  if (isRecord(base) && isRecord(next) && !isSelection(next))
    return Object.fromEntries(
      [...new Set([...Object.keys(base), ...Object.keys(next)])].map((key) => [
        key,
        merge(base[key], next[key], [...at, key]),
      ]),
    )
  return next
}

function isSelection(value: Record<string, unknown>) {
  return typeof value.providerID === "string" && typeof value.model === "string"
}

function isNotFound(error: FSUtil.Error) {
  if (error._tag === "FileSystemError")
    return (
      typeof error.cause === "object" && error.cause !== null && "code" in error.cause && error.cause.code === "ENOENT"
    )
  return error.reason._tag === "NotFound"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The override is the server's own option or environment. An empty or relative one would read the working folder,
// which a repository supplies, so it is refused with one log line and the per-OS default applies.
const resolveDirectory = Effect.fnUntraced(function* (override: string | undefined) {
  const requested = override ?? process.env.ORBIT_MANAGED_DIR
  if (requested && path.isAbsolute(requested)) return requested
  if (override !== undefined || requested)
    yield* Effect.logWarning("ignored a managed settings folder that is not an absolute path", {
      directory: requested,
    })
  return ManagedPath.directory(process.platform, process.env)
})

/**
 * The managed `env` for the server process itself, read once at boot before the application layer exists. The folder is
 * resolved as the managed service resolves it. Orbit's own reserved variable was already dropped when the files decoded.
 */
export const bootEnvironment = Effect.fn("ManagedSettings.bootEnvironment")(function* (override: string | undefined) {
  const snapshot = yield* read(yield* resolveDirectory(override))
  return ConfigEnv.resolve([new Document({ type: "document", info: snapshot.info })])
})

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const watcher = yield* Watcher.Service
      const policy = yield* ManagedPolicy.Service
      const global = yield* Global.Service
      const directory = yield* resolveDirectory(options?.directory)
      const changes = yield* PubSub.unbounded<Snapshot>()
      const reloads = yield* PubSub.sliding<void>(1)

      const load = read(directory).pipe(Effect.provideService(FSUtil.Service, fs))
      const apply = (snapshot: Snapshot) =>
        policy.set("file", {
          statements: snapshot.info.experimental?.policies ?? [],
          rules: ConfigPermissionExpand.expandPermissions(snapshot.info.permissions ?? [], global.home),
          agentRules: Object.fromEntries(
            Object.entries(snapshot.info.agents ?? {}).flatMap(([id, agent]) =>
              agent.permissions === undefined
                ? []
                : [[id, ConfigPermissionExpand.expandPermissions(agent.permissions, global.home)]],
            ),
          ),
          restrictions: snapshot.restrictions,
          mcp: {
            servers: snapshot.info.mcp?.servers ?? {},
            ...(snapshot.info.mcp?.timeout === undefined ? {} : { timeout: snapshot.info.mcp.timeout }),
          },
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
    deps: [FSUtil.node, Watcher.node, ManagedPolicy.node, Global.node],
  })
}

export const node = configured()
