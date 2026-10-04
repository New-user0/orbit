export * as ConfigHooks from "./hooks.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

/**
 * Shell commands run at points in a session's life, in the same shape as Claude Code's `hooks` settings so existing
 * hook scripts keep working. Each command receives the event as JSON on stdin.
 */

export const Command = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
  timeout: PositiveInt.pipe(optional).annotate({ description: "Seconds before the command is stopped (default 60)" }),
}).annotate({ identifier: "Config.Hooks.Command" })
export interface Command extends Schema.Schema.Type<typeof Command> {}

export const Matcher = Schema.Struct({
  matcher: Schema.String.pipe(optional).annotate({
    description: 'Tool names this applies to, as a regular expression such as "edit|write". Empty or "*" matches all.',
  }),
  hooks: Schema.Array(Command),
}).annotate({ identifier: "Config.Hooks.Matcher" })
export interface Matcher extends Schema.Schema.Type<typeof Matcher> {}

export const Events = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop", "PreCompact"] as const
export type Event = (typeof Events)[number]

export class Info extends Schema.Class<Info>("Config.Hooks")({
  PreToolUse: Schema.Array(Matcher).pipe(optional).annotate({
    description:
      'Before a tool runs. Exit code 2, or JSON {"decision":"block"}, blocks the call with stderr or the reason.',
  }),
  PostToolUse: Schema.Array(Matcher).pipe(optional).annotate({
    description: "After a tool succeeds. Output on stdout is added to the tool result for the model.",
  }),
  UserPromptSubmit: Schema.Array(Matcher).pipe(optional).annotate({
    description: "When a prompt is submitted. Output on stdout is added to the prompt.",
  }),
  SessionStart: Schema.Array(Matcher).pipe(optional).annotate({ description: "When a top-level session is created." }),
  Stop: Schema.Array(Matcher).pipe(optional).annotate({ description: "When a session finishes working." }),
  PreCompact: Schema.Array(Matcher)
    .pipe(optional)
    .annotate({ description: "Before a session's history is compacted." }),
}) {}
