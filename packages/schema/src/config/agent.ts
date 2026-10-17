export * as ConfigAgent from "./agent.js"

import { Option, Schema, SchemaGetter } from "effect"
import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { optional, PositiveInt } from "../schema.js"
import { ConfigHooks } from "./hooks.js"
import { ConfigMCP } from "./mcp.js"
import { ConfigModel } from "./model.js"
import { ConfigProvider } from "./provider.js"

export const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))

const device = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/**
 * One plain name per `/`-separated segment. An agent id becomes a folder (its memory), a file name and a title, so it is
 * checked where it is decoded from config, and never on the `Agent.ID` brand, which stored sessions decode too. A segment
 * starts with a letter or digit, holds only letters, digits, `.`, `_` and `-`, does not end with `.` and is not a Windows
 * device name. That rejects `..`, a leading dot, separators, `:` (an NTFS stream), spaces and control characters.
 */
export function isName(id: string) {
  return id
    .split("/")
    .every(
      (segment) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment) && !segment.endsWith(".") && !device.test(segment),
    )
}

/**
 * Splits a list written as a string or as a list of strings. Commas and spaces separate entries, except inside
 * parentheses, so `shell(git status:*)` stays one entry. Items of a list that are not strings are ignored, and a null
 * value is an empty list.
 */
export function splitList(value: string | readonly unknown[] | null): string[] {
  if (value === null) return []
  if (typeof value !== "string") return value.flatMap((item) => (typeof item === "string" ? splitList(item) : []))
  const entries: string[] = []
  let current = ""
  let depth = 0
  for (const char of value) {
    if (char === "(") depth++
    if (char === ")") depth = Math.max(0, depth - 1)
    if (depth === 0 && (char === "," || /\s/.test(char))) {
      if (current !== "") entries.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current !== "") entries.push(current)
  return entries
}

/** A list of names, written as a string, a list or null. A `*` entry means every tool; an empty list means none. */
export const List = Schema.Union([Schema.String, Schema.Array(Schema.Unknown), Schema.Null]).pipe(
  Schema.decodeTo(Schema.Array(Schema.String), {
    decode: SchemaGetter.transform((value) => splitList(value)),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

export const ModelTier = Schema.Literals(["inherit", "small", "large"]).annotate({
  identifier: "Agent.ModelTier",
  description:
    "A provider-neutral model choice: inherit uses the caller's model, small the configured small model and large the configured large model",
})
export type ModelTier = typeof ModelTier.Type

const ModelAlias = Schema.String.pipe(
  Schema.decodeTo(ModelTier, {
    decode: SchemaGetter.transform((value) => value.trim().toLowerCase() as ModelTier),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

export const Memory = Schema.Literals(["user", "project", "local"]).annotate({
  identifier: "Agent.Memory",
  description: "Which memory scope the agent keeps its notes in",
})
export const Isolation = Schema.Literal("worktree").annotate({
  identifier: "Agent.Isolation",
  description: "Run the agent in a separate git worktree",
})

export const Context = Schema.Struct({
  instructions: Schema.Boolean.pipe(optional).annotate({
    description: "Include the project instruction files in the agent's context (default true)",
  }),
  git_status: Schema.Boolean.pipe(optional).annotate({
    description: "Include the start-of-session git status in the agent's context (default true)",
  }),
}).annotate({ identifier: "Agent.Context", description: "What the agent leaves out of its context" })

export const McpServer = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, ConfigMCP.Server).check(Schema.isPropertiesLengthBetween(1, 1)),
]).annotate({
  identifier: "Agent.McpServer",
  description:
    "The name of a configured MCP server, or a record with one key that names an inline server and holds its config",
})
const decodeMcpServer = Schema.decodeUnknownOption(McpServer)

// A bad item costs only itself.
const McpServers = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(Schema.Array(McpServer), {
    decode: SchemaGetter.transform((items) =>
      items.filter((item): item is typeof McpServer.Encoded => Option.isSome(decodeMcpServer(item))),
    ),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
)

const MaxTurns = Schema.Union([
  PositiveInt,
  Schema.String.pipe(
    Schema.decodeTo(PositiveInt, {
      decode: SchemaGetter.transform((value) => (/^\d+$/.test(value.trim()) ? Number(value) : Number.NaN)),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  ),
])

const Background = Schema.Union([
  Schema.Boolean,
  Schema.Literals(["true", "false"]).pipe(
    Schema.decodeTo(Schema.Boolean, {
      decode: SchemaGetter.transform((value) => value === "true"),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  ),
])

export class Info extends Schema.Class<Info>("Config.Agent")({
  model: Schema.Union([ConfigModel.Selection, ModelAlias]).pipe(optional),
  effort: Model.VariantID.check(Schema.isPattern(/^[^#]+$/)).pipe(optional),
  request: ConfigProvider.Request.pipe(optional),
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(optional),
  hidden: Schema.Boolean.pipe(optional),
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  max_turns: MaxTurns.pipe(optional).annotate({ description: "An alias of steps; steps wins when both are set" }),
  disabled: Schema.Boolean.pipe(optional),
  permissions: Permission.Ruleset.pipe(optional),
  tools: List.pipe(optional).annotate({
    description: "The tools the agent may use: absent or * means every tool, an empty list none",
  }),
  disallowed_tools: List.pipe(optional).annotate({ description: "Tools removed from the agent; * removes every tool" }),
  permission_mode: Permission.Mode.pipe(optional),
  mcp_servers: McpServers.pipe(optional),
  hooks: ConfigHooks.Info.pipe(optional),
  skills: List.pipe(optional).annotate({ description: "Skills loaded into the agent's context when it starts" }),
  initial_prompt: Schema.String.pipe(optional).annotate({
    description: "Text put in front of the agent's first user message",
  }),
  memory: Memory.pipe(optional),
  background: Background.pipe(optional),
  isolation: Isolation.pipe(optional),
  context: Context.pipe(optional),
}) {}
