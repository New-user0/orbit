export * as SessionContextUsage from "./session-context-usage.js"

import { Option, Schema } from "effect"
import { Model } from "./model.js"
import { NonNegativeInt, optional } from "./schema.js"

// Every string here comes from a file, a plugin or an MCP server, so it is carried as it was read. Each client writes
// it to its own output through its own escaping (`plain`, `json`).

export const CategoryKind = Schema.Literals([
  "system",
  "tools",
  "mcp",
  "mcp-deferred",
  "tools-deferred",
  "agents",
  "instructions",
  "skills",
  "messages",
  "auto-buffer",
  "compact-buffer",
  "free",
]).annotate({ identifier: "SessionContextUsage.CategoryKind" })
export type CategoryKind = typeof CategoryKind.Type

export const Category = Schema.Struct({
  kind: CategoryKind,
  tokens: NonNegativeInt,
}).annotate({ identifier: "SessionContextUsage.Category" })
export type Category = typeof Category.Type

export const Named = Schema.Struct({
  name: Schema.String,
  tokens: NonNegativeInt,
}).annotate({ identifier: "SessionContextUsage.Named" })
export type Named = typeof Named.Type

/** An instruction file or memory index of the baseline. `type` is the stored kind, `memory` or `team-memory`, else `file`. */
export const File = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
  tokens: NonNegativeInt,
}).annotate({ identifier: "SessionContextUsage.File" })
export type File = typeof File.Type

export const McpTool = Schema.Struct({
  name: Schema.String,
  server: Schema.String,
  tokens: NonNegativeInt,
  deferred: Schema.Boolean,
}).annotate({ identifier: "SessionContextUsage.McpTool" })
export type McpTool = typeof McpTool.Type

export const Agent = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  tokens: NonNegativeInt,
}).annotate({ identifier: "SessionContextUsage.Agent" })
export type Agent = typeof Agent.Type

export const Skill = Schema.Struct({
  id: Schema.String,
  tokens: NonNegativeInt,
}).annotate({ identifier: "SessionContextUsage.Skill" })
export type Skill = typeof Skill.Type

/** A local estimate of the history the next request carries, by what each part is. It need not equal the Messages row. */
export const Breakdown = Schema.Struct({
  toolCalls: NonNegativeInt,
  toolResults: NonNegativeInt,
  attachments: NonNegativeInt,
  assistant: NonNegativeInt,
  user: NonNegativeInt,
  /** By canonical tool name, largest calls plus results first. */
  tools: Schema.Array(Schema.Struct({ name: Schema.String, calls: NonNegativeInt, results: NonNegativeInt })),
  /** By reminder kind or row type, largest first. */
  attachmentKinds: Schema.Array(Named),
}).annotate({ identifier: "SessionContextUsage.Breakdown" })
export type Breakdown = typeof Breakdown.Type

export const Info = Schema.Struct({
  model: Model.Ref,
  /** The model's input window; unset when the catalog does not know it. */
  window: NonNegativeInt.pipe(optional),
  /** The newest measured prompt size, or the sum of the counted rows when no response measured it. */
  total: NonNegativeInt,
  /** Whether `total` is a response's measurement. */
  measured: Schema.Boolean,
  /** `total` over `window`, rounded; it can pass 100. Unset with no window. */
  percentage: NonNegativeInt.pipe(optional),
  /** Whether automatic compaction is on. */
  auto: Schema.Boolean,
  /** Where automatic compaction starts; unset with no window. */
  threshold: NonNegativeInt.pipe(optional),
  categories: Schema.Array(Category),
  files: Schema.Array(File),
  mcp: Schema.Array(McpTool),
  agents: Schema.Array(Agent),
  skills: Schema.Array(Skill),
  systemTools: Schema.Array(Named),
  deferredTools: Schema.Array(Named),
  sections: Schema.Array(Named),
  messages: Breakdown,
}).annotate({ identifier: "SessionContextUsage.Info" })
export type Info = typeof Info.Type

// The payload with each list taken as it came, so that its entries can be decoded one by one.
const Entries = Schema.Array(Schema.Unknown)
const Envelope = Schema.Struct({
  ...Info.fields,
  categories: Entries,
  files: Entries,
  mcp: Entries,
  agents: Entries,
  skills: Entries,
  systemTools: Entries,
  deferredTools: Entries,
  sections: Entries,
  messages: Schema.Struct({ ...Breakdown.fields, tools: Entries, attachmentKinds: Entries }),
})

/**
 * Decodes a server's answer for a client. The payload's own fields must decode, else there is no answer (`undefined`).
 * Each list is decoded entry by entry, so an entry this client cannot read, such as a category kind a newer server adds,
 * costs only itself: it is left out, and `dropped` names where it was (as `categories[2]`) for the caller to log once.
 */
export function decode(input: unknown): { readonly info: Info; readonly dropped: ReadonlyArray<string> } | undefined {
  const envelope = Schema.decodeUnknownOption(Envelope)(input)
  if (Option.isNone(envelope)) return undefined
  const dropped: string[] = []
  const entries = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, list: ReadonlyArray<unknown>, path: string) =>
    list.flatMap((raw, index): S["Type"][] =>
      Option.match(Schema.decodeUnknownOption(schema)(raw), {
        onNone: () => {
          dropped.push(`${path}[${index}]`)
          return []
        },
        onSome: (value) => [value],
      }),
    )
  const value = envelope.value
  const info: Info = {
    ...value,
    categories: entries(Category, value.categories, "categories"),
    files: entries(File, value.files, "files"),
    mcp: entries(McpTool, value.mcp, "mcp"),
    agents: entries(Agent, value.agents, "agents"),
    skills: entries(Skill, value.skills, "skills"),
    systemTools: entries(Named, value.systemTools, "systemTools"),
    deferredTools: entries(Named, value.deferredTools, "deferredTools"),
    sections: entries(Named, value.sections, "sections"),
    messages: {
      ...value.messages,
      tools: entries(Breakdown.fields.tools.value, value.messages.tools, "messages.tools"),
      attachmentKinds: entries(Named, value.messages.attachmentKinds, "messages.attachmentKinds"),
    },
  }
  return { info, dropped }
}
