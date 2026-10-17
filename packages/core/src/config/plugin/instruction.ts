export * as ConfigInstructionPlugin from "./instruction.js"

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
import { ConfigInstructionFile } from "../instruction-file.js"

// What the files of a source add: the instruction files, and the warnings about them, which are not part of any file.
type Contribution = {
  readonly files: InstructionDiscovery.File[]
  readonly warnings: InstructionDiscovery.Warning[]
}

type Loaded = ({ readonly type: "available" } & Contribution) | { readonly type: "unavailable" }

const nothing: Contribution = { files: [], warnings: [] }

const merge = (contributions: readonly Contribution[]): Contribution => ({
  files: contributions.flatMap((item) => item.files),
  warnings: contributions.flatMap((item) => item.warnings),
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
      const trust = yield* ProjectTrust.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const loaded: { current: Loaded } = { current: { type: "available", ...nothing } }
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

      // Every instruction file goes through the same processing (`ConfigInstructionFile`) before the model reads it. A
      // file with nothing left once its comments and front matter are off adds nothing, and the first name in a directory
      // still wins, so it does not hand its place to the next. A file over the limit is flagged, and loads whole.
      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (path: string) {
        const text = yield* fs.readFileStringSafe(path)
        if (text === undefined) {
          yield* Effect.logDebug("instruction file skipped", { path, reason: "unavailable" })
          return undefined
        }
        const processed = ConfigInstructionFile.parse(text, { frontmatter: true })
        if (processed.content.trim() === "") {
          yield* Effect.logDebug("instruction file left out", { path, reason: "nothing left once processed" })
          return nothing
        }
        return {
          files: [new InstructionDiscovery.File({ path: AbsolutePath.make(path), content: processed.content })],
          warnings: ConfigInstructionFile.oversized(processed.content)
            ? [
                new InstructionDiscovery.Warning({
                  path: AbsolutePath.make(path),
                  kind: "size",
                  characters: processed.content.length,
                  limit: ConfigInstructionFile.LIMIT,
                }),
              ]
            : [],
        }
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* (
        names: readonly string[],
        patterns: readonly string[],
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
        return (yield* read(existing[0].real)) ?? nothing
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* (
        names: readonly string[],
        globalFiles: readonly string[],
        patterns: readonly string[],
      ) {
        if (!project) return nothing
        // An excluded file is as good as absent, so the next name in its directory takes its place. Exclusion comes first,
        // and only takes files out: what is left meets the same gate as before.
        const wanted = yield* ConfigInstructionFile.included(
          patterns,
          yield* fs.up({ targets: [...names], start, stop, type: "file" }),
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
        const walked = found.map((candidate) => candidate.real)
        const discovered = new Set(
          walked
            .filter((file, index) => walked.findIndex((other) => dirname(other) === dirname(file)) === index)
            .filter((file) => discovery.global || !globalFiles.includes(file)),
        )
        const results = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
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
          const names = ConfigInstructionFile.names(yield* config.compatEnabled())
          const globalFiles = yield* Effect.forEach(names, (name) => fs.resolve(join(global.config, name)))
          yield* watch(names, globalFiles)
          // What the settings of every scope exclude as of now. The documents are the stamped ones, so a project that is
          // not trusted has lost its list, which could otherwise hide the user's own instruction files.
          const patterns = yield* ConfigInstructionFile.prepare(
            ConfigInstructionFile.excludes(yield* config.entries()),
            fs.resolve,
          )
          const sources = yield* Effect.all({
            global: isolate("global", globalSource(names, patterns)),
            project: isolate("project", projectSource(names, globalFiles, patterns)),
          })
          loaded.current =
            available(sources.global) && available(sources.project)
              ? { type: "available", ...merge([sources.global, sources.project]) }
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
        for (const warning of loaded.current.warnings) editor.warn(warning)
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
