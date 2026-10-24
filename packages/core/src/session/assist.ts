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

    // The trimmed text a side query answered, or why there is none: a blank answer is empty, and a model that could not
    // be asked is unavailable, which the client only sees as no text, so it is logged here (class 7).
    const ask = (input: SideQuery.TextInput) =>
      sideQuery.text(input).pipe(
        Effect.map((result) => ({ text: result.text.trim() })),
        Effect.catch(
          (error): Effect.Effect<{ readonly reason: "empty" | "unavailable" }> =>
            error._tag === "SideQuery.InvalidOutputError"
              ? Effect.succeed({ reason: "empty" as const })
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
        return labelSkip("aborted")
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
      if (!previous || last?.type !== "assistant") return "early_conversation" as const
      if (last.error) return "last_response_error" as const
      const tokens = last.tokens
      if (tokens && tokens.input + tokens.cache.write + tokens.output + tokens.reasoning > COLD_CACHE_TOKENS)
        return "cache_cold" as const
      const members = new Set<string>(yield* family(session.id))
      const asks = yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        const form = yield* Form.Service
        return { permissions: yield* permission.list(), forms: yield* form.list() }
      }).pipe(instances.provide(session))
      if (asks.permissions.some((request) => members.has(request.sessionID))) return "pending_permission" as const
      if (asks.forms.some((form) => members.has(form.sessionID))) return "elicitation_active" as const
      if (session.agent === PlanMode.agent) return "plan_mode" as const
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
        Effect.raceFirst(Deferred.await(cancel), admitted).pipe(Effect.as(suggestionSkip("aborted"))),
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
  "Write one short label that says what a batch of tool calls achieved. A coding assistant shows it as a single row that is cut off near 30 characters, so make it read like the subject line of a commit, not like a sentence.",
  "Keep a past-tense verb and the noun that tells this batch apart. Drop articles, linking words and long paths before anything else.",
  [
    "Examples:",
    "- Searched lib/billing for retries",
    "- Fixed null check in TokenStore",
    "- Added /status route",
    "- Read vite.config.ts",
    "- Ran the failing sync tests",
  ].join("\n"),
].join("\n\n")

const SUGGESTION_PROMPT = [
  "[Suggestion mode: write what the person would most naturally type to Orbit next.]",
  "Read the person's own recent messages and what they first asked for before anything else. The task is to predict the words they would type, not to propose what you think is best.",
  'Check: if they saw the suggestion, would they think "that is what I was about to write"?',
  [
    "Examples:",
    '- They asked for a fix and for tests, and the fix is done: "run the tests"',
    '- New code was just written: "try it out"',
    "- You offered choices: the one they would most likely pick",
    '- You asked whether to go on: "yes"',
    '- The work is done and the next step is plain: "commit this" or "push it"',
    "- Something just failed, or you misread them: write nothing",
  ].join("\n"),
  'Be specific rather than general: "run the parser tests" is better than "test it".',
  [
    "Never write:",
    '- praise or a verdict ("looks good", "thanks")',
    "- a question",
    '- your own voice ("Let me", "I\'ll")',
    "- an idea they have not raised",
    "- more than one sentence",
  ].join("\n"),
  "When the next step is not clear from what they wrote, write nothing.",
  "Format: 2 to 12 words in the person's own style, or nothing at all. Reply with the suggestion alone, without quotes or explanation.",
].join("\n\n")

const AFFIRMATIONS = new Set([
  "yes",
  "yeah",
  "yep",
  "yea",
  "yup",
  "sure",
  "ok",
  "okay",
  "push",
  "commit",
  "deploy",
  "stop",
  "continue",
  "check",
  "exit",
  "quit",
  "no",
])
// Text about the suggestion rather than a suggestion, matched against the lower-cased text.
const META_TEXT = [
  /^nothing found\.?$/,
  /^nothing to suggest/,
  /^no suggestion/,
  /\bsilence is\b|\bstay(s|ing)? silent\b/,
  /^\W*silence\W*$/,
]
const ERROR_OPENINGS = [
  "api error:",
  "prompt is too long",
  "request timed out",
  "invalid api key",
  "image was too large",
]
const EVALUATIVE = [
  "thanks",
  "thank you",
  "looks good",
  "sounds good",
  "that works",
  "that worked",
  "that's all",
  "nice",
  "great",
  "perfect",
  "makes sense",
  "awesome",
  "excellent",
]
const ASSISTANT_OPENINGS = [
  "let me",
  "i'll",
  "i've",
  "i'm",
  "i can",
  "i would",
  "i think",
  "i notice",
  "here's",
  "here is",
  "here are",
  "that's",
  "this is",
  "this will",
  "you can",
  "you should",
  "you could",
  "sure,",
  "of course",
  "certainly",
]

/** The first rule, in the reference's order, that drops a suggestion's trimmed text; undefined keeps it. */
function filter(text: string): SessionAssist.SuggestionFilter | undefined {
  const lower = text.toLowerCase()
  const words = text.split(/\s+/).filter(Boolean)
  if (lower === "done") return "done"
  if (META_TEXT.some((pattern) => pattern.test(lower))) return "meta_text"
  if (/^\(.*\)$|^\[.*\]$/s.test(text)) return "meta_wrapped"
  if (ERROR_OPENINGS.some((opening) => lower.startsWith(opening))) return "error_message"
  if (/^\w+:\s/.test(text)) return "prefixed_label"
  if (words.length < 2 && !text.startsWith("/") && !AFFIRMATIONS.has(lower)) return "too_few_words"
  if (words.length > 12) return "too_many_words"
  if (text.length >= 100) return "too_long"
  if (/[.!?]\s+[A-Z]/.test(text)) return "multiple_sentences"
  if (/[\n*]/.test(text)) return "has_formatting"
  if (EVALUATIVE.some((phrase) => lower.includes(phrase))) return "evaluative"
  if (ASSISTANT_OPENINGS.some((opening) => lower.startsWith(opening))) return "assistant_voice"
  return undefined
}
