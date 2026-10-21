export * as AgentFile from "./agent-file.js"

import { Document, Info } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { FSUtil } from "@orbit/util/fs-util"
import path from "path"
import { Permission } from "@orbit/schema/permission"
import { Effect, Option, Schema } from "effect"
import { AbsolutePath } from "../../schema.js"
import { ConfigAgentV1 } from "../../v1/config/agent.js"
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
import { LinkShare } from "@orbit/util/link-share"
import { ConfigMarkdown } from "../markdown.js"
import { LegacyAgent } from "../legacy-agent.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const encodeAgent = Schema.encodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeRule = Schema.decodeUnknownOption(Permission.Rule)
const decodeConfig = Schema.decodeUnknownOption(Info)
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])
const decodeOptions = { errors: "all", propertyOrder: "original" } as const

/**
 * The agents that the Markdown files under `{agent,agents,mode,modes}` in a config directory define, as one document
 * each, in path order within each pattern. A file that cannot be read or decoded defines none, and neither does one that
 * `supplies` says may not be read, which is asked before the file is. This is read for the agents plugin and for what
 * trust holds back, so both see the same agents. Keep it in sync with `sourceDirectories` in that plugin.
 */
export const load = Effect.fn("AgentFile.load")(function* (
  fs: FSUtil.Interface,
  directory: string,
  supplies: (file: string) => Effect.Effect<boolean> = () => Effect.succeed(true),
) {
  const files = yield* Effect.filter(yield* discover(fs, directory), (file) => supplies(file.filepath))
  const decoded = yield* Effect.forEach(files, (file) =>
    fs.readFileStringSafe(file.filepath).pipe(
      Effect.map((content) => (content ? decode(file, content) : undefined)),
      Effect.orElseSucceed(() => undefined),
    ),
  )
  const results = decoded.filter((result) => result !== undefined)
  // One line per field or file that was dropped; the rest of the file still defines its agent.
  yield* Effect.forEach(
    results.flatMap((result) => result.notes),
    (note) => Effect.logWarning(note),
  )
  return results.flatMap((result) => (result.document === undefined ? [] : [result.document]))
})

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    LinkShare.scan(fs, directory, [source.pattern]).pipe(
      Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
    ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.orElseSucceed(() => []),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  // The id becomes a folder, a file name and a title, so a name that is not a plain one defines no agent.
  if (!ConfigAgent.isName(name))
    return {
      document: undefined,
      notes: [`${file.filepath}: "${name}" is not a plain agent name; the file defines no agent`],
    }
  const notes: string[] = []
  const read = Object.fromEntries(
    Object.entries(markdown.data).filter(([key, value]) => {
      // A file written for another product names its agent; here the path does, so the key is read and set aside.
      if (key !== "name") return true
      if (value !== name && value !== name.split("/").at(-1))
        notes.push(`${file.filepath}: ignored "name"; the agent is named by its path, "${name}"`)
      return false
    }),
  )
  // The same preparation orbit.json entries get, so both doors read a variant and the foreign spellings alike.
  const prepared = LegacyAgent.prepare(read)
  prepared.notes.forEach((note) => notes.push(`${file.filepath}: ${note.message}`))
  const front = prepared.entry
  const body = markdown.content.trim()
  // A plain object is the legacy map of tool names to booleans; a string or a list is the native allow list.
  const legacy = Object.keys(front).some((key) => !agentKeys.has(key)) || LegacyAgent.isToolMap(front.tools)
  const agent = legacy
    ? migrate(file.filepath, name, front, body, notes)
    : native(file.filepath, { ...front, system: body }, notes)
  if (!agent) return { document: undefined, notes }
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return { document: undefined, notes }
  return { document: new Document({ type: "document", path: AbsolutePath.make(file.filepath), info }), notes }
}

// A file with a tools map, or a key that only the legacy format knows, goes through the legacy decoder; the native keys
// beside them are decoded on their own and put over the result, so none of them reaches the provider as a request option.
function migrate(filepath: string, name: string, front: Record<string, unknown>, body: string, notes: string[]) {
  const parts = LegacyAgent.split(front)
  // A field with a bad value costs only itself on this side too, and the native half is applied whatever becomes of it.
  // The body is the prompt and goes last, so a front matter `prompt` never replaces it.
  const legacyFields = Object.fromEntries(
    Object.entries(parts.legacy).filter(([key, value]) => {
      if (Option.isSome(decodeLegacyAgent({ name, [key]: value, prompt: body }, decodeOptions))) return true
      notes.push(`${filepath}: dropped the invalid "${key}"`)
      return false
    }),
  )
  const legacy = Option.getOrThrow(decodeLegacyAgent({ name, ...legacyFields, prompt: body }, decodeOptions))
  const kept = native(filepath, parts.native, notes)
  const encoded = kept && Option.getOrUndefined(encodeAgent(kept))
  return LegacyAgent.merge(
    ConfigMigrateV1.migrateAgent(legacy) as Record<string, unknown>,
    (encoded ?? {}) as Record<string, unknown>,
  )
}

// A field with a bad value costs only itself: the file still defines the agent without it.
function native(filepath: string, given: Record<string, unknown>, notes: string[]) {
  // The rules are a list of independent entries, so a bad rule costs only itself and the denies beside it stay.
  const data = Array.isArray(given.permissions)
    ? {
        ...given,
        permissions: given.permissions.filter((rule, index) => {
          if (Option.isSome(decodeRule(rule))) return true
          notes.push(`${filepath}: dropped the invalid "permissions.${index}"`)
          return false
        }),
      }
    : given
  const whole = decodeAgent(data, decodeOptions)
  if (Option.isSome(whole)) return unescape(whole.value)
  const kept = Object.fromEntries(
    Object.entries(data).filter(([key, value]) => {
      if (Option.isSome(decodeAgent({ [key]: value }, decodeOptions))) return true
      notes.push(`${filepath}: dropped the invalid "${key}"`)
      return false
    }),
  )
  return Option.match(decodeAgent(kept, decodeOptions), {
    onNone: () => undefined,
    onSome: unescape,
  })
}

/** Whether `file` is a definition, which replaces an agent of the same id: a file under agent/ or agents/, not mode/ or modes/. */
export function defines(directory: string, file: string) {
  return /^(?:agent|agents)$/.test(path.relative(directory, file).split(path.sep)[0] ?? "")
}

// A description written on one line often carries a literal backslash and n where a line break is meant.
function unescape(agent: ConfigAgent.Info) {
  if (agent.description === undefined || !agent.description.includes("\\n")) return agent
  return new ConfigAgent.Info({ ...agent, description: agent.description.replaceAll("\\n", "\n") })
}
