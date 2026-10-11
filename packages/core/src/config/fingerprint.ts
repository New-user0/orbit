export * as Fingerprint from "./fingerprint.js"

import path from "path"
import { Effect } from "effect"
import type { Info } from "@orbit/schema/config"
import type { Trust } from "@orbit/schema/trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Hash } from "@orbit/util/hash"
import { PluginSourceDirectory } from "../plugin/source-directory.js"
import { WorkspaceTrust } from "../workspace-trust.js"
import { ConfigMarkdown } from "./markdown.js"

// What a repository can change after a person trusted it, and so what is asked about again: the parts of project and
// local config that start programs. Each source (a document or a config directory) gets one digest per kind it holds,
// and `WorkspaceTrust` compares them with what the grant recorded. Not digested: permissions and grants, which run no
// code, commands, which ask per snippet, and the modules that a plugin's entry file imports.
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
const agentPatterns = ["{agent,agents}/**/*.md", "{mode,modes}/*.md"]

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
 * a skill that the document points at is a change to the document's `skills`.
 */
export const document = Effect.fn("Fingerprint.document")(function* (
  fs: FSUtil.Interface,
  source: string,
  info: Info,
  skillRoots: readonly string[],
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
            const files = yield* listFiles(fs, skillRoots, [skillPattern])
            return digest({ skills: info.skills, hooks: (yield* collect(fs, source, files)).hooks })
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
 * matter of its skill and agent definitions, and the MCP servers in the front matter of its agents.
 */
export const directory = Effect.fn("Fingerprint.directory")(function* (fs: FSUtil.Interface, folder: string) {
  const plugins = yield* pluginsOf(fs, folder)
  const definitions = yield* attempt(
    folder,
    "hooks",
    Effect.gen(function* () {
      const skills = yield* collect(
        fs,
        folder,
        yield* listFiles(
          fs,
          skillFolders.map((name) => path.join(folder, name)),
          [skillPattern],
        ),
      )
      const agents = yield* collect(fs, folder, yield* listFiles(fs, [folder], agentPatterns))
      return { hooks: [...skills.hooks, ...agents.hooks], mcp: agents.mcp }
    }),
  )
  const unset = (found: readonly unknown[]) => found.length === 0
  return {
    ...(plugins === undefined ? {} : { plugins }),
    ...(definitions === unreadable
      ? { hooks: definitions, mcp: definitions }
      : {
          ...(unset(definitions.hooks) ? {} : { hooks: digest(definitions.hooks) }),
          ...(unset(definitions.mcp) ? {} : { mcp: digest(definitions.mcp) }),
        }),
  } satisfies Digests
})

/** The digest of the plugins that a config directory keeps, unset when it keeps none. */
export const pluginsOf = Effect.fn("Fingerprint.plugins")(function* (fs: FSUtil.Interface, folder: string) {
  const targets = yield* PluginSourceDirectory.discover(fs, folder)
  if (targets.length === 0) return undefined
  const items = yield* attempt(
    folder,
    "plugins",
    Effect.forEach(targets, (target) =>
      Effect.gen(function* () {
        const found = yield* PluginSourceDirectory.entrypoints(fs, target)
        const manifest = found !== undefined && (yield* fs.exists(found.manifest)) ? [found.manifest] : []
        const files = found === undefined ? [] : [...found.files, ...manifest]
        return {
          name: relative(folder, target),
          files: yield* Effect.forEach(files, (file) =>
            fs
              .readFile(file)
              .pipe(Effect.map((bytes) => ({ name: relative(folder, file), sha: Hash.sha256(Buffer.from(bytes)) }))),
          ),
        }
      }),
    ),
  )
  return items === unreadable ? items : digest(items)
})

// The files under each folder that match, sorted. A folder that is not there holds none.
const listFiles = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  roots: readonly string[],
  patterns: readonly string[],
) {
  const found = yield* Effect.forEach(roots, (root) =>
    Effect.gen(function* () {
      if (!(yield* fs.isDir(root))) return []
      const files = yield* Effect.forEach(patterns, (pattern) =>
        fs.scan(pattern, { cwd: root, absolute: true, include: "file", symlink: true, dot: true }),
      )
      return files.flatMap((names) => names.toSorted())
    }),
  )
  return found.flat()
})

// The `hooks` and `mcp_servers` that the front matter of these files carry, with the file each came from. A file whose
// front matter does not parse carries nothing, as the loaders read it.
const collect = Effect.fnUntraced(function* (fs: FSUtil.Interface, from: string, files: readonly string[]) {
  const hooks: unknown[] = []
  const mcp: unknown[] = []
  for (const file of files) {
    const markdown = ConfigMarkdown.parseOption(yield* fs.readFileString(file))
    if (markdown === undefined) continue
    if (markdown.data.hooks !== undefined) hooks.push([relative(from, file), markdown.data.hooks])
    if (markdown.data.mcp_servers !== undefined) mcp.push([relative(from, file), markdown.data.mcp_servers])
  }
  return { hooks, mcp }
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
