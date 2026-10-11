export * as Fingerprint from "./fingerprint.js"

import path from "path"
import { Effect } from "effect"
import type { Info } from "@orbit/schema/config"
import type { Trust } from "@orbit/schema/trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Hash } from "@orbit/util/hash"
import { PluginSourceDirectory } from "../plugin/source-directory.js"
import { WorkspaceTrust } from "../workspace-trust.js"
import { LinkShare } from "./link-share.js"
import { ConfigMarkdown } from "./markdown.js"

// What a repository can change after a person trusted it, and so what is asked about again: the parts of project and
// local config that start programs. Each source (a document or a config directory) gets one digest per kind it holds,
// and `WorkspaceTrust` compares them with what the grant recorded. Not digested: permissions and grants, which run no
// code, commands, which ask per snippet, and the modules that a plugin's entry file imports.
//
// What is read is bounded by `within`, the folders that `ProjectTrust.supplies` holds the config to (the project's own
// folders, or what `ConfigTrust.reach` gives for a source above them), and every caller passes the same ones, so that a
// grant, a load and a later comparison compute the same digest. A path whose real path lies inside them is read through
// its links, wherever the link sits. One whose real path lies outside is named with the links on the way to it, which
// are read one at a time and never followed, and its content is never read.
//
// A digest is of content, never of a modification time: a time can be put back, and a touch is not a change. A digest
// that cannot be computed is `unreadable`, which equals no record, so that kind of that source counts
// as changed; the log says which path and kind.

/** The kinds that are digested. */
export const kinds = [
  "hooks",
  "mcp",
  "plugins",
  "providers",
  "shell",
  "formatter",
  "lsp",
  "env",
  "sandbox",
  "skills",
] as const satisfies readonly Trust.Kind[]

export type Digests = Partial<Record<Trust.Kind, string>>

/** Where a config directory keeps skills, and which of its files define one. Keep in sync with the skill plugin. */
const skillFolders = ["skill", "skills"]
const skillPattern = "{*.md,**/SKILL.md}"
/** The agent definitions of a config directory, including the legacy folders. Keep in sync with `AgentFile`. */
const agentFolders = [
  { name: "agent", pattern: "**/*.md" },
  { name: "agents", pattern: "**/*.md" },
  { name: "mode", pattern: "*.md" },
  { name: "modes", pattern: "*.md" },
]

/** The value with object keys sorted at every level and arrays in order, so that formatting and key order do not show. */
export function canonical(value: unknown): string {
  return JSON.stringify(sorted(value))
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (typeof value !== "object" || value === null) return value
  const fields = value as Readonly<Record<string, unknown>>
  return Object.fromEntries(
    Object.keys(fields)
      .sort()
      .flatMap((name) => (fields[name] === undefined ? [] : [[name, sorted(fields[name])] as const])),
  )
}

const unreadable: "unreadable" = WorkspaceTrust.unreadable

const digest = (value: unknown) => Hash.sha256(canonical(value))

/**
 * The digests of a project or local document, one for each kind it sets. `skills` also covers the front matter hooks of
 * the skill files under the paths it names, which are `skillRoots` as the skill plugin resolves them, so that editing
 * a skill that the document points at is a change to the document's `skills`. Only what lies inside `within` is read:
 * a path that leads out (an absolute one, `~/`, `..`, a network share, a link) counts by its name.
 */
export const document = Effect.fn("Fingerprint.document")(function* (
  fs: FSUtil.Interface,
  source: string,
  info: Info,
  skillRoots: readonly string[],
  within: readonly string[],
) {
  const fields = {
    hooks: info.hooks,
    mcp: info.mcp,
    plugins: info.plugins,
    providers: info.providers,
    shell: info.shell,
    formatter: info.formatter,
    lsp: info.lsp,
    env: info.env,
    sandbox: info.sandbox,
  }
  const skills =
    info.skills === undefined
      ? undefined
      : yield* attempt(
          source,
          "skills",
          Effect.gen(function* () {
            const bound = yield* bind(fs, within)
            const listed = yield* listFiles(
              bound,
              skillRoots.map((root) => ({ root, patterns: [skillPattern] })),
            )
            const found = yield* collect(bound, source, listed)
            return digest({ skills: info.skills, hooks: found.hooks, ...leaving(found.outside) })
          }),
        )
  return {
    ...Object.fromEntries(
      Object.entries(fields).flatMap(([kind, value]) => (value === undefined ? [] : [[kind, digest(value)] as const])),
    ),
    ...(skills === undefined ? {} : { skills }),
  } satisfies Digests
})

/**
 * The digests of a config directory: the plugins it keeps (their entry files and `package.json`), the hooks in the front
 * matter of its skill and agent definitions, and the MCP servers in the front matter of its agents. Nothing outside the
 * directory is read: a link that leads out counts by its name.
 */
export const directory = Effect.fn("Fingerprint.directory")(function* (
  fs: FSUtil.Interface,
  folder: string,
  within: readonly string[],
) {
  const plugins = yield* pluginsOf(fs, folder, within)
  const definitions = yield* attempt(
    folder,
    "hooks",
    Effect.gen(function* () {
      const bound = yield* bind(fs, within)
      const listed = yield* listFiles(bound, [
        ...skillFolders.map((name) => ({ root: path.join(folder, name), patterns: [skillPattern] })),
        ...agentFolders.map((item) => ({ root: path.join(folder, item.name), patterns: [item.pattern] })),
      ])
      const found = yield* collect(bound, folder, listed)
      return { hooks: found.hooks, mcp: found.mcp, outside: found.outside }
    }),
  )
  return {
    ...(plugins === undefined ? {} : { plugins }),
    ...(definitions === unreadable
      ? { hooks: definitions, mcp: definitions }
      : {
          ...(definitions.hooks.length === 0 && definitions.outside.length === 0
            ? {}
            : { hooks: digest({ hooks: definitions.hooks, ...leaving(definitions.outside) }) }),
          ...(definitions.mcp.length === 0 ? {} : { mcp: digest(definitions.mcp) }),
        }),
  } satisfies Digests
})

/** The digest of the plugins that a config directory keeps, unset when it keeps none. */
export const pluginsOf = Effect.fn("Fingerprint.plugins")(function* (
  fs: FSUtil.Interface,
  folder: string,
  within: readonly string[],
) {
  const items = yield* attempt(
    folder,
    "plugins",
    Effect.gen(function* () {
      const bound = yield* bind(fs, within)
      // A plugin folder that is itself a link out is not listed: its name is all there is to digest.
      const leads = yield* Effect.filter(PluginSourceDirectory.names, (name) =>
        reach(bound, path.join(folder, name)).pipe(Effect.map((verdict) => verdict === "outside")),
      )
      const names = PluginSourceDirectory.names.filter((name) => !leads.includes(name))
      const targets = yield* PluginSourceDirectory.discover(fs, folder, names)
      if (targets.length === 0 && leads.length === 0) return undefined
      const plugins = yield* Effect.forEach(targets, (target) =>
        Effect.gen(function* () {
          if ((yield* reach(bound, target)) !== "inside")
            return { name: relative(folder, target), outside: yield* trail(bound, folder, target) }
          // Every file of the folder, whichever entry the runtime would pick (the TUI imports a tui-only folder too).
          // The runtime's resolver follows links, so nothing a folder supplies is handed to it before trust.
          if (!(yield* fs.isDir(target))) {
            const files = [target, path.join(path.dirname(target), "package.json")]
            return {
              name: relative(folder, target),
              files: yield* Effect.forEach(files, (file) => readInside(bound, folder, file)),
            }
          }
          const listed = yield* walk(bound, target, ["*", "**/*"], ["node_modules"])
          return {
            name: relative(folder, target),
            files: yield* Effect.forEach(listed.files, (file) => readInside(bound, folder, file)),
            ...leaving(yield* Effect.forEach(listed.outside, (file) => describe(bound, folder, file))),
            ...(listed.named.length === 0 ? {} : { named: listed.named.map((file) => relative(folder, file)).toSorted() }),
          }
        }),
      )
      return {
        plugins,
        ...leaving(yield* Effect.forEach(leads, (name) => describe(bound, folder, path.join(folder, name)))),
      }
    }),
  )
  if (items === undefined || items === unreadable) return items
  return digest(items)
})

// What may be read: the real paths of the folders that bound it. A file counts when its real path is inside one of
// them, the same before a folder is trusted and after, so the first grant records what the later load computes.
type Bound = {
  readonly fs: FSUtil.Interface
  readonly roots: readonly string[]
}

const bind = Effect.fnUntraced(function* (fs: FSUtil.Interface, within: readonly string[]) {
  return { fs, roots: yield* Effect.forEach(within, (root) => fs.resolve(root)) } satisfies Bound
})

// A path on a network share is never touched, not even to look at it: connecting is a request to a host that the
// repository chose. That includes a share that a link on the way to it names.
const network = (file: string) => /^[\\/]{2}/.test(file)

// Where `file` stands: absent, `inside` the bound, or `outside` it (a link out, an absolute path elsewhere, a share).
const reach = Effect.fnUntraced(function* (bound: Bound, file: string) {
  if (network(file) || (yield* LinkShare.of(bound.fs, file)) !== undefined) return "outside" as const
  if (!(yield* bound.fs.exists(file))) return "absent" as const
  const real = yield* bound.fs.resolve(file)
  return bound.roots.some((root) => FSUtil.contains(root, real)) ? ("inside" as const) : ("outside" as const)
})

// The digest of one file's bytes, or just its name when it leads out or is not a regular file (a device, a pipe), which
// are never read.
const readInside = Effect.fnUntraced(function* (bound: Bound, from: string, file: string) {
  const name = relative(from, file)
  const verdict = yield* reach(bound, file)
  if (verdict === "absent") return { name }
  if (verdict === "outside" || !(yield* bound.fs.isFile(file))) return { name, outside: yield* trail(bound, from, file) }
  return { name, sha: Hash.sha256(Buffer.from(yield* bound.fs.readFile(file))) }
})

// The links on the way to a file, from the file up to the source it is found from (`from`, the config directory or the
// document), each as it is written: the link and where it points, one hop, so that pointing it somewhere else is a
// change. Nothing is followed or opened. Named from `from` and stopped by it, not by the bound, so that every caller
// that spells the paths the same way computes the same text however it spells the folders around the project.
const trail = Effect.fnUntraced(function* (bound: Bound, from: string, file: string) {
  const links: string[] = []
  for (let at = file; path.dirname(at) !== at; at = path.dirname(at)) {
    if (network(at)) break
    // Below a link that names a share, even reading a link connects to it: stop there and name the share.
    const share = yield* LinkShare.of(bound.fs, path.dirname(at))
    if (share !== undefined) {
      links.push(`${relative(from, path.dirname(at)) || "."} => ${share}`)
      break
    }
    const target = yield* bound.fs.readLink(at).pipe(Effect.orElseSucceed(() => undefined))
    if (target !== undefined) links.push(`${relative(from, at) || "."} => ${target}`)
    if (at === from || (at !== file && FSUtil.contains(at, from))) break
  }
  return links
})

// A name that leads out, with the links on the way to it.
const describe = Effect.fnUntraced(function* (bound: Bound, from: string, file: string) {
  return [relative(from, file), ...(yield* trail(bound, from, file))].join(" -> ")
})

const leaving = (outside: readonly string[]) => (outside.length === 0 ? {} : { outside: outside.toSorted() })

type Listing = {
  readonly files: readonly string[]
  readonly outside: readonly string[]
  // Folders that are named and not entered.
  readonly named: readonly string[]
}

// The files under each folder that match, sorted, and the names that lead out of the bound. A folder that is not there
// holds none. The loaders follow links, so the walk does too, one entry at a time: a link whose real path lies inside
// the bound is entered or listed like any other, and one that leads out is named and never entered, so nothing outside
// is listed, opened or counted.
const listFiles = Effect.fnUntraced(function* (
  bound: Bound,
  places: readonly { readonly root: string; readonly patterns: readonly string[] }[],
) {
  const found = yield* Effect.forEach(places, (place) =>
    Effect.gen(function* () {
      const verdict = yield* reach(bound, place.root)
      if (verdict === "absent") return { files: [], outside: [], named: [] } satisfies Listing
      if (verdict === "outside") return { files: [], outside: [place.root], named: [] } satisfies Listing
      if (!(yield* bound.fs.isDir(place.root))) return { files: [], outside: [], named: [] } satisfies Listing
      return yield* walk(bound, place.root, place.patterns)
    }),
  )
  return {
    files: found.flatMap((item) => item.files).toSorted(),
    outside: found.flatMap((item) => item.outside).toSorted(),
    named: [],
  } satisfies Listing
})

// Deep enough for any real tree, and an end to a loop of links that stays inside the bound.
const maxDepth = 32

const walk = Effect.fnUntraced(function* (
  bound: Bound,
  root: string,
  patterns: readonly string[],
  skip: readonly string[] = [],
) {
  const files: string[] = []
  const outside: string[] = []
  const named: string[] = []
  const entered = new Set<string>()
  const matches = (file: string) => {
    const name = relative(root, file)
    return patterns.some((pattern) => bound.fs.globMatch(pattern, name))
  }
  const visit = (folder: string, depth: number): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const real = yield* bound.fs.resolve(folder)
      if (depth > maxDepth || entered.has(real)) return
      entered.add(real)
      const entries = (yield* bound.fs.readDirectoryEntries(folder)).toSorted((a, b) => (a.name < b.name ? -1 : 1))
      for (const entry of entries) {
        const full = path.join(folder, entry.name)
        if (skip.includes(entry.name)) {
          named.push(full)
          continue
        }
        if (entry.type === "directory") {
          yield* visit(full, depth + 1)
          continue
        }
        if (entry.type === "symlink") {
          const verdict = yield* reach(bound, full)
          if (verdict === "absent") continue
          if (verdict === "outside") outside.push(full)
          else if (yield* bound.fs.isDir(full)) yield* visit(full, depth + 1)
          else if (matches(full)) files.push(full)
          continue
        }
        if (matches(full)) (entry.type === "file" ? files : outside).push(full)
      }
    })
  yield* visit(root, 0)
  return { files, outside, named } satisfies Listing
})

// The `hooks` and `mcp_servers` that the front matter of these files carry, with the file each came from. A file whose
// front matter does not parse carries nothing, as the loaders read it. A file that is not a regular file carries
// nothing and is named with the ones that lead out.
const collect = Effect.fnUntraced(function* (bound: Bound, from: string, listed: Listing) {
  const fs = bound.fs
  const hooks: unknown[] = []
  const mcp: unknown[] = []
  const outside = yield* Effect.forEach(listed.outside, (file) => describe(bound, from, file))
  for (const file of listed.files) {
    if (!(yield* fs.isFile(file))) {
      outside.push(yield* describe(bound, from, file))
      continue
    }
    const markdown = ConfigMarkdown.parseOption(yield* fs.readFileString(file))
    if (markdown === undefined) continue
    if (markdown.data.hooks !== undefined) hooks.push([relative(from, file), markdown.data.hooks])
    if (markdown.data.mcp_servers !== undefined) mcp.push([relative(from, file), markdown.data.mcp_servers])
  }
  return { hooks, mcp, outside }
})

// Whatever fails (a file that cannot be read, a folder that cannot be listed) makes the answer unreadable, once in the
// log, and costs only this source and kind.
const attempt = <A, E, R>(source: string, kind: Trust.Kind, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("config fingerprint unreadable", { path: source, kind, cause }).pipe(
        Effect.as(unreadable),
      ),
    ),
  )

function relative(from: string, file: string) {
  return path.relative(from, file).replaceAll("\\", "/")
}
