export * as ConfigInstructionPlugin from "./instruction.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Trust } from "@orbit/schema/trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { basename, dirname, join, relative } from "path"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"
import { ManagedSettings } from "../../managed-settings.js"
import { ProjectTrust } from "../../project-trust.js"
import { AbsolutePath } from "../../schema.js"
import { ConfigInstructionFile } from "../instruction-file.js"

// What the files of a source add: the instruction files, and the warnings about them, which are not part of any file. The
// imports say which of the files another one imported, and `read` the real path of every import that was read.
type Contribution = {
  readonly files: InstructionDiscovery.File[]
  readonly warnings: (InstructionDiscovery.Warning | InstructionDiscovery.ImportWarning)[]
  readonly imports: InstructionDiscovery.Import[]
  readonly read: string[]
}

type Loaded = ({ readonly type: "available" } & Contribution) | { readonly type: "unavailable" }

const nothing: Contribution = { files: [], warnings: [], imports: [], read: [] }

const merge = (contributions: readonly Contribution[]): Contribution => ({
  files: contributions.flatMap((item) => item.files),
  warnings: contributions.flatMap((item) => item.warnings),
  imports: contributions.flatMap((item) => item.imports),
  read: contributions.flatMap((item) => item.read),
})

const available = (source: Contribution | Instructions.Unavailable): source is Contribution =>
  source !== Instructions.unavailable

export const Plugin = define({
  id: "orbit.config.instruction",
  effect: Effect.fn(function* (ctx) {
    const discovery = yield* InstructionDiscovery.Service
    // Nothing this plugin watches or loads can contribute when both scopes
    // are disabled; skip the resolves, the watcher fiber, and the transform.
    if (!discovery.project && !discovery.global) return
    yield* Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const managed = yield* ManagedSettings.Service
      const trust = yield* ProjectTrust.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      // A worktree inside its main checkout: the walk passes through the main checkout's folders above the worktree, whose
      // shared files the worktree has its own copy of. Its local files are not checked in, so only the main checkout has them.
      const canonical = yield* fs.resolve(location.project.canonical)
      const nested = relative(canonical, root) !== "" && FSUtil.contains(canonical, root)
      const inherited = (directory: string) => nested && FSUtil.contains(canonical, directory) && !FSUtil.contains(root, directory)
      // The one folder the managed settings were read from, so that the instruction file and the settings never disagree.
      const managedDirectory = managed.current().directory
      const managedFile = managedDirectory === "" ? undefined : join(managedDirectory, "ORBIT.md")
      const loaded: { current: Loaded } = { current: { type: "available", ...nothing } }
      // One fiber for each path that is watched. The instruction files that could exist stay watched once they are,
      // and the imports that were read are watched for as long as something imports them.
      const watches = yield* FiberMap.make<string>()
      const watched = new Set<string>()
      const watchedImports = new Set<string>()

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      const subscribe = Effect.fnUntraced(function* (path: string) {
        const updates = yield* watcher.subscribe({ path, type: "file" })
        yield* FiberMap.run(watches, path, updates.pipe(Stream.runForEach(publish)), {
          onlyIfMissing: true,
          startImmediately: true,
        })
      })
      // Which names to look for follows the compatibility switch, so every refresh resolves it again and watches any
      // name it has newly enabled. Names that were switched off are left watched, and ignored when loading.
      const watch = Effect.fn("ConfigInstructionPlugin.watch")(function* (
        names: readonly string[],
        globalFiles: readonly string[],
      ) {
        // The ancestor walk can reach the global file when the location sits
        // beneath the global config dir; global: false excludes it there too.
        const candidates = [
          ...(managedFile === undefined ? [] : [managedFile]),
          ...(discovery.global ? globalFiles : []),
          ...(project
            ? ancestorDirectories(start, stop)
                .flatMap((directory) => names.map((name) => join(directory, name)))
                .filter((file) => discovery.global || !globalFiles.includes(file))
            : []),
        ]
        for (const path of new Set(candidates)) {
          if (watched.has(path)) continue
          watched.add(path)
          // Already watched as an import: the fiber keeps running, and is now this one's.
          if (watchedImports.delete(path)) continue
          yield* subscribe(path)
        }
      })

      // The real path of every import that was read is watched, and one that nothing imports any more is not. Only the
      // set changes, so an edit that lands while it does is never lost to a clear and a new subscription. A path that was
      // refused or is not there is never in `wanted`, so a refused path is never watched.
      const watchImports = Effect.fn("ConfigInstructionPlugin.watchImports")(function* (wanted: readonly string[]) {
        const next = new Set(wanted.filter((path) => !watched.has(path)))
        for (const path of watchedImports) {
          if (next.has(path)) continue
          watchedImports.delete(path)
          yield* FiberMap.remove(watches, path)
        }
        for (const path of next) {
          if (watchedImports.has(path)) continue
          watchedImports.add(path)
          yield* subscribe(path)
        }
      })

      // Every instruction file goes through the same processing (`ConfigInstructionFile`) before the model reads it, and
      // so does each file that it imports. A file with nothing left once its comments and front matter are off adds nothing,
      // and the first name in a directory still wins, so it does not hand its place to the next. A file over the limit is
      // flagged, and loads whole. `visited` is the one set of the pass, shared by every file in it.
      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (
        path: string,
        scope: "user" | "project",
        visited: Set<string>,
        patterns: readonly string[],
        // What the file is, and so what every file it imports is: an import takes its importer's kind.
        kind?: InstructionDiscovery.Kind,
      ) {
        const loaded = yield* ConfigInstructionFile.load({
          path,
          scope,
          visited,
          patterns,
          home: global.home,
          fs,
          leads: trust.leads,
          // A project file imports what is inside the project, whatever the trust decision, and only what the trust
          // decision lets the project supply: both are asked of the real path, which is the file that is read. What is
          // outside waits for the folder that holds the importing file to be trusted (`outward`).
          allow: (real, spelling) => trust.importable(spelling, real),
          // The managed file is held by an administrator's folder, which says nothing about the project it is read for:
          // what it imports from outside the project waits for the project itself to be trusted.
          outward:
            kind === "managed"
              ? () =>
                  trust.trusted().pipe(
                    Effect.map((open) => ({ open, directory: location.project.canonical })),
                  )
              : trust.outward,
        })
        if (loaded === undefined) {
          yield* Effect.logDebug("instruction file skipped", { path, reason: "unavailable" })
          return undefined
        }
        return {
          files: loaded.files.map(
            (item) =>
              new InstructionDiscovery.File({
                path: AbsolutePath.make(item.path),
                content: item.content,
                ...(kind === undefined ? {} : { kind }),
              }),
          ),
          warnings: [
            ...loaded.files.flatMap((item) =>
              ConfigInstructionFile.oversized(item.content)
                ? [
                    new InstructionDiscovery.Warning({
                      path: AbsolutePath.make(item.path),
                      kind: "size",
                      characters: item.content.length,
                      limit: ConfigInstructionFile.LIMIT,
                    }),
                  ]
                : [],
            ),
            ...loaded.skipped.map(
              (item) =>
                new InstructionDiscovery.ImportWarning({
                  path: AbsolutePath.make(item.importer),
                  kind: "import",
                  target: AbsolutePath.make(item.target),
                  ...(item.directory === undefined ? {} : { directory: AbsolutePath.make(item.directory) }),
                }),
            ),
          ],
          imports: loaded.files.flatMap((item) =>
            item.importedBy === undefined
              ? []
              : [
                  new InstructionDiscovery.Import({
                    path: AbsolutePath.make(item.path),
                    importedBy: AbsolutePath.make(item.importedBy),
                  }),
                ],
          ),
          read: loaded.read,
        }
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* (
        names: readonly string[],
        patterns: readonly string[],
        visited: Set<string>,
      ) {
        if (!discovery.global) return nothing
        // An excluded file is as good as absent, so the next name takes its place.
        const candidates = yield* ConfigInstructionFile.included(
          patterns,
          names.map((name) => join(global.config, name)),
          fs.resolve,
        )
        const existing = yield* Effect.filter(candidates, (candidate) => fs.isFile(candidate.real))
        if (!existing[0]) return nothing
        return (yield* read(existing[0].real, "user", visited, patterns)) ?? nothing
      })

      // The administrator's file. It is read whatever the project's trust decision is and whichever scopes are on, because the
      // folder is theirs and not the repository's, and no pattern of `instructions_exclude` applies to it or to what it
      // imports. A file that is there and cannot be read makes the source unavailable, so that policy text already admitted
      // is never dropped for a read that failed.
      const managedSource = Effect.fn("ConfigInstructionPlugin.managedSource")(function* (
        file: string | undefined,
        visited: Set<string>,
      ) {
        if (file === undefined || !(yield* fs.isFile(file))) return nothing
        const loaded = yield* read(yield* fs.resolve(file), "project", visited, [], "managed")
        if (loaded !== undefined) return loaded
        yield* Effect.logWarning("managed instruction file could not be read", { path: file })
        return Instructions.unavailable
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* (
        compat: boolean,
        globalFiles: readonly string[],
        patterns: readonly string[],
        visited: Set<string>,
      ) {
        if (!project) return nothing
        // An excluded file is as good as absent, so the next name in its slot takes its place. Exclusion comes first,
        // and only takes files out: what is left meets the same gate as before.
        const wanted = yield* ConfigInstructionFile.included(
          patterns,
          yield* fs.up({ targets: [...ConfigInstructionFile.walkNames(compat)], start, stop, type: "file" }),
          fs.resolve,
        )
        // Until the project is trusted it supplies only what is inside it. A link in a repository to a key or a
        // credentials file would otherwise put that file into the first request, and the folders above the project are
        // not the repository's to vouch for. A file that is left out is as good as absent, so the next name in its
        // directory takes its place.
        const found = yield* Effect.filter(wanted, (candidate) =>
          trust.reachable(candidate.file).pipe(
            Effect.tap((reachable) =>
              reachable
                ? Effect.void
                : Effect.logWarning("instruction file skipped", {
                    path: candidate.file,
                    reason: "outside the project, which is not trusted",
                  }),
            ),
          ),
        )
        // General to specific: the farthest directory first, and in each the shared file and then the local one. A slot
        // for the directory's rule files goes between the two when rules arrive.
        const locals = ConfigInstructionFile.localNames(compat)
        const discovered = ConfigInstructionFile.pick(found, {
          compat,
          file: (candidate) => candidate.file,
          skipShared: inherited,
        }).filter((candidate) => discovery.global || !globalFiles.includes(candidate.real))
        // One at a time, in render order: a file that two of them import is loaded after the first and not again.
        const results = yield* Effect.forEach(discovered, (candidate) =>
          read(
            candidate.real,
            "project",
            visited,
            patterns,
            locals.includes(basename(candidate.file)) ? "local" : undefined,
          ),
        )
        const contributions = results.filter((item): item is Contribution => item !== undefined)
        if (contributions.length < results.length) return Instructions.unavailable
        return merge(contributions)
      })

      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load instruction source", { source, cause }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (file?: string) {
          const compat = yield* config.compatEnabled()
          const names = ConfigInstructionFile.names(compat)
          const globalFiles = yield* Effect.forEach(names, (name) => fs.resolve(join(global.config, name)))
          yield* watch(ConfigInstructionFile.walkNames(compat), globalFiles)
          // What the settings of every scope exclude as of now. The documents are the stamped ones, so a project that is
          // not trusted has lost its list, which could otherwise hide the user's own instruction files.
          const patterns = yield* ConfigInstructionFile.prepare(
            ConfigInstructionFile.excludes(yield* config.entries()),
            fs.resolve,
          )
          // The files handled so far in this pass, which the global file and the project's share, so that a file that is
          // imported and also found by the walk is loaded once, where it comes first. The sources load one after the other.
          const visited = new Set<string>()
          const sources = yield* Effect.all({
            managed: isolate("managed", managedSource(managedFile, visited)),
            global: isolate("global", globalSource(names, patterns, visited)),
            project: isolate("project", projectSource(compat, globalFiles, patterns, visited)),
          })
          loaded.current =
            available(sources.managed) && available(sources.global) && available(sources.project)
              ? { type: "available", ...merge([sources.managed, sources.global, sources.project]) }
              : { type: "unavailable" }
          yield* watchImports(loaded.current.type === "available" ? loaded.current.read : [])
          if (!file) return
          yield* Effect.logDebug("instructions rescanned", {
            file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
        },
        (effect, ..._args: [file?: string]) => lock.withPermit(effect),
      )

      // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
      // before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Turning compatibility on or off arrives as a config update, not as a file change.
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() => refresh().pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // A grant or a revoke changes what the project may supply. The config does not reload for a project that has none
      // of its own, so this does not wait for a config update.
      yield* bus.subscribe(Trust.Event.Updated).pipe(
        Stream.runForEach(() => refresh().pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* refresh()
      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        for (const file of loaded.current.files) editor.add(file)
        for (const warning of loaded.current.warnings) editor.warn(warning)
        for (const item of loaded.current.imports) editor.imported(item.path, item.importedBy)
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

// Compare through relative() so Windows paths that differ only in drive-letter case match, and never walk past the
// filesystem root: an unreachable stop would otherwise recurse until the stack overflows.
function ancestorDirectories(start: string, stop: string): string[] {
  if (relative(stop, start) === "" || dirname(start) === start) return [start]
  return [start, ...ancestorDirectories(dirname(start), stop)]
}
