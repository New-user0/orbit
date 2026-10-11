export * as ConfigPluginSource from "./source.js"

import { Directory, Document, type Entry } from "@orbit/schema/config"
import { ConfigPlugin } from "@orbit/schema/config/plugin"
import { FSUtil } from "@orbit/util/fs-util"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, Effect, Layer, Option, PubSub, Scope, Stream } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { Location } from "../../location.js"
import { PluginSourceDirectory } from "../../plugin/source-directory.js"

export type Operation =
  | {
      readonly type: "add"
      readonly target: string
      readonly options: Record<string, unknown>
      readonly mtime?: number
    }
  | {
      readonly type: "remove"
      readonly target: string
    }

export interface Interface {
  readonly operations: () => Effect.Effect<readonly Operation[], never, Scope.Scope>
  readonly changes: () => Stream.Stream<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ConfigPluginSource") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const watcher = yield* Watcher.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const configuredChanges = yield* PubSub.unbounded<void>()
    const watched = new Set<string>()

    // Configured local plugins can live outside config roots, where the
    // config change feed cannot see them; watch those targets directly.
    // Watches start on first sighting and are never torn down individually:
    // a stale watch after a config edit costs one deduped fs handle and a
    // no-op activation, and every watch dies with this layer's scope.
    const watchConfiguredSources = Effect.fn("ConfigPluginSource.watchConfiguredSources")(function* (
      entries: readonly Entry[],
      operations: readonly Operation[],
    ) {
      for (const operation of operations) {
        if (operation.type !== "add" || !path.isAbsolute(operation.target)) continue
        if (watched.has(operation.target)) continue
        // The config change feed already covers {plugin,plugins} directories.
        if (isPluginSource(entries, operation.target)) continue
        watched.add(operation.target)
        const updates = yield* watcher.subscribe({
          path: operation.target,
          type: (yield* fs.isDir(operation.target)) ? "directory" : "file",
        })
        yield* updates.pipe(
          Stream.runForEach(() => PubSub.publish(configuredChanges, undefined)),
          Effect.catchCause((cause) =>
            Effect.logError("configured plugin watch failed", { target: operation.target, cause }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
      }
    })

    return Service.of({
      operations: Effect.fn("ConfigPluginSource.operations")(function* () {
        const entries = yield* config.entries()
        const operations = yield* scan(fs, location, entries, config.pluginsChanged)
        yield* watchConfiguredSources(entries, operations)
        return operations
      }),
      changes: () =>
        Stream.merge(
          config.changes().pipe(
            Stream.filterEffect((update) =>
              Effect.map(config.entries(), (entries) => isPluginSource(entries, update.path)),
            ),
            Stream.map(() => undefined),
          ),
          Stream.fromPubSub(configuredChanges),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Watcher.node, Location.node],
})

export const empty = makeLocationNode({
  service: Service,
  layer: Layer.succeed(
    Service,
    Service.of({
      operations: () => Effect.succeed([]),
      changes: () => Stream.never,
    }),
  ),
  deps: [],
})

function parse(input: ConfigPlugin.Plugin): Operation {
  if (typeof input !== "string") {
    return { type: "add", target: input.package, options: input.options ?? {} }
  }
  if (!input.startsWith("-")) return { type: "add", target: input, options: {} }
  if (input.length === 1) throw new Error("Plugin remove operation requires a target")
  return { type: "remove", target: input.slice(1) }
}

const scan = Effect.fn("ConfigPluginSource.scan")(function* (
  fs: FSUtil.Interface,
  location: Location.Interface,
  entries: readonly Entry[],
  pluginsChanged: (directory: string) => Effect.Effect<boolean>,
) {
  const discovered = yield* Effect.forEach(
    // A plugin runs in this process, so the plugins a folder keeps wait for the folder to be trusted, and for the
    // trust again when they change after it. Trusting it reloads the config, which makes the supervisor activate again.
    entries.filter(
      (entry): entry is Directory =>
        entry.type === "directory" && entry.trusted !== false && entry.withheld?.includes("plugins") !== true,
    ),
    (entry) =>
      // This runs when a file under the directory changes, which is before the config reloads and so before its
      // entry says so: a plugin added after the grant must not be activated in that gap.
      pluginsChanged(entry.path).pipe(
        Effect.flatMap((changed) => (changed ? Effect.succeed([]) : discoverHeld(fs, location, entry))),
        Effect.map((targets) => targets.map((target): Operation => ({ type: "add", target, options: {} }))),
      ),
  ).pipe(Effect.map((items) => items.flat()))
  const configured = entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) =>
      (entry.info.plugins ?? []).map(parse).map((operation) => {
        if (operation.type === "remove") return operation
        const directory = entry.path ? path.dirname(entry.path) : location.directory
        const target = operation.target.startsWith("file://")
          ? fileURLToPath(operation.target)
          : operation.target.startsWith("./") || operation.target.startsWith("../")
            ? path.resolve(directory, operation.target)
            : operation.target
        return { ...operation, target }
      }),
    )
  const resolved = yield* Effect.forEach(configured, (operation) =>
    Effect.gen(function* () {
      if (operation.type === "remove" || !path.isAbsolute(operation.target)) return Option.some(operation)
      if (yield* fs.isFile(operation.target)) {
        yield* Effect.logWarning("configured plugin path must be a directory", { target: operation.target })
        return Option.none<Operation>()
      }
      return Option.some<Operation>(operation)
    }),
  ).pipe(Effect.map((operations) => operations.flatMap(Option.toArray)))
  // Explicit config is applied last so it can remove auto-discovered packages.
  return yield* Effect.forEach([...discovered, ...resolved], (operation) =>
    Effect.gen(function* () {
      if (operation.type === "remove" || !path.isAbsolute(operation.target)) return [operation]
      if (!(yield* fs.existsSafe(operation.target))) return [operation]
      const entrypoints = yield* PluginSourceDirectory.entrypoints(fs, operation.target)
      if (!entrypoints) return []
      const times = yield* Effect.forEach(
        [...entrypoints.files, entrypoints.manifest],
        (entry) =>
          fs.stat(entry).pipe(
            Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
            Effect.orElseSucceed(() => 0),
          ),
      )
      return [{ ...operation, mtime: Math.max(...times) }]
    }),
  ).pipe(Effect.map((operations) => operations.flat()))
})

// The plugins a config directory keeps. Those of a project stay inside the folders its trust is decided for, once every
// link is followed, because the fingerprints compare only what lies inside them: a plugin that a link leads out would
// otherwise change without the folder being asked again. A directory above the project is held to itself.
const discoverHeld = Effect.fnUntraced(function* (fs: FSUtil.Interface, location: Location.Interface, entry: Directory) {
  const targets = yield* PluginSourceDirectory.discover(fs, entry.path)
  if (entry.scope !== "project" && entry.scope !== "local") return targets
  const folders = [location.directory, location.project.directory, location.project.canonical]
  const bound = yield* Effect.forEach(
    folders.some((folder) => FSUtil.contains(folder, entry.path)) ? folders : [entry.path],
    (folder) => fs.resolve(folder),
  )
  return yield* Effect.filter(targets, (target) =>
    fs.resolve(target).pipe(
      Effect.map((real) => bound.some((folder) => FSUtil.contains(folder, real))),
      Effect.tap((stays) =>
        stays ? Effect.void : Effect.logWarning("plugin skipped", { path: target, reason: "it leads out of the folder it is in" }),
      ),
    ),
  )
})

function isPluginSource(entries: readonly Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      PluginSourceDirectory.names.some((directory) => FSUtil.contains(path.join(entry.path, directory), file)),
  )
}
