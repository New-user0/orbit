export * as InstructionTriggers from "./instruction-triggers.js"

import { dirname, join } from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { CompatInstructions } from "@orbit/compat/instructions"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Config } from "./config.js"
import { ConfigInstructionFile } from "./config/instruction-file.js"
import { ConfigInstructionRules } from "./config/instruction-rules.js"
import { InstructionDiscovery } from "./instruction-discovery.js"
import { Location } from "./location.js"
import { ProjectTrust } from "./project-trust.js"
import { AbsolutePath } from "./schema.js"
import { SessionInstructions } from "./session/instructions.js"
import { SessionSchema } from "./session/schema.js"

export interface Target {
  readonly path: string
  /** The path is a folder the model listed: its own instruction file counts, not only those above it. */
  readonly listing?: boolean
}

export interface Interface {
  /**
   * A file or folder reached the model through a tool. The instruction files of the folders between the folder the
   * session started in (exclusive) and the target are handed to the session, outermost folder first. It never fails: what
   * goes wrong here costs the nested files, not the tool call that triggered it.
   */
  readonly touched: (input: {
    readonly sessionID: SessionSchema.ID
    readonly targets: ReadonlyArray<Target>
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/InstructionTriggers") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const discovery = yield* InstructionDiscovery.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const instructions = yield* SessionInstructions.Service
    const trust = yield* ProjectTrust.Service

    // Whether a rule that waits for a read is about this file. Both the folder the patterns are matched from and the file are
    // real paths (class 4), and a rule the file is not inside the folder of does not apply to it.
    const applies = (rule: InstructionDiscovery.ConditionalRule, real: string) =>
      fs.resolve(rule.base).pipe(Effect.map((base) => ConfigInstructionFile.ruleMatches(rule.patterns, base, real)))

    // The rules of the folders that a read passed through, from what the folders hold now. They are told apart by their own
    // front matter, as at the start of the session: a rule with no patterns, and a plain file that a waiting rule imports,
    // apply to every read below the folder, and a rule with patterns only to a read that matches them.
    const nestedRules = Effect.fnUntraced(function* (input: {
      readonly folder: string
      readonly compat: boolean
      readonly patterns: readonly string[]
      readonly visited: Set<string>
      readonly real: string
      readonly listing: boolean
    }) {
      const allow = (real: string) => trust.importable(real, real)
      const directories = [
        ...CompatInstructions.ruleDirectories(input.compat).map((directory) => join(input.folder, directory)),
        join(input.folder, ".orbit", "rules"),
      ]
      const found = (yield* Effect.forEach(directories, (directory) =>
        ConfigInstructionRules.scan({ directory, fs, leads: trust.leads, allow }),
      ))
        .flat()
        .filter((item) => !ConfigInstructionFile.excluded(input.patterns, [item.file, item.real]))
      const loaded = yield* Effect.forEach(found, (item) =>
        ConfigInstructionFile.load({
          path: item.real,
          scope: "project",
          visited: input.visited,
          patterns: input.patterns,
          home: global.home,
          fs,
          rules: true,
          leads: trust.leads,
          allow: (real, spelling) => trust.importable(spelling, real),
        }),
      )
      const groups = loaded.flatMap((item) => (item === undefined ? [] : [item.files]))
      const always: SessionInstructions.Entry[] = groups.flatMap((files) =>
        // A rule that waits brings none of its imports, so the plain ones are handed over on their own.
        files.flatMap((file) =>
          file.patterns === undefined && (file.importedBy === undefined || files[0]?.patterns !== undefined)
            ? [{ path: file.path, scope: "project" as const, rule: true }]
            : [],
        ),
      )
      if (input.listing) return always
      const waiting = yield* Effect.filter(
        groups.flat().filter((file) => file.patterns !== undefined),
        (file) =>
          applies(
            new InstructionDiscovery.ConditionalRule({
              path: AbsolutePath.make(file.path),
              patterns: file.patterns!,
              base: AbsolutePath.make(input.folder),
              scope: "project",
            }),
            input.real,
          ),
      )
      return [
        ...always,
        ...waiting.map((file) => ({ path: file.path, scope: "project" as const, patterns: file.patterns })),
      ]
    })

    const walk = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, target: Target) {
      const root = yield* fs.resolve(location.directory)
      const real = yield* fs.resolve(target.path)
      // Only what is inside the folder the session started in: a file outside it brings nothing. Both paths are real, so a
      // link cannot make a file outside look inside, or the other way round.
      if (real === root || !FSUtil.contains(root, real)) return
      const compat = yield* config.compatEnabled()
      const conditional = target.listing ? [] : yield* discovery.conditionalRules()
      const matching = (scope: InstructionDiscovery.ConditionalRule["scope"]) =>
        Effect.filter(
          conditional.filter((rule) => rule.scope === scope),
          (rule) => applies(rule, real),
        ).pipe(
          Effect.map((rules) =>
            rules.map((rule) => ({
              path: rule.path as string,
              scope,
              patterns: rule.patterns,
              rule: true,
              ...(scope === "project" ? { base: rule.base as string } : {}),
            })),
          ),
        )
      // The administrator's rules and the person's come first, then the folders the read went through, from the outermost
      // down, then the project's rules at the start folder and above it, which the start did not show.
      const outer = [...(yield* matching("managed")), ...(yield* matching("user"))]
      const inner = yield* matching("project")

      const start = target.listing ? real : dirname(real)
      const folders = new Set<string>()
      for (let folder = start; folder !== root && FSUtil.contains(root, folder); folder = dirname(folder)) folders.add(folder)
      const discovered =
        folders.size === 0
          ? []
          : yield* fs.up({
              targets: [...ConfigInstructionFile.walkNames(compat)],
              start,
              stop: root,
              type: "file",
            })
      // A name that the settings exclude is as good as absent, as it is when the session starts, so the next name in its
      // folder is the one that loads. `SessionInstructions` asks again for every path it is given.
      const patterns = yield* ConfigInstructionFile.prepare(
        ConfigInstructionFile.excludes(yield* config.entries()),
        fs.resolve,
      )
      const candidates = (yield* ConfigInstructionFile.included(patterns, discovered, fs.resolve)).filter((item) =>
        folders.has(dirname(item.file)),
      )
      // Each folder gives the first of its shared names and the first of its local names, as it does when the session
      // starts, and a local file loads beside a shared one or alone. The file being read is dropped after that choice, not
      // before it: reading a folder's first file must not bring the second. The model reads the outermost folder's files
      // first, and in a folder the shared file before the local one.
      const picked = ConfigInstructionFile.pick(candidates, { compat, file: (item) => item.file }).filter(
        (item) => item.real !== real,
      )
      // One set of handled files for the read, so that a file two rules import is handed over once.
      const visited = new Set<string>()
      const nested = yield* Effect.forEach(
        [...folders].toReversed(),
        (folder) =>
          Effect.gen(function* () {
            const own = picked
              .filter((item) => dirname(item.file) === folder)
              .map((item) => ({ path: item.real, scope: "project" as const }))
            return [
              ...own,
              ...(yield* nestedRules({ folder, compat, patterns, visited, real, listing: target.listing === true })),
            ]
          }),
      )
      const entries = [...outer, ...nested.flat(), ...inner].filter((entry) => entry.path !== real).filter(
        (entry, index, all) => all.findIndex((other) => other.path === entry.path) === index,
      )
      if (entries.length === 0) return
      yield* instructions.load({ sessionID, entries })
    })

    return Service.of({
      touched: Effect.fn("InstructionTriggers.touched")(function* (input) {
        // `--bare` and a vanilla instance read nothing about the project, and a file the model reads is no exception.
        if (!discovery.project) return
        for (const target of input.targets)
          yield* walk(input.sessionID, target).pipe(
            Effect.catch((error) => Effect.logDebug("nested instruction files not loaded", { error })),
            Effect.catchDefect((defect) => Effect.logDebug("nested instruction files not loaded", { defect })),
          )
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-triggers",
  layer,
  deps: [
    Config.node,
    FSUtil.node,
    Global.node,
    InstructionDiscovery.node,
    Location.node,
    ProjectTrust.node,
    SessionInstructions.node,
  ],
})
