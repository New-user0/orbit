export * as ConfigTrust from "./trust.js"

import path from "path"
import { Directory, Document, Info, type Entry } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { ConfigCommand } from "@orbit/schema/config/command"
import type { ConfigWebSearch } from "@orbit/schema/config/websearch"
import type { Permission } from "@orbit/schema/permission"
import { Trust } from "@orbit/schema/trust"
import { FSUtil } from "@orbit/util/fs-util"

// Config from a folder that is not trusted yet. Consumers read whole values with `Config.latest`, and project and local
// documents outrank the user's, so a partial value from a repository could replace one the user set. Whatever a
// repository could use to run code, spend money or reach the network is therefore withheld whole, and a field that
// cannot do any of that is kept as written. A few fields are kept in part: a deny rule only tightens what is allowed.

/** What is left of a value once what an untrusted folder may not supply is taken out, and the kinds of what went. */
interface Outcome<V> {
  /** Unset when nothing is left. The same value, not a copy, when nothing was taken out. */
  readonly value: V | undefined
  readonly withheld: readonly Trust.Kind[]
}

/** How one field is treated while its folder is untrusted. */
type Treatment<V> =
  /** Harmless as written: it cannot run code, spend money or reach the network. */
  | { readonly type: "inert" }
  /** Withheld whole, even when empty, because the user's value must stay visible to `Config.latest`. */
  | { readonly type: "withhold"; readonly kind: Trust.Kind }
  /** Kept whole, but reported when `when` holds, because a later step refuses to run what it names. */
  | { readonly type: "flag"; readonly kind: Trust.Kind; readonly when: (value: V) => boolean }
  /** Kept in part. */
  | { readonly type: "filter"; readonly apply: (value: V) => Outcome<V> }

/** A treatment for every field of T, so that a field added to the schema does not compile until it is classified. */
type Table<T> = { readonly [K in keyof T]-?: Treatment<NonNullable<T[K]>> }

/** T while it is being built. */
type Draft<T> = { -readonly [K in keyof T]?: T[K] }

const inert = { type: "inert" } as const
const withhold = (kind: Trust.Kind) => ({ type: "withhold", kind }) as const
const flag = <V>(kind: Trust.Kind, when: (value: V) => boolean) => ({ type: "flag", kind, when }) as const
const filter = <V>(apply: (value: V) => Outcome<V>) => ({ type: "filter", apply }) as const

/**
 * A command in a template that runs when the command is used: an exclamation mark and a command in backticks. The
 * regular expression is global, so test it with `search` or `split`, never `test`.
 */
export const shellSnippet = /!`([^`]+)`/g

export function hasShellSnippet(template: string) {
  return template.search(shellSnippet) >= 0
}

/** Anything written as `scheme://`, whether it is fetched over the network or read from disk. */
function isUrl(entry: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(entry)
}

// An ask or allow rule can shadow a deny the user wrote, because the last matching rule wins, and then be approved.
function denyRules(rules: Permission.Ruleset): Outcome<Permission.Ruleset> {
  const denies = rules.filter((rule) => rule.effect === "deny")
  if (denies.length === rules.length) return { value: rules, withheld: [] }
  return { value: denies.length === 0 ? undefined : denies, withheld: ["permissions"] }
}

function instructionPaths(entries: readonly string[]): Outcome<readonly string[]> {
  const paths = entries.filter((entry) => !isUrl(entry))
  if (paths.length === entries.length) return { value: entries, withheld: [] }
  return { value: paths.length === 0 ? undefined : paths, withheld: ["network"] }
}

// Turning web search off stays possible, because the user's own provider selection is what it would otherwise mask.
function webSearch(selection: ConfigWebSearch.Selection): Outcome<ConfigWebSearch.Selection> {
  return selection === false ? { value: selection, withheld: [] } : { value: undefined, withheld: ["network"] }
}

function agents(
  value: Readonly<Record<string, ConfigAgent.Info>>,
): Outcome<Readonly<Record<string, ConfigAgent.Info>>> {
  const results = Object.entries(value).map(
    ([name, agent]) => [name, walk(agent, classification.agent, (fields) => new ConfigAgent.Info(fields))] as const,
  )
  const withheld = results.flatMap(([, result]) => result.withheld)
  if (results.every(([name, result]) => result.value === value[name])) return { value, withheld }
  return { value: Object.fromEntries(results.map(([name, result]) => [name, result.value])), withheld }
}

function commands(
  value: Readonly<Record<string, ConfigCommand.Info>>,
): Outcome<Readonly<Record<string, ConfigCommand.Info>>> {
  // No command field is withheld, so a command is never rebuilt: its snippets are only reported.
  const results = Object.values(value).map((command) => walk(command, classification.command, () => command))
  return { value, withheld: results.flatMap((result) => result.withheld) }
}

/**
 * The classification of every field that a folder's config can set, for Config.Info and for the two records nested
 * in it that hold more than a value: agents and commands. The completeness test checks it against the schema.
 */
export const classification = {
  info: {
    $schema: inert,
    shell: withhold("shell"),
    model: inert,
    default_agent: inert,
    output_style: inert,
    update: withhold("network"),
    share: withhold("network"),
    enterprise: withhold("network"),
    username: inert,
    permissions: filter(denyRules),
    agents: filter(agents),
    snapshots: inert,
    watcher: inert,
    hooks: withhold("hooks"),
    formatter: withhold("formatter"),
    lsp: withhold("lsp"),
    media: inert,
    sandbox: withhold("sandbox"),
    tool_output: inert,
    mcp: withhold("mcp"),
    compaction: inert,
    // The switch reads only the user's, the flag's and the organization's documents, so a repository cannot set it.
    compatibility: inert,
    skills: withhold("settings"),
    commands: filter(commands),
    instructions: filter(instructionPaths),
    references: withhold("settings"),
    websearch: filter(webSearch),
    plugins: withhold("plugins"),
    worktree: withhold("settings"),
    warming: inert,
    providers: withhold("providers"),
    experimental: withhold("settings"),
  } satisfies Table<Info>,
  agent: {
    model: inert,
    // Extra headers and body fields reach the provider, whose tools and endpoints they can change.
    request: withhold("providers"),
    system: inert,
    description: inert,
    mode: inert,
    hidden: inert,
    color: inert,
    steps: inert,
    disabled: inert,
    permissions: filter(denyRules),
  } satisfies Table<ConfigAgent.Info>,
  command: {
    // A snippet runs a command, and a later step refuses to; the rest of the template is only text.
    template: flag("commands", hasShellSnippet),
    description: inert,
    agent: inert,
    model: inert,
    subagent: inert,
    subtask: inert,
  } satisfies Table<ConfigCommand.Info>,
}

export interface Result {
  readonly info: Info
  /** In the order of `Trust.Kinds`, each once. */
  readonly withheld: readonly Trust.Kind[]
}

/** What an untrusted folder's document may contribute, and the kinds of what it may not. */
export function sanitize(info: Info): Result {
  const result = walk(info, classification.info, (fields) => new Info(fields))
  return { info: result.value, withheld: result.withheld }
}

function walk<T extends object>(
  value: T,
  table: Table<T>,
  make: (fields: Draft<T>) => T,
): { readonly value: T; readonly withheld: readonly Trust.Kind[] } {
  const kinds = new Set<Trust.Kind>()
  const kept: Draft<T> = {}
  let changed = false

  const visit = <K extends keyof T>(name: K) => {
    const field = value[name]
    if (field === undefined || field === null) return
    // A field the table does not know came from a newer schema, so it is held back like any other unknown setting.
    const treatment: Treatment<NonNullable<T[K]>> | undefined = table[name]
    if (treatment === undefined) {
      kinds.add("settings")
      changed = true
      return
    }
    if (treatment.type === "withhold") {
      kinds.add(treatment.kind)
      changed = true
      return
    }
    if (treatment.type === "filter") {
      const outcome = treatment.apply(field)
      for (const kind of outcome.withheld) kinds.add(kind)
      if (outcome.value !== field) changed = true
      if (outcome.value !== undefined) kept[name] = outcome.value
      return
    }
    if (treatment.type === "flag" && treatment.when(field)) kinds.add(treatment.kind)
    kept[name] = field
  }
  for (const name of Object.keys(value) as (keyof T)[]) visit(name)

  return {
    value: changed ? make(kept) : value,
    withheld: Trust.Kinds.filter((kind) => kinds.has(kind)),
  }
}

/**
 * The entry as it applies while its folder is untrusted. The project and local entries are stamped `trusted: false`,
 * and a document keeps only what it may contribute and lists what it lost. The user's, the flag's, the organization's
 * and the remote entries are never subject to trust.
 */
export function stamp(entry: Entry): Entry {
  if (entry.scope !== "project" && entry.scope !== "local") return entry
  if (entry.type === "directory") return new Directory({ ...entry, trusted: false })
  const sanitized = sanitize(entry.info)
  return new Document({ ...entry, info: sanitized.info, trusted: false, withheld: sanitized.withheld })
}

/**
 * Whether a file may run the code it carries, such as the hooks in a skill's or an agent's front matter: not when
 * the innermost config source around it is untrusted. A source covers the folder it sits in, and the config of a
 * project covers the whole folder it configures, so the `.orbit` directory of a project covers the project. Only
 * entries carry a verdict, so a folder with no config entry at all is not covered by this.
 */
export function allows(entries: readonly Entry[], file: string) {
  const around = entries.flatMap((entry) => {
    const root = covered(entry)
    return root !== undefined && FSUtil.contains(root, file) ? [{ root, trusted: entry.trusted !== false }] : []
  })
  // The sources that are no further out than any other around the file; the others are overruled by them.
  const innermost = around.filter((item) => around.every((other) => FSUtil.contains(other.root, item.root)))
  return innermost.every((item) => item.trusted)
}

function covered(entry: Entry) {
  const location =
    entry.type === "directory" ? entry.path : entry.path === undefined ? undefined : path.dirname(entry.path)
  if (location === undefined) return undefined
  const project = entry.scope === "project" || entry.scope === "local"
  return project && path.basename(location) === ".orbit" ? path.dirname(location) : location
}
