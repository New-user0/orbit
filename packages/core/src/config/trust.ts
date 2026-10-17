export * as ConfigTrust from "./trust.js"

import path from "path"
import { CompatNames } from "@orbit/compat/names"
import { Directory, Document, Info, type Entry } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { ConfigCommand } from "@orbit/schema/config/command"
import { ConfigToolExecution } from "@orbit/schema/config/tool-execution"
import type { ConfigWarming } from "@orbit/schema/config/warming"
import type { ConfigWebFetch } from "@orbit/schema/config/webfetch"
import type { ConfigWebSearch } from "@orbit/schema/config/websearch"
import type { Permission } from "@orbit/schema/permission"
import { Trust } from "@orbit/schema/trust"
import { FSUtil } from "@orbit/util/fs-util"

// Config from a folder that is not trusted yet. Consumers read whole values with `Config.latest`, and project and local
// documents outrank the user's, so a partial value from a repository could replace one the user set. Whatever a
// repository could use to run code, spend money or reach the network is therefore withheld whole, and a field that
// cannot do any of that is kept as written. A few fields are kept in part: a deny rule only tightens what is allowed.
//
// The files in a config directory are held to the same decision, each where it is read. The config stamps the directory
// `trusted: false`, and then a plugin file is not loaded (`ConfigPluginSource`), a command runs no shell snippet and
// names no agent (`ConfigCommandPlugin`), and an agent file is cut down with `sanitize` (`ConfigAgentPlugin`). Skills and
// output styles are text, so they stay available: `ConfigMarkdown` reads front matter as YAML or JSON and refuses
// JavaScript, so no Markdown file runs just by being read. Anything else that would run what a file carries, such as the
// hooks in the front matter of a skill or an agent, must ask `allows` first.
//
// What a file points at is held to the folder as well, so that a link in a repository does not carry a file of the user's
// to the model provider, or have a tool write one. A `{file:}` reference in the config is read only inside it
// (`ConfigVariable`). Every other reader of a file that the repository supplies asks `ProjectTrust` before it reads one,
// and these are the readers, so that the next one added has a list to join:
//
// - `reachable`: an instruction file (`ConfigInstructionPlugin`, `SessionInstructions`). Both then process the text with
//   `ConfigInstructionFile.parse`, which takes the front matter off with `ConfigMarkdown.split`, by its delimiter lines
//   alone and without parsing it, and leave out what `instructions_exclude` names, a list that an untrusted folder does
//   not supply. The files they import with `@path` (`ConfigInstructionFile.load`) are readers of the same list: a
//   project file's import must lie inside the folder the session started in or a project folder that can be trusted
//   for good (the started folder also counts once it is trusted, so home and filesystem roots count only then) and pass `reachable`, and a network path is refused;
// - `supplies`: a file of a config directory, or of another product's root, which is the agents of `ConfigAgentPlugin`,
//   the commands of `ConfigCommandPlugin`, the skills of `ConfigSkillPlugin` and `ConfigCompatibilityPlugin`, and the
//   output styles of `OutputStylePlugin`;
// - `escapes`: the path that a file tool is given (`FileAccess`), which asks about the folder a link leads to, as for any
//   path outside the project.
//
// One reader cannot ask, because a Location, and `ProjectTrust` with it, exists only once the project is known: the one
// that finds the project. `GitLayout` (`Project.resolve`, `LocationWatcher`) reads a folder's `.git`, the `commondir` and
// `gitdir` files of its worktree entry, and the shared `config` for one URL. It opens only what git itself wrote for the
// folder, never reads through a `.git` that is a link or opens a share, bounds every read, and starts git for a folder only
// once `WorkspaceTrust` trusts it.
//
// A folder that was trusted is held to its config as the grant saw it. `Config` digests the executable parts of every
// project and local source (`Fingerprint`), `WorkspaceTrust.compare` says which kinds differ from the grant's record, and
// `partial` cuts those kinds from that source alone: a document loses the fields, a directory lists `withheld`, which the
// readers below ask. `Fingerprint` reads only inside the folders that `supplies` holds the config to (the project's
// folders, or what `reach` gives above it), before trust as after: what leads out is named with its links, never read, and a
// network path is not touched.
// The readers of a directory that carries code ask `ProjectTrust.allows(file, kind)`:
//
// - `plugins`: `ConfigPluginSource`, which also compares again when it scans;
// - `hooks` and `mcp` of skill and agent front matter: whoever runs them (hooks-21, agents-extensibility-9).

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
  | { readonly type: "filter"; readonly apply: (value: V, place: Place) => Outcome<V> }

/** A treatment for every field of T, so that a field added to the schema does not compile until it is classified. */
type Table<T> = { readonly [K in keyof T]-?: Treatment<NonNullable<T[K]>> }

/** T while it is being built. */
type Draft<T> = { -readonly [K in keyof T]?: T[K] }

/** Where a document sits, for the paths it names. */
export interface Place {
  /** The folders its paths may point into: the ones trust is decided for. */
  readonly roots: readonly string[]
  /** The folder its relative paths are read from. */
  readonly directory: string
}

const inert = { type: "inert" } as const
const withhold = (kind: Trust.Kind) => ({ type: "withhold", kind }) as const
const flag = <V>(kind: Trust.Kind, when: (value: V) => boolean) => ({ type: "flag", kind, when }) as const
const filter = <V>(apply: (value: V, place: Place) => Outcome<V>) => ({ type: "filter", apply }) as const

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

// A path stays inside when it is read from the document's own folder and lands in one of the folders trust is decided
// for. Home is not one of them, and neither is a network share, which `\\host\share` and `//host/share` both name.
function inside(place: Place, entry: string) {
  if (entry === "~" || entry.startsWith("~/") || entry.startsWith("~\\") || /^[\\/]{2}/.test(entry)) return false
  const resolved = path.resolve(place.directory, entry)
  return place.roots.some((root) => FSUtil.contains(root, resolved))
}

// An ask or allow rule can shadow a deny the user wrote, because the last matching rule wins, and then be approved.
function denyRules(rules: Permission.Ruleset): Outcome<Permission.Ruleset> {
  const denies = rules.filter((rule) => rule.effect === "deny")
  if (denies.length === rules.length) return { value: rules, withheld: [] }
  return { value: denies.length === 0 ? undefined : denies, withheld: ["permissions"] }
}

// A URL is fetched, and a path outside the folder is a file that is not the repository's to name: once something reads
// these, either would put what it finds into the prompt.
function instructionPaths(entries: readonly string[], place: Place): Outcome<readonly string[]> {
  const paths = entries.filter((entry) => !isUrl(entry))
  const kept = paths.filter((entry) => inside(place, entry))
  if (kept.length === entries.length) return { value: entries, withheld: [] }
  const withheld: Trust.Kind[] = [
    ...(paths.length === entries.length ? [] : ["network" as const]),
    ...(kept.length === paths.length ? [] : ["settings" as const]),
  ]
  return { value: kept.length === 0 ? undefined : kept, withheld }
}

// Turning web search off stays possible, because the user's own provider selection is what it would otherwise mask.
function webSearch(selection: ConfigWebSearch.Selection): Outcome<ConfigWebSearch.Selection> {
  return selection === false ? { value: selection, withheld: [] } : { value: undefined, withheld: ["network"] }
}

// A listed host's Markdown pages reach the model unanswered, so a repository cannot add one. An empty list only
// tightens, and is kept.
function webFetch(value: ConfigWebFetch.Info): Outcome<ConfigWebFetch.Info> {
  if (!value.verbatim_hosts || value.verbatim_hosts.length === 0) return { value, withheld: [] }
  return { value: undefined, withheld: ["settings"] }
}

// Keep-alive requests are generations that are paid for, and nothing bounds how often a repository could ask for one.
// Only turning them off is kept, for the reason that applies to web search.
function warming(selection: boolean | ConfigWarming.Info): Outcome<boolean | ConfigWarming.Info> {
  return selection === false ? { value: selection, withheld: [] } : { value: undefined, withheld: ["network"] }
}

// A lower cap only slows work down, but a higher one lets a repository start more tool calls at once than the user
// allowed. The user's own value is not visible here, so only a cap at or below the default is kept.
function toolExecution(value: ConfigToolExecution.Info): Outcome<ConfigToolExecution.Info> {
  if (value.max_concurrency === undefined || value.max_concurrency <= ConfigToolExecution.DEFAULT_MAX_CONCURRENCY)
    return { value, withheld: [] }
  return { value: undefined, withheld: ["settings"] }
}

// A slash command in the text would run a command that nobody typed.
function initialPrompt(value: string): Outcome<string> {
  return value.trimStart().startsWith("/") ? { value: undefined, withheld: ["commands"] } : { value, withheld: [] }
}

function agents(
  value: Readonly<Record<string, ConfigAgent.Info>>,
  place: Place,
): Outcome<Readonly<Record<string, ConfigAgent.Info>>> {
  const results = Object.entries(value).map(([name, agent]) => ({
    name,
    agent,
    result: walk(agent, classification.agent, place, (fields) => new ConfigAgent.Info(fields)),
  }))
  const withheld = results.flatMap((item) => item.result.withheld)
  // A disabled agent ignores the rest of its entry. What is left of the entry once `disabled` is taken out must not
  // stand in for it: for a name nobody defined, it would be a new agent that allows everything.
  const kept = results.filter((item) => item.agent.disabled !== true)
  if (kept.length === results.length && kept.every((item) => item.result.value === item.agent)) {
    return { value, withheld }
  }
  return {
    value: kept.length === 0 ? undefined : Object.fromEntries(kept.map((item) => [item.name, item.result.value])),
    withheld,
  }
}

/**
 * What an untrusted folder's commands keep: the template, which only a later step refuses to run when it holds a shell
 * snippet, and what only describes the command. The agent a command names is taken out, so that running it leaves the
 * session as it is. The commands of a document and those of the files in a `.orbit` directory are cut down alike.
 */
export function sanitizeCommands(
  value: Readonly<Record<string, ConfigCommand.Info>>,
  place: Place,
): Outcome<Readonly<Record<string, ConfigCommand.Info>>> {
  const results = Object.entries(value).map(([name, command]) => ({
    name,
    command,
    result: walk(
      command,
      classification.command,
      place,
      (fields) => new ConfigCommand.Info({ ...fields, template: command.template }),
    ),
  }))
  const withheld = results.flatMap((item) => item.result.withheld)
  if (results.every((item) => item.result.value === item.command)) return { value, withheld }
  return { value: Object.fromEntries(results.map((item) => [item.name, item.result.value])), withheld }
}

/**
 * The classification of every field that a folder's config can set, for Config.Info and for the two records nested
 * in it that hold more than a value: agents and commands. The completeness test checks it against the schema.
 */
export const classification = {
  info: {
    $schema: inert,
    shell: withhold("shell"),
    // It can put PATH, NODE_OPTIONS, LD_PRELOAD, proxies, CA bundles or provider keys into every program Orbit starts.
    env: withhold("env"),
    // A model, a provider or a budget is paid for by the user, and the owner decided that an untrusted folder cannot pick one.
    model: withhold("providers"),
    fallback_model: withhold("providers"),
    // The names small and large pick the models that agents run on, which the user pays for. The owner chose to withhold it.
    model_aliases: withhold("providers"),
    output_token_cap: withhold("providers"),
    // It can only drop the git snapshot, and the snapshot runs only in a trusted folder anyway.
    git_status: inert,
    // Which agent a session starts as decides which permission rules apply to it.
    default_agent: withhold("permissions"),
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
    // The clone's own instruction files already steer commit format, and the value is an indented literal block.
    attribution: inert,
    sandbox: withhold("sandbox"),
    // A budget: a tiny timeout turns every command into a background job whose completion wakes the session for a paid
    // request, and the atomic value would replace the user's own.
    shell_tool: withhold("providers"),
    tool_output: inert,
    tool_execution: filter(toolExecution),
    mcp: withhold("mcp"),
    compaction: inert,
    // The switch reads only the user's, the flag's and the organization's documents, so a repository cannot set it.
    compatibility: inert,
    skills: withhold("skills"),
    commands: filter(sanitizeCommands),
    instructions: filter(instructionPaths),
    // The lists of every scope are combined, so a repository's list would hide the user's own instruction files from the
    // model. Withheld whole, even when empty, as the other lists are.
    instructions_exclude: withhold("settings"),
    references: withhold("settings"),
    websearch: filter(webSearch),
    webfetch: filter(webFetch),
    plugins: withhold("plugins"),
    worktree: withhold("settings"),
    warming: filter(warming),
    providers: withhold("providers"),
    experimental: withhold("settings"),
  } satisfies Table<Info>,
  agent: {
    // Titles, side queries and subagents run without anyone choosing the agent, and a model is paid for by the user.
    model: withhold("providers"),
    // Extra headers and body fields reach the provider, whose tools and endpoints they can change.
    request: withhold("providers"),
    system: inert,
    description: inert,
    // What an agent may be used for decides which rules apply to the work: a primary agent is out of the model's reach
    // as a subagent, and a repository that changed this for an agent of the user's would put it there.
    mode: withhold("permissions"),
    // A session that names no agent starts as the first one that is neither a subagent nor hidden, so a repository that
    // hid the agents ahead of one of the user's would start every session as that one. It also decides which subagents
    // the model is told about.
    hidden: withhold("permissions"),
    color: inert,
    // A step allowance is a budget on the user's spend, so it is held back like the model.
    steps: withhold("providers"),
    max_turns: withhold("providers"),
    // A thinking budget is paid for by the user, like the model.
    effort: withhold("providers"),
    // The allow list chooses the tools and, through the one that starts agents, other agents.
    tools: withhold("permissions"),
    // It only removes tools, as a deny rule does.
    disallowed_tools: inert,
    permission_mode: withhold("permissions"),
    // An MCP server is a program to start or a server of the person to reach.
    mcp_servers: withhold("mcp"),
    hooks: withhold("hooks"),
    // A skill carries shell snippets and grants of its own.
    skills: withhold("skills"),
    // A slash command at the start would run a command nobody typed. Plain text is only a prompt.
    initial_prompt: filter(initialPrompt),
    // The user scope would write into the person's own memory.
    memory: withhold("permissions"),
    // It only changes how the run is attached.
    background: inert,
    // It starts a worktree in the folder, as the worktree setting does.
    isolation: withhold("settings"),
    // It only removes context.
    context: inert,
    // Removing an agent also removes the rules the user attached to it, and an agent defined afterwards starts from
    // allowing everything.
    disabled: withhold("permissions"),
    permissions: filter(denyRules),
  } satisfies Table<ConfigAgent.Info>,
  command: {
    // A snippet runs a command, and a later step refuses to; the rest of the template is only text.
    template: flag("commands", hasShellSnippet),
    description: inert,
    // Which agent a command runs as decides which permission rules apply to it, as `default_agent` does for a session: an
    // agent's own rules come after the user's and win. The template runs as the session's current agent instead.
    agent: withhold("permissions"),
    model: withhold("providers"),
    subagent: inert,
    subtask: inert,
  } satisfies Table<ConfigCommand.Info>,
}

export interface Result {
  readonly info: Info
  /** In the order of `Trust.Kinds`, each once. */
  readonly withheld: readonly Trust.Kind[]
}

/**
 * What an untrusted folder's document may contribute, and the kinds of what it may not. With `only`, the folder is
 * trusted and only those kinds are taken out, which are the ones whose executable parts changed since it was: a field
 * of another kind is kept as written, and so is a filtered one.
 */
export function sanitize(info: Info, place: Place, only?: readonly Trust.Kind[]): Result {
  const result = walk(info, classification.info, place, (fields) => new Info(fields), only)
  return { info: result.value, withheld: result.withheld }
}

/** What became of one field: the value that is kept, if any, the kinds that went, and whether the field was altered. */
interface Step {
  readonly name: PropertyKey
  readonly kept: unknown
  readonly withheld: readonly Trust.Kind[]
  readonly changed: boolean
}

function walk<T extends object>(
  value: T,
  table: Table<T>,
  place: Place,
  make: (fields: Draft<T>) => T,
  only?: readonly Trust.Kind[],
): { readonly value: T; readonly withheld: readonly Trust.Kind[] } {
  const treat = <K extends keyof T>(name: K): readonly Step[] => {
    const field = value[name]
    if (field === undefined || field === null) return []
    // A field the table does not know came from a newer schema, so it is held back like any other unknown setting.
    const treatment: Treatment<NonNullable<T[K]>> | undefined = table[name]
    if (only !== undefined) {
      if (treatment?.type !== "withhold" || !only.includes(treatment.kind))
        return [{ name, kept: field, withheld: [], changed: false }]
      return [{ name, kept: undefined, withheld: [treatment.kind], changed: true }]
    }
    if (treatment === undefined) return [{ name, kept: undefined, withheld: ["settings" as const], changed: true }]
    if (treatment.type === "withhold") return [{ name, kept: undefined, withheld: [treatment.kind], changed: true }]
    if (treatment.type === "filter") {
      const outcome = treatment.apply(field, place)
      return [{ name, kept: outcome.value, withheld: outcome.withheld, changed: outcome.value !== field }]
    }
    const reported = treatment.type === "flag" && treatment.when(field) ? [treatment.kind] : []
    return [{ name, kept: field, withheld: reported, changed: false }]
  }
  const steps = (Object.keys(value) as (keyof T)[]).flatMap((name) => treat(name))
  return {
    value: steps.some((step) => step.changed)
      ? make(
          Object.fromEntries(
            steps.filter((step) => step.kept !== undefined).map((step) => [step.name, step.kept]),
          ) as Draft<T>,
        )
      : value,
    withheld: Trust.Kinds.filter((kind) => steps.some((step) => step.withheld.includes(kind))),
  }
}

/**
 * The entry as it applies while its folder is untrusted. The project and local entries are stamped `trusted: false`,
 * and a document keeps only what it may contribute and lists what it lost. The user's, the flag's, the organization's
 * and the remote entries are never subject to trust.
 */
export function stamp(entry: Entry, place: Place): Entry {
  if (entry.scope !== "project" && entry.scope !== "local") return entry
  if (entry.type === "directory") return new Directory({ ...entry, trusted: false })
  const sanitized = sanitize(entry.info, place)
  return new Document({ ...entry, info: sanitized.info, trusted: false, withheld: sanitized.withheld })
}

/**
 * The entry of a trusted folder when some of what it holds changed since the folder was trusted: a document loses
 * those kinds, and a directory lists them for the readers of its files (`allows`, the plugin source). Both list what is
 * off in `withheld`; `trusted` stays unset, because everything else the entry holds is as trusted.
 */
export function partial(entry: Entry, place: Place, kinds: readonly Trust.Kind[]): Entry {
  const changed = Trust.Kinds.filter((kind) => kinds.includes(kind))
  if (changed.length === 0 || (entry.scope !== "project" && entry.scope !== "local")) return entry
  if (entry.type === "directory") return new Directory({ ...entry, withheld: changed })
  return new Document({ ...entry, info: sanitize(entry.info, place, changed).info, withheld: changed })
}

// The folders that a product keeps its config in. They sit inside the folder the config belongs to.
const containers = [".orbit", CompatNames.vendor.directory, CompatNames.agents]

/**
 * The folder that config found in `location` belongs to: the folder around a `.orbit` directory or another product's,
 * and otherwise the location itself. Trust is decided for that folder, so a grant for a repository covers the config
 * in it and does not reach the config that discovery finds in the folders above.
 */
export function holder(location: string) {
  return containers.includes(path.basename(location)) ? path.dirname(location) : location
}

/**
 * The folders that a file reference in config found above the project, or a file that such a config directory
 * supplies, may reach: the holder, which is the folder trust is decided for. A holder that cannot be trusted for good
 * (the home directory, a filesystem root) contains everything below it, so a decision for it says nothing about the
 * rest of the drive: only the config container may be reached, and nothing for config that sits directly in the holder.
 * `persistent` is `WorkspaceTrust`'s answer for the holder, so that the two never disagree about what a root is.
 */
export function reach(input: { readonly holder: string; readonly container: string; readonly persistent: boolean }) {
  if (input.persistent) return [input.holder]
  return input.container === input.holder ? [] : [input.container]
}

/** What decides a file that no config entry speaks for. */
export interface Context {
  /** The folders the project's decision covers, and what is decided. */
  readonly roots: readonly string[]
  readonly trusted: boolean
  /** The roots of other products, as `Config.compat` lists them with the verdict it stamped on the ones above. */
  readonly compat: readonly { readonly path: string; readonly scope: "user" | "project"; readonly trusted?: boolean }[]
  /**
   * What is decided for an entry now, where that differs from the stamp it was loaded with. The stamp trails a grant or
   * a revoke by the time the config takes to reload, and a caller that is about to run code must not act on it.
   */
  readonly verdicts?: ReadonlyMap<Entry, { readonly trusted: boolean; readonly withheld: readonly Trust.Kind[] }>
}

/**
 * Whether a file may run the code it carries, such as the hooks in a skill's or an agent's front matter. The source
 * nearest the file decides: the config around it, the roots other products keep config in, and the project's folders,
 * which are untrusted unless the decision says otherwise. So a file in an untrusted project is refused whether or not the
 * project has any config of its own, and one in the user's own config or in a root of the user's, which are never
 * subject to trust, is allowed even when the project's folder contains it. A file that nothing covers is allowed.
 * Ask `ProjectTrust.allows` rather than assembling the context. With a `kind`, a config directory that holds back that
 * kind because its files changed since the folder was trusted refuses its own files, whatever the folder's decision.
 */
export function allows(entries: readonly Entry[], file: string, context: Context, kind?: Trust.Kind) {
  const covers = [
    ...entries.flatMap((entry) => {
      const root = covered(entry)
      if (root === undefined) return []
      // An entry's stamp is the decision of the last load; a caller that has the decision now passes it.
      const verdict = context.verdicts?.get(entry) ?? { trusted: entry.trusted !== false, withheld: entry.withheld ?? [] }
      // What a trusted directory holds back of one kind is off for its own files only, not for the folder around it.
      const off = kind !== undefined && entry.type === "directory" && verdict.trusted && verdict.withheld.includes(kind)
      return [{ root, trusted: verdict.trusted }, ...(off ? [{ root: entry.path, trusted: false }] : [])]
    }),
    ...context.roots.map((root) => ({ root, trusted: context.trusted })),
    // A root with no verdict leaves the decision to the sources around it: only what is known is added.
    ...context.compat.flatMap((root) => {
      if (root.scope === "user") return [{ root: root.path, trusted: true }]
      return root.trusted === false ? [{ root: root.path, trusted: false }] : []
    }),
  ]
  const around = covers.filter((cover) => FSUtil.contains(cover.root, file))
  // The sources that are no further out than any other around the file; the others are overruled by them.
  const innermost = around.filter((item) => around.every((other) => FSUtil.contains(other.root, item.root)))
  return innermost.every((item) => item.trusted)
}

/**
 * The folder whose trust decision covers an entry, which is the one to trust to lift what the entry holds back. For a
 * project or local entry that is the folder around its `.orbit` directory or its file, and for any other the entry's
 * own location. Unset for a document that has no file.
 */
export function covered(entry: Entry) {
  const location =
    entry.type === "directory" ? entry.path : entry.path === undefined ? undefined : path.dirname(entry.path)
  if (location === undefined) return undefined
  return entry.scope === "project" || entry.scope === "local" ? holder(location) : location
}
