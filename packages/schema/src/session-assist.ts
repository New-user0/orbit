export * as SessionAssist from "./session-assist.js"

import { Schema } from "effect"

export const LabelSkip = Schema.Literals([
  "subagent",
  "not_found",
  "unsettled",
  "aborted",
  "empty",
  "unavailable",
]).annotate({
  identifier: "Session.Assist.LabelSkip",
  description:
    "Why there is no label: the session is a subagent's, the calls are not in the message, a call has not finished, the calls were interrupted, the model answered nothing, or the model could not be asked.",
})
export type LabelSkip = typeof LabelSkip.Type

export const Label = Schema.Union([
  Schema.Struct({ label: Schema.String }),
  Schema.Struct({ label: Schema.Null, reason: LabelSkip }),
]).annotate({
  identifier: "Session.Assist.Label",
  description:
    "A short label for a finished batch of tool calls, or null with the reason there is none. The label is model text: escape it before printing it.",
})
export type Label = typeof Label.Type

/** The checks a suggestion's text must pass, in the order they run; each names the text it drops. */
export const SuggestionFilter = Schema.Literals([
  "empty",
  "done",
  "meta_text",
  "meta_wrapped",
  "error_message",
  "prefixed_label",
  "too_few_words",
  "too_many_words",
  "too_long",
  "multiple_sentences",
  "has_formatting",
  "evaluative",
  "assistant_voice",
])
export type SuggestionFilter = typeof SuggestionFilter.Type

export const SuggestionSkip = Schema.Union([
  Schema.Literals([
    "subagent",
    "early_conversation",
    "last_response_error",
    "cache_cold",
    "pending_permission",
    "elicitation_active",
    "plan_mode",
    "busy",
    "aborted",
    "unavailable",
  ]),
  SuggestionFilter,
]).annotate({
  identifier: "Session.Assist.SuggestionSkip",
  description:
    "Why there is no suggestion: a state of the session that rules one out, a request cancelled by a newer one or by a prompt, a model that could not be asked, or a filter that dropped the text the model wrote.",
})
export type SuggestionSkip = typeof SuggestionSkip.Type

export const Suggestion = Schema.Union([
  Schema.Struct({ suggestion: Schema.String }),
  Schema.Struct({ suggestion: Schema.Null, reason: SuggestionSkip }),
]).annotate({
  identifier: "Session.Assist.Suggestion",
  description:
    "What the person might type next, or null with the reason there is none. The suggestion is model text: escape it before printing it.",
})
export type Suggestion = typeof Suggestion.Type
