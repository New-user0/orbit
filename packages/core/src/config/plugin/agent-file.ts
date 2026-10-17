export * as AgentFile from "./agent-file.js"

import { Document, Info } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { FSUtil } from "@orbit/util/fs-util"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { AbsolutePath } from "../../schema.js"
import { ConfigAgentV1 } from "../../v1/config/agent.js"
import { ConfigMigrateV1 } from "../../v1/config/migrate.js"
import { LinkShare } from "@orbit/util/link-share"
import { ConfigMarkdown } from "../markdown.js"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Info)
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)])
const decodeOptions = { errors: "all", propertyOrder: "original" } as const
// Another product spells these keys in camelCase. The legacy path forwards a key it does not know to the provider as a
// request option, so a deny list written this way would quietly turn into a request field. They are dropped instead.
const foreignKeys: Readonly<Record<string, string>> = {
  disallowedTools: "disallowed_tools",
  permissionMode: "permission_mode",
  mcpServers: "mcp_servers",
  maxTurns: "max_turns",
  initialPrompt: "initial_prompt",
}

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
    return { document: undefined, notes: [`${file.filepath}: "${name}" is not a plain agent name; the file defines no agent`] }
  const notes: string[] = []
  const front = Object.fromEntries(
    Object.entries(markdown.data).filter(([key]) => {
      const native = foreignKeys[key]
      if (native === undefined) return true
      notes.push(`${file.filepath}: ignored "${key}"; use "${native}"`)
      return false
    }),
  )
  const body = markdown.content.trim()
  // A plain object is the legacy map of tool names to booleans; a string or a list is the native allow list.
  const legacy =
    Object.keys(front).some((key) => !agentKeys.has(key)) ||
    (typeof front.tools === "object" && front.tools !== null && !Array.isArray(front.tools))
  // Join legacy model + variant without sending native request/permissions through migration.
  // Embedded and structured native selections, and a variant without a model, stay unchanged.
  const data =
    typeof front.model === "string" &&
    !front.model.includes("#") &&
    typeof front.variant === "string" &&
    /^[^#]+$/.test(front.variant)
      ? { ...front, model: `${front.model}#${front.variant}` }
      : front
  const agent = legacy
    ? Option.getOrUndefined(
        Option.map(decodeLegacyAgent({ name, ...front, prompt: body }, decodeOptions), ConfigMigrateV1.migrateAgent),
      )
    : native(file.filepath, { ...data, system: body }, notes)
  if (!agent) return { document: undefined, notes }
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return { document: undefined, notes }
  return { document: new Document({ type: "document", path: AbsolutePath.make(file.filepath), info }), notes }
}

// A field with a bad value costs only itself: the file still defines the agent without it.
function native(filepath: string, data: Record<string, unknown>, notes: string[]) {
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
