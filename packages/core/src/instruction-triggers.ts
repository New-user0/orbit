export * as InstructionTriggers from "./instruction-triggers.js"

import { dirname, join } from "path"
import { Cause, Clock, Context, Effect, Layer } from "effect"
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

/** The most rule files one read looks at, over all the folders it passes through. */
export const MAX_RULES_PER_READ = ConfigInstructionRules.MAX_FILES

/** How long what a folder held stays good when no rescan came: the next read after that looks at the folder again. */
export const CACHE_MILLIS = 30_000

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

    // What the folders held at a recent read, so that the next read does not walk them again. It is cleared by a rescan, it
    // is keyed by the trust decision, and it ages out, so an edit to a rule shows up within `CACHE_MILLIS`. A load that failed
    // is never kept.
    const scans = new Map<string, { readonly at: number; readonly value: readonly ConfigInstructionRules.Found[] }>()
    const loads = new Map<
      string,
      { readonly at: number; readonly value: Effect.Success<ReturnType<typeof ConfigInstructionFile.load>> }
    >()
    yield* discovery.addRescan(
      Effect.sync(() => {
        scans.clear()
        loads.clear()
      }),
    )
    const remembered = <V, E>(
      store: Map<string, { readonly at: number; readonly value: V }>,
      key: string,
      make: Effect.Effect<V, E>,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const hit = store.get(key)
        if (hit !== undefined && now - hit.at < CACHE_MILLIS) return hit.value
        const value = yield* make
        if (store.size >= 4096) store.clear()
        store.set(key, { at: now, value })
        return value
      })

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
      readonly real: string
      readonly listing: boolean
      /** The rule files this read may still look at, shared by all its folders. */
      readonly budget: { spent: number; warned: boolean }
      readonly open: boolean
    }) {
      const allow = (real: string) => trust.importable(real, real)
      const remaining = MAX_RULES_PER_READ - input.budget.spent
      if (remaining <= 0) {
        if (!input.budget.warned)
          yield* Effect.logWarning("instruction rules skipped", {
            path: input.folder,
            reason: `more than ${MAX_RULES_PER_READ} rule files for one read`,
          })
        input.budget.warned = true
        return []
      }
      const directories = [
        ...CompatInstructions.ruleDirectories(input.compat).map((directory) => join(input.folder, directory)),
        join(input.folder, ".orbit", "rules"),
      ]
      const scanned = (yield* Effect.forEach(directories, (directory) =>
        remembered(scans, `${input.open}|${directory}`, ConfigInstructionRules.scan({ directory, fs, leads: trust.leads, allow })),
      )).flat()
      const eligible = scanned.filter((item) => !ConfigInstructionFile.excluded(input.patterns, [item.file, item.real]))
      const found = eligible.slice(0, remaining)
      input.budget.spent += found.length
      if (eligible.length > found.length && !input.budget.warned) {
        input.budget.warned = true
        yield* Effect.logWarning("instruction rules skipped", {
          path: input.folder,
          reason: `more than ${MAX_RULES_PER_READ} rule files for one read`,
        })
      }
      // One bad rule costs only itself, as it does at the start of the session. Each rule is loaded with a set of its own, so
      // that what it brings does not depend on the rules before it; a file two rules import is handed over once below.
      const loaded = yield* Effect.forEach(found, (item) =>
        remembered(
          loads,
          `${input.open}|${input.compat}|${input.patterns.join("\n")}|${item.real}`,
          ConfigInstructionFile.load({
            path: item.real,
            scope: "project",
            visited: new Set<string>(),
            patterns: input.patterns,
            home: global.home,
            fs,
            rules: true,
            leads: trust.leads,
            allow: (real, spelling) => trust.importable(spelling, real),
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("instruction rule not loaded", { path: item.real, cause }).pipe(Effect.as(undefined)),
          ),
        ),
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
      // The rule files are counted over all the folders of the read, not folder by folder.
      const budget = { spent: 0, warned: false }
      const open = yield* trust.trusted()
      const nested = yield* Effect.forEach(
        [...folders].toReversed(),
        (folder) =>
          Effect.gen(function* () {
            const own = picked
              .filter((item) => dirname(item.file) === folder)
              .map((item) => ({ path: item.real, scope: "project" as const }))
            return [
              ...own,
              ...(yield* nestedRules({ folder, compat, patterns, real, listing: target.listing === true, budget, open })),
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
