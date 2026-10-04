export * as Config from "./config.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import path from "path"
import { isDeepStrictEqual } from "node:util"
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser"
import { Context, Effect, FiberMap, Layer, Option, PubSub, Ref, Schema, Semaphore, Stream } from "effect"
import type { CompatRoots } from "@orbit/compat/roots"
import { CompatSwitch } from "@orbit/compat/switch"
import { Directory, Document, Info, type Patch, type Entry, type Scope, Event } from "@orbit/schema/config"
import { Credential } from "./credential.js"
import { Bus } from "./bus.js"
import { Watcher } from "./filesystem/watcher.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"
import { ConfigVariable } from "./config/variable.js"
import { ConfigNormalize } from "./config/normalize.js"
import { ConfigDiscovery } from "./config/discovery.js"
import { ConfigWatch } from "./config/watch.js"
import { WellKnown } from "./wellknown.js"

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries.findLast((entry): entry is Document => entry.type === "document" && entry.info[key] !== undefined)
    ?.info[key]
}

/** Whether Orbit reads other agent products' files, and the roots it reads them from. */
export interface Compat {
  readonly enabled: boolean
  /** The roots that exist now, lowest priority first. None while compatibility is disabled. */
  readonly roots: readonly CompatRoots.Root[]
}

/** What a config service that leaves `compat` unimplemented reports: enabled, with no roots to read. */
export const defaultCompat: Compat = { enabled: true, roots: [] }

export interface Interface {
  /**
   * Returns location config documents and discovery sources from lowest to highest priority. Entries are grouped by
   * scope in the order remote, user, project, local, flag, then managed, and each entry carries its scope. Within a
   * scope, outer sources come before inner ones.
   */
  readonly entries: () => Effect.Effect<Entry[]>
  /** The compatibility switch and the roots consumed by internal compatibility plugins. Read it with `compatOf`. */
  readonly compat?: () => Effect.Effect<Compat>
  /**
   * Streams raw filesystem updates under config roots. Config owns root
   * topology and watch reconciliation; domain owners filter this feed for the
   * source files they parse and rebuild their own state.
   */
  readonly changes: () => Stream.Stream<Watcher.Update>
  /** Updates supported global config fields while preserving unrelated JSONC content. */
  readonly update?: (patch: Patch) => Effect.Effect<void, FSUtil.Error>
}

/** The compatibility state of a config service, which a minimal service may leave unimplemented. */
export const compatOf = (config: Interface) => (config.compat ? config.compat() : Effect.succeed(defaultCompat))

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
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const service = Test.of({
        entries: () => Ref.get(entries),
        compat: () => Effect.succeed(compat),
        changes: () => Stream.fromPubSub(updates),
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
      const reloadLock = Semaphore.makeUnsafe(1)
      const updateLock = Semaphore.makeUnsafe(1)
      const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
      const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
      const parseInfo = Effect.fn("Config.parseInfo")(function* (text: string, source: string) {
        const errors: ParseError[] = []
        const input: unknown = parse(text, errors, { allowTrailingComma: true })
        if (errors.length) {
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
        if (result.type === "rejected") return
        const info = Option.getOrUndefined(decodeInfo(result.encoded))
        if (info) return info
        yield* Effect.logWarning("configuration normalization diagnostic", {
          source,
          path: "$",
          kind: "invalid",
          action: "rejected canonical configuration after final validation",
        })
      })

      const loadFile = Effect.fnUntraced(function* (filepath: string, scope: Scope) {
        const text = yield* fs.readFileStringSafe(filepath)
        if (text === undefined) return
        const substituted = yield* ConfigVariable.substitute({ type: "path", path: filepath, text })
        const info = yield* parseInfo(substituted, filepath)
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
          .pipe(
            Effect.catch(() =>
              Effect.logWarning("failed to load wellknown config", { source: entry.origin }).pipe(
                Effect.as([] as const),
              ),
            ),
          )
        return yield* Effect.forEach(configs, (config) =>
          ConfigVariable.substitute({
            type: "virtual",
            source: entry.origin,
            dir: entry.origin,
            text: JSON.stringify(config),
            env: variables,
          }).pipe(
            Effect.flatMap((text) => parseInfo(text, entry.origin)),
            Effect.map((info) => (info ? new Document({ type: "document", scope: "remote", info }) : undefined)),
          ),
        ).pipe(Effect.map((documents) => documents.filter((document) => document !== undefined)))
      })

      const loadWellknown = Effect.fn("Config.loadWellknown")(function* () {
        const entries = yield* wellknown
          .entries()
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to discover wellknown config", { error }).pipe(Effect.as([] as const)),
            ),
          )
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

      const load = Effect.fn("Config.load")(function* (sources: ConfigDiscovery.Sources) {
        const globalEntries = sources.global
          ? yield* loadDirectory(sources.global, userScopes).pipe(Effect.orDie)
          : undefined
        const homeEntries = sources.home ? yield* loadLevel(sources.home, userScopes).pipe(Effect.orDie) : undefined
        const projectEntries = yield* loadLevel(sources, projectScopes).pipe(Effect.orDie)
        const explicit = sources.explicit
          ? yield* loadFile(sources.explicit, "flag").pipe(
              Effect.map((config) => (config ? [config] : [])),
              Effect.orDie,
            )
          : []
        const content =
          options?.content !== undefined
            ? yield* ConfigVariable.substitute({
                type: "virtual",
                source: "ORBIT_CONFIG_CONTENT",
                dir: location.directory,
                text: options.content,
              }).pipe(
                Effect.flatMap((text) => parseInfo(text, "ORBIT_CONFIG_CONTENT")),
                Effect.map((info) => (info ? [new Document({ type: "document", scope: "flag", info })] : [])),
                Effect.orDie,
              )
            : []

        // Scopes rank remote < user < project < local < flag; the managed scope is reserved to load after all of
        // them. Within a scope, outer sources come first, base documents before their local counterparts, and
        // ORBIT_CONFIG_CONTENT after the ORBIT_CONFIG file.
        return [
          ...(yield* loadWellknown().pipe(Effect.orDie)),
          ...[globalEntries, homeEntries].flatMap((user) => (user ? [...user.base, ...user.local] : [])),
          ...projectEntries.base,
          ...projectEntries.local,
          ...explicit,
          ...content,
        ]
      })

      const initial = yield* ConfigDiscovery.discover(options)
      let sources = initial
      let configs = yield* load(initial)
      const updates = yield* PubSub.unbounded<Watcher.Update>()
      const reloads = yield* PubSub.sliding<void>(1)
      // Readiness rescans recover writes made before a watch attached.
      const requestReload = PubSub.publish(reloads, undefined).pipe(Effect.asVoid)
      const watched = yield* FiberMap.make<string>()
      // Compatibility roots count only while the switch is on: switched off, they are neither watched nor reported.
      const applicable = (discovered: ConfigDiscovery.Sources, entries: readonly Entry[]) =>
        CompatSwitch.enabled(entries, process.env) ? discovered : { ...discovered, compat: [] }
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
          const next = yield* load(discovered)
          yield* reconcile(discovered, next)
          const compatibilityChanged = !isDeepStrictEqual(
            applicable(sources, configs).compat,
            applicable(discovered, next).compat,
          )
          if (isDeepStrictEqual(configs, next) && !compatibilityChanged) return
          sources = discovered
          configs = next
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
      yield* bus.subscribe(WellKnown.Event.Updated).pipe(
        Stream.runForEach(() =>
          reload().pipe(Effect.catchCause((cause) => Effect.logError("failed to reload wellknown sources", { cause }))),
        ),
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
          const keys = (["shell", "output_style"] as const).filter((key) => key in patch)
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
        compat: Effect.fnUntraced(function* () {
          const enabled = CompatSwitch.enabled(configs, process.env)
          return { enabled, roots: enabled ? yield* Effect.filter(sources.compat, (root) => fs.isDir(root.path)) : [] }
        }),
        changes: () => Stream.fromPubSub(updates),
        update,
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Watcher.node, Bus.node, FSUtil.node, Global.node, Location.node, Credential.node, WellKnown.node],
  })
}

export const node = configured()
