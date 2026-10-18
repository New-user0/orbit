import { Schema } from "effect"
import { optional } from "./schema.js"
import { statics } from "./schema.js"
import { Skill } from "./skill.js"

export interface PromptMention extends Schema.Schema.Type<typeof PromptMention> {}
export const PromptMention = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Mention" })

export const FileSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("inline") }),
  Schema.Struct({ type: Schema.Literal("uri"), uri: Schema.String }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Prompt.FileSource" })
export type FileSource = typeof FileSource.Type

export const Base64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
).annotate({ identifier: "Prompt.Base64" })
export type Base64 = typeof Base64.Type

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  data: Base64,
  mime: Schema.String,
  source: FileSource,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mention: PromptMention.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          data: input.data,
          mime: input.mime,
          source: input.source,
          name: input.name,
          description: input.description,
          mention: input.mention,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  mention: PromptMention.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

export interface SkillAttachment extends Schema.Schema.Type<typeof SkillAttachment> {}
export const SkillAttachment = Schema.Struct({
  id: Skill.ID,
  name: Skill.Name,
  text: Schema.String.pipe(optional),
  mention: PromptMention.pipe(optional),
}).annotate({ identifier: "Prompt.SkillAttachment" })

const Line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * What the person's editor showed when the prompt was sent: the file that is open and, optionally, the selected lines.
 * The client converts the editor's positions before sending: lines are 1-based and inclusive, and a selection that ends
 * at column 0 of its last line stops at the line before it. A selection that ends before it starts
 * is dropped at admission, and the prompt is admitted without the field. A command (`session.command`) accepts the field
 * but does not carry it on.
 */
export interface EditorContext extends Schema.Schema.Type<typeof EditorContext> {}
export const EditorContext = Schema.Struct({
  /** The absolute path the editor reported. */
  path: Schema.NonEmptyString,
  selection: Schema.Struct({
    start: Line,
    end: Line,
    text: Schema.String,
  }).pipe(optional),
}).annotate({ identifier: "Prompt.EditorContext" })

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  skills: Schema.Array(SkillAttachment).pipe(optional),
  editor: EditorContext.pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (input: Pick<Prompt, "text" | "files" | "agents" | "skills" | "editor">) =>
        schema.make({
          text: input.text,
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
          ...(input.skills === undefined ? {} : { skills: input.skills }),
          ...(input.editor === undefined ? {} : { editor: input.editor }),
        }),
    })),
  )
