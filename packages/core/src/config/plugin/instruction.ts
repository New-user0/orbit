export * as ConfigInstructionPlugin from "./instruction.js"

import { CompatInstructions } from "@orbit/compat/instructions"
import { define } from "@orbit/plugin/effect/plugin"
import { Trust } from "@orbit/schema/trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { dirname, join, relative } from "path"
import { Effect, PubSub, Semaphore, Stream } from "effect"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"
import { ProjectTrust } from "../../project-trust.js"
import { AbsolutePath } from "../../schema.js"

type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

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
      const trust = yield* ProjectTrust.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const loaded: { current: Loaded } = { current: { type: "available", files: [] } }
      const watched = new Set<string>()

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      // Which names to look for follows the compatibility switch, so every refresh resolves it again and watches any
      // name it has newly enabled. Names that were switched off are left watched, and ignored when loading.
      const watch = Effect.fn("ConfigInstructionPlugin.watch")(function* (
        names: readonly string[],
        globalFiles: readonly string[],
      ) {
        // The ancestor walk can reach the global file when the location sits
        // beneath the global config dir; global: false excludes it there too.
        const candidates = [
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
          const updates = yield* watcher.subscribe({ path, type: "file" })
          yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
        }
      })

      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (path: string) {
        const content = yield* fs.readFileStringSafe(path)
        if (content !== undefined) return new InstructionDiscovery.File({ path: AbsolutePath.make(path), content })
        yield* Effect.logDebug("instruction file skipped", { path, reason: "unavailable" })
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* (
        globalFiles: readonly string[],
      ) {
        if (!discovery.global) return []
        const existing = yield* Effect.filter(globalFiles, (file) => fs.isFile(file))
        if (!existing[0]) return []
        const file = yield* read(existing[0])
        return file ? [file] : []
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* (
        names: readonly string[],
        globalFiles: readonly string[],
      ) {
        if (!project) return []
        // Until the project is trusted it supplies only what is inside it. A link in a repository to a key or a
        // credentials file would otherwise put that file into the first request, and the folders above the project are
        // not the repository's to vouch for. A file that is left out is as good as absent, so the next name in its
        // directory takes its place.
        const found = yield* Effect.filter(yield* fs.up({ targets: [...names], start, stop, type: "file" }), (file) =>
          trust.reachable(file).pipe(
            Effect.tap((reachable) =>
              reachable
                ? Effect.void
                : Effect.logWarning("instruction file skipped", {
                    path: file,
                    reason: "outside the project, which is not trusted",
                  }),
            ),
          ),
        )
        const walked = yield* Effect.forEach(found, fs.resolve)
        const discovered = new Set(
          walked
            .filter((file, index) => walked.findIndex((other) => dirname(other) === dirname(file)) === index)
            .filter((file) => discovery.global || !globalFiles.includes(file)),
        )
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        return files.filter((file): file is InstructionDiscovery.File => file !== undefined)
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
          const names = CompatInstructions.filenames(yield* config.compatEnabled())
          const globalFiles = yield* Effect.forEach(names, (name) => fs.resolve(join(global.config, name)))
          yield* watch(names, globalFiles)
          const sources = yield* Effect.all({
            global: isolate("global", globalSource(globalFiles)),
            project: isolate("project", projectSource(names, globalFiles)),
          })
          loaded.current =
            Array.isArray(sources.global) && Array.isArray(sources.project)
              ? { type: "available", files: [...sources.global, ...sources.project] }
              : { type: "unavailable" }
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
