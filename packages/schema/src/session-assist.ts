export * as SessionAssist from "./session-assist.js"

import { Schema } from "effect"

export const LabelSkip = Schema.Literals([
  "subagent",
  "not_found",
  "unsettled",
  "interrupted",
  "no_text",
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
  "no_text",
  "just_done",
  "self_reference",
  "bracketed",
  "error_text",
  "labelled",
  "one_word",
  "over_twelve_words",
  "too_many_characters",
  "several_sentences",
  "markup",
  "verdict",
  "assistant_phrasing",
])
export type SuggestionFilter = typeof SuggestionFilter.Type

export const SuggestionSkip = Schema.Union([
  Schema.Literals([
    "subagent",
    "too_early",
    "reply_failed",
    "cache_expired",
    "awaiting_approval",
    "awaiting_form",
    "planning",
    "busy",
    "cancelled",
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
