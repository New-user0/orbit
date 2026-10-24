export * as Config from "./config.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import path from "path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { Context, Effect, FiberMap, Layer, Option, PubSub, Ref, Schema, Semaphore, Stream } from "effect"
import { CompatMcpJson } from "@orbit/compat/mcp-json"
import type { CompatRoots } from "@orbit/compat/roots"
import { CompatSettings } from "@orbit/compat/settings"
import { CompatSwitch } from "@orbit/compat/switch"
import { Directory, Document, Info, type Patch, type Entry, type Scope, Event } from "@orbit/schema/config"
import { Trust } from "@orbit/schema/trust"
import { Credential } from "./credential.js"
import { Bus } from "./bus.js"
import { Watcher } from "./filesystem/watcher.js"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { Global } from "@orbit/util/global"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"
import { ConfigVariable } from "./config/variable.js"
import { ConfigNormalize } from "./config/normalize.js"
import { ConfigDiscovery } from "./config/discovery.js"
import { ConfigWatch } from "./config/watch.js"
import { ConfigTrust } from "./config/trust.js"
import { ManagedSettings } from "./managed-settings.js"
import { WellKnown } from "./wellknown.js"
import { WorkspaceTrust } from "./workspace-trust.js"

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries.findLast((entry): entry is Document => entry.type === "document" && entry.info[key] !== undefined)
    ?.info[key]
}

/** The last document that sets this experimental key decides it; a later block hides only the keys it sets. */
export function experimental<K extends keyof NonNullable<Info["experimental"]>>(entries: readonly Entry[], key: K) {
  return entries.findLast(
    (entry): entry is Document => entry.type === "document" && entry.info.experimental?.[key] !== undefined,
  )?.info.experimental?.[key]
}

/** A root that other agent products keep config in, with what is decided for the folder it belongs to. */
export interface CompatRoot extends CompatRoots.Root {
  /**
   * False when the root is a project's and the folder that holds it is not trusted. Unset means it is not subject to
   * trust: a root of the user's, or one in a trusted folder.
   */
  readonly trusted?: boolean
}

/** Whether Orbit reads other agent products' files, and the roots it reads them from. */
export interface Compat {
  readonly enabled: boolean
  /** The roots that exist now, lowest priority first. None while compatibility is disabled. */
  readonly roots: readonly CompatRoot[]
}

/** What a test config service reports unless it is given another state: enabled, with no roots to read. */
export const defaultCompat: Compat = { enabled: true, roots: [] }

export interface Interface {
  /**
   * Returns location config documents and discovery sources from lowest to highest priority. Entries are grouped by
   * scope in the order remote, user, project, local, flag, then managed, and each entry carries its scope. Within a
   * scope, outer sources come before inner ones. While compatibility is on, the documents that other products' files
   * make, such as hook settings and an MCP file, open the scope they belong to, so Orbit's own documents outrank them.
   *
   * Project and local entries come only from the folders between the Location's folder and the project's root, and only
   * once the project is trusted: nothing above the root is read, even when a grant for a folder there covers the project.
   * A trusted project's entries apply as they are now, whatever changed since the grant. The entries of every other
   * scope are never subject to trust. A grant reloads the config, which publishes `config.updated`.
   */
  readonly entries: () => Effect.Effect<Entry[]>
  /**
   * Whether Orbit reads other agent products' files. It checks nothing on disk, so a caller that needs only the switch,
   * such as the read tool on every read, asks this instead of `compat`.
   */
  readonly compatEnabled: () => Effect.Effect<boolean>
  /**
   * The compatibility switch and the roots consumed by internal compatibility plugins. Checking that each root exists
   * costs a stat per candidate, so ask `compatEnabled` when the roots are not needed. A project's root is stamped
   * `trusted: false` while the folder that holds it is untrusted.
   */
  readonly compat: () => Effect.Effect<Compat>
  /**
   * Streams raw filesystem updates under config roots. Config owns root
   * topology and watch reconciliation; domain owners filter this feed for the
   * source files they parse and rebuild their own state.
   */
  readonly changes: () => Stream.Stream<Watcher.Update>
  /**
   * Reports that the files at `paths` changed, to every `changes()` subscriber, for a server that has no file watcher or
   * a client that wrote a file and does not want to wait for one. It does not reload the config and publishes no
   * `config.updated`, so the services of the location and the asks pending in its sessions are left alone; an owner that
   * does not read one of the paths ignores it. The caller decides which paths count.
   */
  readonly notify: (paths: readonly string[]) => Effect.Effect<void>
  /** Updates supported global config fields while preserving unrelated JSONC content. */
  readonly update?: (patch: Patch) => Effect.Effect<void, FSUtil.Error>
  /**
   * Reads the config again now, and returns once the new entries are in place. A grant for a folder that was not
   * trusted asks it, because nothing of that folder was read before.
   */
  readonly reload?: () => Effect.Effect<void>
  /**
   * The documents of the current load that were not taken as written: one that did not parse or could not be loaded at
   * all, such as a remote one that failed to fetch or a file without read permission (no `keys`), and one that lost
   * top-level keys to normalization (`keys` lists them), from every scope, managed files included. Each still gives
   * what survived. A reader that must not act on a guess, such as retention, asks it.
   */
  readonly rejected: () => Effect.Effect<readonly Rejected[]>
}

export interface Rejected {
  readonly source: string
  readonly scope: Scope
  readonly keys?: readonly string[]
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  // false skips the global config dir, the orbit.json(c), orbit.local.json(c),
  // and .orbit in the home directory, and the compatibility roots in the home
  // directory; wellknown, file, and content entries still load.
  global: Schema.optional(Schema.Boolean),
  file: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@orbit/Config") {}

export interface TestInterface extends Interface {
  /** Replaces the entries returned by subsequent entries() calls. */
  readonly setEntries: (entries: Entry[]) => Effect.Effect<void>
  /** Emits one filesystem update to every changes() subscriber. */
  readonly emitChange: (update: Watcher.Update) => Effect.Effect<void>
  /** Replaces what subsequent rejected() calls return. */
  readonly setRejected: (rejected: readonly Rejected[]) => Effect.Effect<void>
}

export class Test extends Context.Service<Test, TestInterface>()("@orbit/Config/Test") {}

/**
 * In-memory config for tests: static entries with replaceable state and a test-driven change feed. The compatibility
 * state is reported as given and does not follow the entries; by default it is enabled with no roots.
 */
export const testLayer = (initial: Entry[] = [], compat: Compat = defaultCompat) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const entries = yield* Ref.make(initial)
      const rejected = yield* Ref.make<readonly Rejected[]>([])
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const service = Test.of({
        entries: () => Ref.get(entries),
        rejected: () => Ref.get(rejected),
        setRejected: (next) => Ref.set(rejected, next),
        compatEnabled: () => Effect.succeed(compat.enabled),
        compat: () => Effect.succeed(compat),
        changes: () => Stream.fromPubSub(updates),
        notify: (paths) =>
          Effect.forEach(paths, (file) => PubSub.publish(updates, { type: "update" as const, path: file }), { discard: true }),
        setEntries: (next) => Ref.set(entries, next),
        emitChange: (update) => PubSub.publish(updates, update).pipe(Effect.asVoid),
      })
      return Context.empty().pipe(Context.add(Service, service), Context.add(Test, service))
    }),
  )

/** The scopes stamped on a directory's orbit.json(c) documents and on its orbit.local.json(c) documents. */
type Scopes = { readonly base: Scope; readonly local: Scope }
// The user's own directories have no outer tier above them, so their local documents stay in the user scope.
const userScopes: Scopes = { base: "user", local: "user" }
const projectScopes: Scopes = { base: "project", local: "local" }

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const bus = yield* Bus.Service
      const credentials = yield* Credential.Service
      const globalService = yield* Global.Service
      const wellknown = yield* WellKnown.Service
      const trust = yield* WorkspaceTrust.Service
      const managedSettings = yield* ManagedSettings.Service
      // How the project was decided in the load that is running or ran last. A trust change that does not move it leaves
      // the config as it is.
      const decisions = new Map<string, boolean>()
      // The folders that the project's own decision covers: its own, and the main checkout when it is a linked worktree.
      // They are the folders `ProjectTrust` holds the project's config to, so that both bound a read the same way.
      const projectFolders = [
        ...new Set(
          yield* Effect.forEach(
            [location.directory, location.project.directory, location.project.canonical],
            fs.resolve,
          ),
        ),
      ]
      const reloadLock = Semaphore.makeUnsafe(1)
      // What a reload asked for from outside the layer runs with, as the ones the layer starts itself do.
      const context = yield* Effect.context<FSUtil.Service | Global.Service | Location.Service>()
      const updateLock = Semaphore.makeUnsafe(1)
      const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
      const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
      // The documents of the load that is running that were not taken as written, and those of the last load.
      let rejecting: Rejected[] = []
      let rejected: readonly Rejected[] = []
      const parseInfo = Effect.fn("Config.parseInfo")(function* (text: string, source: string, scope: Scope) {
        const errors: ParseError[] = []
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length) {
          rejecting.push({ source, scope })
          yield* Effect.logWarning("configuration normalization diagnostic", {
            source,
            path: "$",
            kind: "invalid",
            action: "rejected malformed JSON or JSONC document",
          })
          return
        }
        const result = ConfigNormalize.normalize(input)
        yield* Effect.forEach(result.diagnostics, (diagnostic) =>
          Effect.logWarning("configuration normalization diagnostic", {
            source,
            path: diagnostic.path[0] === "$" ? "$" : `$.${diagnostic.path.join(".")}`,
            kind: diagnostic.kind,
            action: diagnostic.message,
          }),
        )
        // A root that is not an object has no keys, so it counts as a document that did not parse.
        if (result.type === "rejected") {
          rejecting.push({ source, scope })
          return
        }
        const info = Option.getOrUndefined(decodeInfo(result.encoded))
        // The top-level keys normalization dropped a value of.
        const lost = new Set(
          result.diagnostics.flatMap((item) => (item.kind === "invalid" ? item.path.slice(0, 1) : [])),
        )
        if (lost.size > 0) rejecting.push({ source, scope, keys: [...lost] })
        if (info) return info
        yield* Effect.logWarning("configuration normalization diagnostic", {
          source,
          path: "$",
          kind: "invalid",
          action: "rejected canonical configuration after final validation",
        })
      })

      // A source whose content could not be obtained, such as a remote one that is offline or a file without read
      // permission, is a document of this load that was not taken as written: what it holds is unknown (class 7).
      const unloaded = (source: string, scope: Scope, error: unknown) =>
        Effect.sync(() => rejecting.push({ source, scope })).pipe(
          Effect.andThen(Effect.logWarning("config source could not be loaded", { source, scope, error })),
          Effect.as(undefined),
        )

      // Asks the store once in a load, so the files of one load never disagree about the project.
      const decide = Effect.fnUntraced(function* (root: string) {
        const known = decisions.get(root)
        if (known !== undefined) return known
        const trusted = (yield* trust.status(root)).trusted
        decisions.set(root, trusted)
        return trusted
      })

      // Asks the store every time, for what is wanted outside a load.
      const decideNow = (root: string) => trust.status(root).pipe(Effect.map((status) => status.trusted))

      // Where the config in a folder stands under trust: the project's own folders follow the decision for its root. The
      // folder is placed by the one that holds its config container, so a `.orbit` that is a link stays the project's.
      // Discovery walks no higher than the project's root (D7), so a holder outside the project's folders is one the disk
      // moved after the Location opened, such as a start folder replaced by a link. It is never the project's, and it is
      // never read (`readable`).
      const standing = Effect.fnUntraced(function* (folder: string, ask: (root: string) => Effect.Effect<boolean>) {
        const directory = yield* fs.resolve(folder)
        const holder = yield* fs.resolve(ConfigTrust.holder(folder))
        const inside = projectFolders.some((project) => FSUtil.contains(project, holder))
        const root = location.project.canonical
        return { roots: projectFolders, directory, inside, trusted: inside && (yield* ask(root)) }
      })

      // The sources already reported as skipped, so that a folder nobody trusts is logged once and not at every reload.
      const skipped = new Set<string>()
      // Whether a project or local source may be read at all: as the reference does, nothing a folder supplies is read
      // until the person trusts it (class 1), and nothing outside the project's folders is read (D7). One that is skipped
      // is logged once (class 7).
      const readable = Effect.fnUntraced(function* (source: string, folder: string) {
        const place = yield* standing(folder, decide)
        if (place.trusted) return true
        if (!skipped.has(source)) {
          skipped.add(source)
          yield* Effect.logInfo("config source skipped", {
            path: source,
            reason: place.inside ? "its folder is not trusted" : "it is outside the project's folders",
          })
        }
        return false
      })
      // The project and local sources of a discovery that may be read now, and the rest of it as it is.
      const trustedSources = Effect.fnUntraced(function* (sources: ConfigDiscovery.Sources) {
        const files = (items: readonly AbsolutePath[]) => Effect.filter(items, (item) => readable(item, path.dirname(item)))
        const compatMcp =
          sources.compatMcp !== undefined && (yield* readable(sources.compatMcp, path.dirname(sources.compatMcp)))
            ? sources.compatMcp
            : undefined
        return {
          ...sources,
          direct: yield* files(sources.direct),
          local: yield* files(sources.local),
          project: yield* Effect.filter(sources.project, (root) => readable(root.path, root.path)),
          compat: yield* Effect.filter(sources.compat, (root) =>
            root.scope === "user" ? Effect.succeed(true) : readable(root.path, root.path),
          ),
          compatMcp,
        } satisfies ConfigDiscovery.Sources
      })

      const loadFile = Effect.fnUntraced(function* (filepath: string, scope: Scope) {
        // A file of a project that a link leads to a share is not read: reading connects, before any trust check.
        if ((scope === "project" || scope === "local") && (yield* LinkShare.blocked(fs, filepath))) return
        // A file that is not there is absent, but one that is there and cannot be read holds something unknown: it is a
        // rejected document, so a reader that must not act on a guess, such as retention, does not take the default.
        const text = yield* fs.readFileString(filepath).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
          Effect.catchReason("PlatformError", "PermissionDenied", (error) => unloaded(filepath, scope, error)),
        )
        if (text === undefined) return
        // What the file of an untrusted folder refers to is read before anything decides what to keep of it, so it is
        // held to the folder here: no environment variable is read, and no file outside the folder.
        const place =
          scope === "project" || scope === "local" ? yield* standing(path.dirname(filepath), decide) : undefined
        const substituted = yield* ConfigVariable.substitute({
          type: "path",
          path: filepath,
          text,
          within: place?.trusted === false ? place.roots : undefined,
        })
        const info = yield* parseInfo(substituted, filepath, scope)
        if (!info) return
        return new Document({ type: "document", path: AbsolutePath.make(filepath), scope, info })
      })

      const loadFiles = Effect.fnUntraced(function* (filepaths: readonly string[], scope: Scope) {
        const documents = yield* Effect.forEach(filepaths, (filepath) => loadFile(filepath, scope))
        return documents.filter((document): document is Document => document !== undefined)
      })

      const loadWellknownEntry = Effect.fnUntraced(function* (entry: WellKnown.Entry) {
        const auth = entry.manifest.auth
        if (!auth) return []
        const credential = (yield* credentials.list(entry.integrationID)).at(-1)
        if (!credential || credential.value.type !== "key") return []
        const variables = { [auth.env]: credential.value.key }
        const configs = yield* wellknown
          .resolve(entry, variables)
          .pipe(Effect.catch((error) => unloaded(entry.origin, "remote", error).pipe(Effect.as([] as const))))
        return yield* Effect.forEach(configs, (config) =>
          ConfigVariable.substitute({
            type: "virtual",
            source: entry.origin,
            dir: entry.origin,
            text: JSON.stringify(config),
            env: variables,
          }).pipe(
            Effect.flatMap((text) => parseInfo(text, entry.origin, "remote")),
            Effect.map((info) => (info ? new Document({ type: "document", scope: "remote", info }) : undefined)),
          ),
        ).pipe(Effect.map((documents) => documents.filter((document) => document !== undefined)))
      })

      const loadWellknown = Effect.fn("Config.loadWellknown")(function* () {
        const entries = yield* wellknown
          .entries()
          .pipe(Effect.catch((error) => unloaded("wellknown", "remote", error).pipe(Effect.as([] as const))))
        return yield* Effect.forEach(entries, loadWellknownEntry).pipe(Effect.map((documents) => documents.flat()))
      })

      // Local documents come back apart from the rest: they outrank every base entry, not only their own directory's.
      const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath, scopes: Scopes) {
        const inDirectory = (files: readonly string[]) => files.map((file) => path.join(directory, file))
        return {
          base: [
            ...(yield* loadFiles(inDirectory(ConfigDiscovery.names), scopes.base)),
            new Directory({ type: "directory", path: directory, scope: scopes.base }),
          ],
          local: yield* loadFiles(inDirectory(ConfigDiscovery.localNames), scopes.local),
        }
      })

      const loadLevel = Effect.fnUntraced(function* (level: ConfigDiscovery.Level, scopes: Scopes) {
        const roots = yield* Effect.forEach(
          level.project.filter((root) => root.present),
          (root) => loadDirectory(root.path, scopes),
        )
        return {
          base: [...(yield* loadFiles(level.direct, scopes.base)), ...roots.flatMap((root) => root.base)],
          local: [...(yield* loadFiles(level.local, scopes.local)), ...roots.flatMap((root) => root.local)],
        }
      })

      // Reads only the loaded documents and the environment, never the disk, so asking it is cheap.
      const compatOn = (entries: readonly Entry[]) => CompatSwitch.enabled(entries, process.env)

      // The documents that other products' files make, by the scope they rank in. A file that cannot be used is
      // reported in the shape of a native document's own problems, and costs nothing else.
      const loadCompat = Effect.fn("Config.loadCompat")(function* (sources: ConfigDiscovery.Sources) {
        const settings = yield* CompatSettings.read(sources.compat)
        const mcp = sources.compatMcp
          ? yield* CompatMcpJson.read({ file: sources.compatMcp, env: process.env })
          : { documents: [], diagnostics: [] }
        yield* Effect.forEach(
          [...settings.diagnostics, ...mcp.diagnostics],
          (diagnostic) =>
            Effect.logWarning("configuration normalization diagnostic", {
              source: diagnostic.source,
              path: diagnostic.path[0] === "$" ? "$" : `$.${diagnostic.path.join(".")}`,
              kind: diagnostic.kind,
              action: diagnostic.message,
            }),
          { discard: true },
        )
        // The settings files come first, from the outermost root in, and then the project's MCP file.
        const documents = [...settings.documents, ...mcp.documents]
        const inScope = (scope: Scope) => documents.filter((document) => document.scope === scope)
        return { user: inScope("user"), project: inScope("project"), local: inScope("local") }
      })

      // The entry as it applies: unchanged unless the folder that holds it is untrusted and it is a project's or a local
      // one. A trusted folder's entry applies as it is now, as the reference loads it (D8).
      const stampEntry = Effect.fnUntraced(function* (entry: Entry) {
        if (entry.scope !== "project" && entry.scope !== "local") return entry
        const folder =
          entry.type === "directory"
            ? entry.path
            : entry.path === undefined
              ? location.project.directory
              : path.dirname(entry.path)
        const place = yield* standing(folder, decide)
        return place.trusted ? entry : ConfigTrust.stamp(entry, place)
      })

      // A root of another product carries the verdict for the folder that holds it, unless it is the user's own, which is
      // never subject to trust. The verdict is the store's now, where the entries are those of the last load: whoever asks
      // for the roots right after a grant does not have to wait for a reload.
      // A root of a folder that is not trusted is not listed at all, so nothing reads it.
      const stampRoot = (root: CompatRoots.Root): Effect.Effect<readonly CompatRoot[]> =>
        root.scope === "user"
          ? Effect.succeed([root])
          : standing(root.path, decideNow).pipe(Effect.map((place) => (place.trusted ? [root] : [])))

      const load = Effect.fn("Config.load")(function* (discovered: ConfigDiscovery.Sources) {
        decisions.clear()
        rejecting = []
        const sources = yield* trustedSources(discovered)
        // The files of a folder that is not trusted are not read, but they stay that folder's: naming one as the explicit
        // file must not load it in the flag scope, where the folder's trust no longer applies (class 4).
        const skipped = [
          ...discovered.direct.filter((item) => !sources.direct.includes(item)),
          ...discovered.local.filter((item) => !sources.local.includes(item)),
          ...discovered.project
            .filter((root) => !sources.project.includes(root))
            .flatMap((root) =>
              [...ConfigDiscovery.names, ...ConfigDiscovery.localNames].map((name) => path.join(root.path, name)),
            ),
        ]
        const globalEntries = sources.global
          ? yield* loadDirectory(sources.global, userScopes).pipe(Effect.orDie)
          : undefined
        const homeEntries = sources.home ? yield* loadLevel(sources.home, userScopes).pipe(Effect.orDie) : undefined
        const projectEntries = yield* loadLevel(sources, projectScopes).pipe(Effect.orDie)
        // A file loads once, at the first scope that reached it: naming a project's own file as the explicit file must
        // not load it a second time, unstamped, in the flag scope, where an untrusted folder's trust no longer applies.
        // Compared by real path, folding case where the file system does. On Windows the runtime's own link resolution
        // leaves an 8.3 short name (PROGRA~1) as typed, so the native real path, which expands it, is taken as well.
        // A real path that cannot be read (a folder without search permission) falls back to the lexical path: the read
        // that follows fails the same way and is skipped, so nothing loads twice and nothing dies here.
        const identity = (file: string) =>
          fs.resolve(file).pipe(
            Effect.catchDefect(() => Effect.succeed(path.resolve(file))),
            Effect.map((real) => (process.platform === "win32" ? FSUtil.normalizePath(real).toLowerCase() : real)),
          )
        const explicitFile = sources.explicit
        const explicit = explicitFile
          ? yield* Effect.gen(function* () {
              const explicitIdentity = yield* identity(explicitFile)
              const claimed = [
                ...(yield* Effect.forEach(
                  [globalEntries, homeEntries, projectEntries].flatMap((entries) =>
                    entries ? [...entries.base, ...entries.local] : [],
                  ),
                  (entry) =>
                    entry.type === "document" && entry.path ? identity(entry.path) : Effect.succeed(undefined),
                )),
                ...(yield* Effect.forEach(skipped, identity)),
              ]
              if (claimed.includes(explicitIdentity)) return []
              return yield* loadFile(explicitFile, "flag").pipe(
                Effect.map((config) => (config ? [config] : [])),
                Effect.orDie,
              )
            })
          : []
        const content =
          options?.content !== undefined
            ? yield* ConfigVariable.substitute({
                type: "virtual",
                source: "ORBIT_CONFIG_CONTENT",
                dir: location.directory,
                text: options.content,
              }).pipe(
                Effect.flatMap((text) => parseInfo(text, "ORBIT_CONFIG_CONTENT", "flag")),
                Effect.map((info) => (info ? [new Document({ type: "document", scope: "flag", info })] : [])),
                Effect.orDie,
              )
            : []

        const remote = yield* loadWellknown().pipe(Effect.orDie)
        const user = [globalEntries, homeEntries].flatMap((entries) =>
          entries ? [...entries.base, ...entries.local] : [],
        )
        // The managed document exists only when a managed settings file was read.
        const managedSnapshot = managedSettings.current()
        // A managed file with a problem is a document of this load that was not taken as written, as a native one is: a
        // problem with the whole file (`$`) leaves no keys to look in, and one with a field names its top-level key.
        const invalid = managedSnapshot.diagnostics.filter((diagnostic) => diagnostic.kind === "invalid")
        rejecting.push(
          ...[...new Set(invalid.map((diagnostic) => diagnostic.source))].map((source) => {
            const paths = invalid
              .filter((diagnostic) => diagnostic.source === source)
              .map((diagnostic) => diagnostic.path)
            if (paths.includes("$")) return { source, scope: "managed" as const }
            return { source, scope: "managed" as const, keys: [...new Set(paths.map((at) => at.split(".")[1]))] }
          }),
        )
        const organization =
          managedSnapshot.sources.length > 0
            ? [
                new Document({
                  type: "document",
                  path: AbsolutePath.make(path.join(managedSnapshot.directory, "managed-settings.json")),
                  scope: "managed",
                  info: managedSnapshot.info,
                }),
              ]
            : []
        // Other products' files load only while compatibility is on, and only the native documents decide that, so
        // the switch is read before any of them is.
        const compat = compatOn([
          ...remote,
          ...user,
          ...projectEntries.base,
          ...projectEntries.local,
          ...explicit,
          ...content,
          ...organization,
        ])
          ? yield* loadCompat(sources)
          : { user: [], project: [], local: [] }

        // Scopes rank remote < user < project < local < flag < managed. Within a scope, outer sources come first, base
        // documents before their local counterparts, and ORBIT_CONFIG_CONTENT after the ORBIT_CONFIG file. The
        // documents of other products' files open their scope, so a native document of the same scope outranks them.
        // The managed document is the merge of the managed settings files, and comes last.
        return yield* Effect.forEach(
          [
            ...remote,
            ...compat.user,
            ...user,
            ...compat.project,
            ...projectEntries.base,
            ...compat.local,
            ...projectEntries.local,
            ...explicit,
            ...content,
            ...organization,
          ],
          stampEntry,
        )
      })

      const initial = yield* ConfigDiscovery.discover(options)
      let sources = initial
      let restrictions = managedSettings.current().restrictions
      let configs = yield* load(initial)
      rejected = rejecting
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const reloads = yield* PubSub.sliding<void>(1)
      // Readiness rescans recover writes made before a watch attached.
      const requestReload = PubSub.publish(reloads, undefined).pipe(Effect.asVoid)
      const watched = yield* FiberMap.make<string>()
      // Compatibility sources count only while the switch is on: switched off, they are neither watched nor reported.
      const applicable = (discovered: ConfigDiscovery.Sources, entries: readonly Entry[]) =>
        compatOn(entries) ? discovered : { ...discovered, compat: [], compatSettings: [], compatMcp: undefined }
      const reconcile = Effect.fn("Config.reconcileWatches")(function* (
        sources: ConfigDiscovery.Sources,
        entries: readonly Entry[],
      ) {
        const plan = ConfigWatch.plan(applicable(sources, entries))
        for (const key of Array.from(watched, ([key]) => key)) {
          if (!plan.has(key)) yield* FiberMap.remove(watched, key)
        }
        for (const [key, target] of plan) {
          yield* watcher
            .subscribe(target, requestReload)
            .pipe(
              Effect.flatMap(
                Stream.runForEach((update) => PubSub.publish(updates, update).pipe(Effect.andThen(requestReload))),
              ),
              FiberMap.run(watched, key, { onlyIfMissing: true, startImmediately: true }),
            )
        }
      })

      const reload = Effect.fn("Config.reload")(
        function* () {
          const discovered = yield* ConfigDiscovery.discover(options)
          const nextRestrictions = managedSettings.current().restrictions
          const next = yield* load(discovered)
          rejected = rejecting
          yield* reconcile(discovered, next)
          const compatibilityChanged = !isDeepStrictEqual(
            applicable(sources, configs).compat,
            applicable(discovered, next).compat,
          )
          // Restrictions never enter a document, so an edit that changes only them still has to be announced.
          const restrictionsChanged = !isDeepStrictEqual(restrictions, nextRestrictions)
          if (isDeepStrictEqual(configs, next) && !compatibilityChanged && !restrictionsChanged) return
          sources = discovered
          configs = next
          restrictions = nextRestrictions
          yield* bus.publish(Event.Updated, {})
        },
        (effect) => reloadLock.withPermit(effect),
      )

      // Subscribe eagerly so synchronous watch readiness isn't dropped.
      const pendingReloads = yield* PubSub.subscribe(reloads)
      yield* Stream.fromSubscription(pendingReloads).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* bus.subscribe(Credential.Event.Switched).pipe(
        Stream.filterEffect((event) =>
          wellknown.entries().pipe(
            Effect.map((entries) => entries.some((entry) => entry.integrationID === event.data.integrationID)),
            Effect.orElseSucceed(() => false),
          ),
        ),
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown config", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* managedSettings.changes().pipe(
        Stream.runForEach(() => requestReload),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* bus.subscribe(WellKnown.Event.Updated).pipe(
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown sources", { cause }))),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Trust changes arrive for every folder the server knows. Asking the store again about the folder this config was
      // decided for, rather than comparing paths, settles whether it moved however it was spelled.
      yield* bus.subscribe(Trust.Event.Updated).pipe(
        Stream.filterEffect(() =>
          Effect.forEach([...decisions], ([root, decided]) =>
            trust.status(root).pipe(Effect.map((state) => state.trusted !== decided)),
          ).pipe(Effect.map((moved) => moved.includes(true))),
        ),
        Stream.runForEach(() => requestReload),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Effect.sleep("10 minutes").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (!wellknown.snapshot().length) return Effect.void
            return Effect.gen(function* () {
              const changed = yield* wellknown
                .refresh()
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to refresh wellknown manifests", { error }).pipe(Effect.as(false)),
                  ),
                )
              if (!changed) yield* reload()
            }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to refresh wellknown config", { cause })))
          }),
        ),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* reloadLock.withPermit(reconcile(initial, configs))

      const update = Effect.fn("Config.update")(
        function* (patch: Patch) {
          const directory = initial.global ?? AbsolutePath.make(globalService.config)
          const candidates = ConfigDiscovery.names.map((name) => path.join(directory, name))
          const filepath = (yield* Effect.filter(candidates, fs.isFile)).at(-1) ?? path.join(directory, "orbit.jsonc")
          const text = (yield* fs.readFileStringSafe(filepath)) ?? "{}\n"
          // Only the keys present in the patch change; null removes a key.
          const keys = (["shell", "output_style", "language"] as const).filter((key) => key in patch)
          const updated = yield* Effect.try({
            try: () =>
              keys.reduce(
                (current, key) =>
                  applyEdits(
                    current,
                    modify(current, [key], patch[key] ?? undefined, {
                      formattingOptions: { tabSize: 2, insertSpaces: true },
                    }),
                  ),
                text,
              ),
            catch: (cause) => new FSUtil.FileSystemError({ method: "config.update", cause }),
          })
          yield* fs.writeWithDirs(filepath, updated.endsWith("\n") ? updated : `${updated}\n`)
          yield* requestReload
        },
        (effect) => updateLock.withPermit(effect),
      )

      return Service.of({
        entries: Effect.fnUntraced(function* () {
          return configs
        }),
        compatEnabled: () => Effect.sync(() => compatOn(configs)),
        compat: Effect.fnUntraced(function* () {
          const enabled = compatOn(configs)
          if (!enabled) return { enabled, roots: [] }
          const present = yield* Effect.filter(sources.compat, (root) => fs.isDir(root.path))
          return { enabled, roots: (yield* Effect.forEach(present, stampRoot)).flat() }
        }),
        changes: () => Stream.fromPubSub(updates),
        notify: (paths) =>
          Effect.forEach(paths, (file) => PubSub.publish(updates, { type: "update" as const, path: file }), { discard: true }),
        update,
        rejected: () => Effect.sync(() => rejected),
        reload: () =>
          reload().pipe(
            Effect.catchCause((cause) => Effect.logError("failed to reload config", { cause })),
            Effect.provide(context),
          ),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Watcher.node,
      Bus.node,
      FSUtil.node,
      Global.node,
      Location.node,
      Credential.node,
      ManagedSettings.node,
      WellKnown.node,
      WorkspaceTrust.node,
    ],
  })
}

export const node = configured()
