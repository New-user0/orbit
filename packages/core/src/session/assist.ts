export * as SessionAssist from "./assist.js"

import { SessionAssist } from "@orbit/schema/session-assist"
import type { SessionMessage } from "@orbit/schema/session-message"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Stream } from "effect"
import { Bus } from "../bus.js"
import { Form } from "../form.js"
import { Instance } from "../instance/service.js"
import { Permission } from "../permission.js"
import { PlanMode } from "../plan-mode.js"
import { SideQuery } from "../side-query.js"
import { NotFoundError } from "./error.js"
import { SessionEvent } from "./event.js"
import { SessionExecution } from "./execution.js"
import { SessionInbox } from "./inbox.js"
import type { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export interface LabelInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
  readonly toolCallIDs: ReadonlyArray<string>
}

export interface Interface {
  /**
   * A short label for a finished batch of the session's tool calls, written by the side model from each call's name,
   * input and output and from the text the assistant wrote before the calls. Nothing is stored or sent to the session.
   */
  readonly label: (input: LabelInput) => Effect.Effect<SessionAssist.Label, NotFoundError>
  /**
   * What the person might type next, written by the session's own model from its history. One request runs per
   * session: a newer one, or a prompt admitted meanwhile, cancels it. Nothing is stored or sent to the session.
   */
  readonly suggestion: (sessionID: SessionSchema.ID) => Effect.Effect<SessionAssist.Suggestion, NotFoundError>
}

/** Answers clients that ask for a tool label or a prompt suggestion, beside the session and never through it. */
export class Service extends Context.Service<Service, Interface>()("@orbit/SessionAssist") {}

// A response that wrote more than this many tokens the prompt cache did not cover makes a history request expensive.
const COLD_CACHE_TOKENS = 10_000
const FIELD_LENGTH = 300
const INTENT_LENGTH = 200

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const execution = yield* SessionExecution.Service
    const inbox = yield* SessionInbox.Service
    const instances = yield* Instance.Service
    const sideQuery = yield* SideQuery.Service
    const store = yield* SessionStore.Service
    // The cancel signal of the suggestion each session is writing.
    const writing = new Map<SessionSchema.ID, Deferred.Deferred<void>>()

    const requireSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })

    // The session and its subagents' sessions, whose asks hold the person's attention as the session's own do.
    const family = (sessionID: SessionSchema.ID): Effect.Effect<ReadonlyArray<SessionSchema.ID>> =>
      store.list({ parentID: sessionID }).pipe(
        Effect.flatMap((children) => Effect.forEach(children, (child) => family(child.id))),
        Effect.map((nested) => [sessionID, ...nested.flat()]),
      )

    // The trimmed text a side query answered, or why there is none: a blank answer has no text, and a model that could not
    // be asked is unavailable, which the client only sees as no text, so it is logged here (class 7).
    const ask = (input: SideQuery.TextInput) =>
      sideQuery.text(input).pipe(
        Effect.map((result) => ({ text: result.text.trim() })),
        Effect.catch(
          (error): Effect.Effect<{ readonly reason: "no_text" | "unavailable" }> =>
            error._tag === "SideQuery.InvalidOutputError"
              ? Effect.succeed({ reason: "no_text" as const })
              : Effect.logWarning("assist side query unavailable", {
                  purpose: input.purpose,
                  message: error.message,
                }).pipe(Effect.as({ reason: "unavailable" as const })),
        ),
      )

    const label: Interface["label"] = Effect.fn("SessionAssist.label")(function* (input) {
      const session = yield* requireSession(input.sessionID)
      if (session.parentID) return labelSkip("subagent")
      const found = yield* store.message(input.messageID)
      const message = found?.sessionID === session.id && found.message.type === "assistant" ? found.message : undefined
      const named = new Set(input.toolCallIDs)
      const calls = (message?.content ?? []).filter(
        (part): part is SessionMessage.AssistantTool => part.type === "tool" && named.has(part.id),
      )
      if (calls.length === 0) return labelSkip("not_found")
      const settled = calls.flatMap((call): Settled[] =>
        call.state.status === "completed" || call.state.status === "error"
          ? [{ name: call.name, state: call.state }]
          : [],
      )
      if (settled.length < calls.length) return labelSkip("unsettled")
      if (settled.some((call) => call.state.status === "error" && call.state.error.type === "aborted"))
        return labelSkip("interrupted")
      const intent = message?.content.findLast((part) => part.type === "text")?.text.slice(0, INTENT_LENGTH)
      const answer = yield* ask({
        sessionID: session.id,
        purpose: "session.tool_label",
        system: LABEL_SYSTEM,
        prompt: labelPrompt(settled, intent),
      })
      return "reason" in answer ? labelSkip(answer.reason) : { label: answer.text }
    })

    // The first state of the session, in the reference's order, that rules out a suggestion.
    const suppressed = Effect.fnUntraced(function* (session: SessionSchema.Info) {
      if (session.parentID) return "subagent" as const
      const [last, previous] = yield* store
        .messages({ sessionID: session.id, type: "assistant", order: "desc", limit: 2 })
        .pipe(Effect.orDie)
      if (!previous || last?.type !== "assistant") return "too_early" as const
      if (last.error) return "reply_failed" as const
      const tokens = last.tokens
      if (tokens && tokens.input + tokens.cache.write + tokens.output + tokens.reasoning > COLD_CACHE_TOKENS)
        return "cache_expired" as const
      const members = new Set<string>(yield* family(session.id))
      const asks = yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        const form = yield* Form.Service
        return { permissions: yield* permission.list(), forms: yield* form.list() }
      }).pipe(instances.provide(session))
      if (asks.permissions.some((request) => members.has(request.sessionID))) return "awaiting_approval" as const
      if (asks.forms.some((form) => members.has(form.sessionID))) return "awaiting_form" as const
      if (session.agent === PlanMode.agent) return "planning" as const
      if ((yield* execution.isActive(session.id)) || (yield* inbox.list(session.id)).length > 0) return "busy" as const
      return undefined
    })

    const write = (session: SessionSchema.Info) =>
      ask({
        sessionID: session.id,
        purpose: "session.prompt_suggestion",
        model: "primary",
        history: true,
        system: "",
        prompt: SUGGESTION_PROMPT,
      }).pipe(
        Effect.map((answer): SessionAssist.Suggestion => {
          if ("reason" in answer) return suggestionSkip(answer.reason)
          const dropped = filter(answer.text)
          return dropped ? suggestionSkip(dropped) : { suggestion: answer.text }
        }),
      )

    const suggestion: Interface["suggestion"] = Effect.fn("SessionAssist.suggestion")(function* (sessionID) {
      const session = yield* requireSession(sessionID)
      const reason = yield* suppressed(session)
      if (reason) return suggestionSkip(reason)
      const cancel = yield* Deferred.make<void>()
      const previous = writing.get(session.id)
      if (previous) yield* Deferred.succeed(previous, undefined)
      writing.set(session.id, cancel)
      const admitted = bus.subscribe(SessionEvent.InboxEnqueued).pipe(
        Stream.filter((event) => event.data.sessionID === session.id),
        Stream.take(1),
        Stream.runDrain,
      )
      return yield* Effect.raceFirst(
        write(session),
        Effect.raceFirst(Deferred.await(cancel), admitted).pipe(Effect.as(suggestionSkip("cancelled"))),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (writing.get(session.id) === cancel) writing.delete(session.id)
          }),
        ),
      )
    })

    return Service.of({ label, suggestion })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, SessionExecution.node, SessionInbox.node, Instance.node, SideQuery.node, SessionStore.node],
})

const labelSkip = (reason: SessionAssist.LabelSkip): SessionAssist.Label => ({ label: null, reason })
const suggestionSkip = (reason: SessionAssist.SuggestionSkip): SessionAssist.Suggestion => ({
  suggestion: null,
  reason,
})

// A value as the label prompt carries it: JSON, cut to 300 characters with three dots when longer.
const field = (value: unknown) => {
  const text = JSON.stringify(value)
  return text.length > FIELD_LENGTH ? `${text.slice(0, FIELD_LENGTH - 3)}...` : text
}

// What a call returned: its content, or for a failed call its content when it has some and its error otherwise. A file
// is named by its type, never sent as data.
const output = (state: Settled["state"]) =>
  state.content?.map((part) => (part.type === "text" ? part.text : `[${part.mime}]`)).join("\n") ??
  (state.status === "error" ? state.error.message : "")

type Settled = {
  readonly name: string
  readonly state: SessionMessage.ToolStateCompleted | SessionMessage.ToolStateError
}

const labelPrompt = (calls: ReadonlyArray<Settled>, intent: string | undefined) =>
  [
    ...(intent?.trim() ? [`What the person wants, from the assistant's last message: ${intent}`, ""] : []),
    "The tools that finished:",
    "",
    calls
      .map((call) =>
        [`Tool: ${call.name}`, `Input: ${field(call.state.input)}`, `Output: ${field(output(call.state))}`].join("\n"),
      )
      .join("\n\n"),
    "",
    "Write the label.",
  ].join("\n")

const LABEL_SYSTEM = [
  "Name the outcome of the tool calls below in a few words. The label fills a single line of a coding assistant's interface, and whatever runs past about 30 characters is hidden, so write it the way a terse changelog entry reads rather than as a full sentence.",
  "Someone skimming a column of these labels has to tell one batch from the next, so the detail that singles this one out, often a file, a symbol or a package, matters more than grammar: drop articles and shorten a path to its file name before you lose it. Each label reads as something already done, opening on its verb.",
  [
    "Examples:",
    "- Listed the migrations folder",
    "- Patched retry delay in queue.ts",
    "- Renamed userId to accountId",
    "- Checked CI logs for timeouts",
    "- Installed zod",
  ].join("\n"),
].join("\n\n")

const SUGGESTION_PROMPT = [
  "[Next-message guess: give the words the person is most likely to send Orbit now.]",
  "Work from what the person has written, their latest messages and the request that started the work, before anything else. You are guessing their own words, not recommending the step you think best.",
  'Hold each candidate to one test: on reading it, would the person think "yes, I was about to type exactly that"?',
  [
    "For instance:",
    '- They wanted a refactor and a changelog entry, and the refactor is in: "now the changelog"',
    '- A script was just written: "run it on the sample data"',
    "- You laid out options: the one they seem to lean towards",
    '- You mentioned a second file with the same bug: "fix that one too"',
    '- Everything is finished and the follow-up is plain: "open a PR"',
    "- The last step errored, or you misread them: leave it empty",
  ].join("\n"),
  'A guess that names its object, such as "rerun the date parser tests", helps the person; a vague "check it" does not.',
  [
    "Leave out:",
    '- approval or thanks ("nice", "perfect")',
    "- anything phrased as a question",
    '- wording only the assistant would use ("I will", "Let me")',
    "- topics the person has not brought up",
    "- a second sentence",
  ].join("\n"),
  "Answer with the guess alone, two to twelve words in the person's own register, with no quotes and no comment. An empty answer is right whenever what they wrote points to no particular next move.",
].join("\n\n")

// Lone words a person does send as a whole message, so the one-word rule keeps them.
const SHORT_REPLIES = new Set([
  "commit",
  "push",
  "deploy",
  "continue",
  "check",
  "stop",
  "exit",
  "quit",
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "yeah",
  "yea",
  "yep",
  "yup",
])
// Text about the suggestion rather than a suggestion, matched against the lower-cased text.
const SELF_REFERENCE = [
  /^\W*silence\W*$/,
  /\bsilence is\b|\bstay(s|ing)? silent\b/,
  /^no suggestion/,
  /^nothing to suggest/,
  /^nothing found\.?$/,
]
const ERROR_OPENINGS = [
  "invalid api key",
  "request timed out",
  "prompt is too long",
  "image was too large",
  "api error:",
]
const VERDICTS = [
  "awesome",
  "excellent",
  "great",
  "nice",
  "perfect",
  "looks good",
  "sounds good",
  "makes sense",
  "that works",
  "that worked",
  "that's all",
  "thank you",
  "thanks",
]
const ASSISTANT_OPENINGS = [
  "certainly",
  "of course",
  "sure,",
  "here are",
  "here is",
  "here's",
  "i can",
  "i think",
  "i notice",
  "i would",
  "i'll",
  "i'm",
  "i've",
  "let me",
  "that's",
  "this is",
  "this will",
  "you can",
  "you could",
  "you should",
]

/** The first rule, in the reference's order, that drops a suggestion's trimmed text; undefined keeps it. */
function filter(text: string): SessionAssist.SuggestionFilter | undefined {
  const lower = text.toLowerCase()
  const words = text.split(/\s+/).filter(Boolean)
  if (lower === "done") return "just_done"
  if (SELF_REFERENCE.some((pattern) => pattern.test(lower))) return "self_reference"
  if (/^\(.*\)$|^\[.*\]$/s.test(text)) return "bracketed"
  if (ERROR_OPENINGS.some((opening) => lower.startsWith(opening))) return "error_text"
  if (/^\w+:\s/.test(text)) return "labelled"
  if (words.length < 2 && !text.startsWith("/") && !SHORT_REPLIES.has(lower)) return "one_word"
  if (words.length > 12) return "over_twelve_words"
  if (text.length >= 100) return "too_many_characters"
  if (/[.!?]\s+[A-Z]/.test(text)) return "several_sentences"
  if (/[\n*]/.test(text)) return "markup"
  if (VERDICTS.some((phrase) => lower.includes(phrase))) return "verdict"
  if (ASSISTANT_OPENINGS.some((opening) => lower.startsWith(opening))) return "assistant_phrasing"
  return undefined
}
