import { heading, neutralize } from "@orbit/util/reminder-text"
import type { LocationRef, SessionMessageInfo, SessionStructuredError, SessionTurnOptions } from "@orbit/client/promise"
import { jsonLine } from "@orbit/flow/plain"
import { SessionMessage } from "@orbit/schema/session-message"
import { OUTPUT_TOOL } from "@orbit/schema/session-turn"
import { Schema } from "effect"
import { readFile } from "node:fs/promises"

// Helpers that the one-prompt driver (noninteractive.ts) and the stream driver (stream.ts) both use: ids, the form
// owner rules, the prepared files, the result line and the numbers a result carries.

export type File = {
  url: string
  filename: string
  mime: string
}

// MCP elicitations are temporarily owned by the "global" sentinel instead of a real
// session. An exclusive local process may treat them as this run's blockers; an
// attached client must not cancel input that may belong to another session.
export const GLOBAL_FORM_SESSION_ID = "global"

export function sameLocation(left: LocationRef | undefined, right: LocationRef) {
  return !!left && left.directory === right.directory
}

export function formRequestOptions(location: LocationRef | undefined): [] | [{ headers: Record<string, string> }] {
  if (!location) return []
  return [
    {
      headers: {
        "x-orbit-directory": encodeURIComponent(location.directory),
      },
    },
  ]
}

export function formAlreadySettled(error: unknown) {
  return !!error && typeof error === "object" && "_tag" in error && error._tag === "FormAlreadySettledError"
}

export function partID(eventID: string) {
  return `prt_${eventID.replace(/^evt_/, "")}`
}

export function toolKey(messageID: string, id: string) {
  return `${messageID}\u0000${id}`
}

export function contentKey(messageID: string, ordinal: number) {
  return `${messageID}\u0000${ordinal}`
}

export function projectedPartID(messageID: string, part: string) {
  return `prt_${messageID.replace(/^msg_/, "")}_${part}`
}

export function toMillis(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value === "string") return new Date(value).getTime()
  return Date.now()
}

export async function prepareFile(file: File) {
  if (file.mime !== "text/plain") {
    const uri = file.url.startsWith("data:")
      ? file.url
      : `data:${file.mime};base64,${(await readFile(new URL(file.url))).toString("base64")}`
    return { attachment: { uri, name: file.filename } }
  }
  const content = file.url.startsWith("data:")
    ? Buffer.from(file.url.slice(file.url.indexOf(",") + 1), "base64").toString("utf8")
    : await readFile(new URL(file.url), "utf8")
  // The text joins the prompt as written by the person, so reminder look-alikes in the file are defused here.
  return { text: `<file name="${heading(file.filename)}">\n${neutralize(content)}\n</file>` }
}

// The notice that the runner publishes when it raises the output limit and answers again, with the message it replaces.
export const decodeEscalation = Schema.decodeUnknownOption(
  Schema.Struct({ notice: Schema.Literal("output-escalation"), replaces: SessionMessage.ID }),
)

export const decodeNotice = Schema.decodeUnknownOption(Schema.Struct({ notice: Schema.String }))

export const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// The finishes the server counts as a step when it checks a step limit.
export const countedFinishes = new Set<string>(["stop", "length", "tool-calls", "content-filter"])

const continuingNotices = new Set<string>(["output-limit", "output-escalation"])

// The ids of the responses that are steps, by the server's rule: a response with a counted finish, except a text-only
// reply that was cut off and then continued in the same logical step (the escalation or resume notice that follows it
// before the next response). `messages` runs oldest first.
export function stepIDs(messages: ReadonlyArray<SessionMessageInfo>) {
  return new Set(
    messages.flatMap((message, index) => {
      if (message.type !== "assistant" || !message.finish || !countedFinishes.has(message.finish)) return []
      if (message.finish !== "length" || message.content.some((item) => item.type === "tool")) return [message.id]
      const next = messages.findIndex((later, at) => at > index && later.type === "assistant")
      const continued = messages
        .slice(index + 1, next === -1 ? undefined : next)
        .some((later) => later.type === "synthetic" && continuingNotices.has(String(later.metadata?.notice)))
      return continued ? [] : [message.id]
    }),
  )
}

// The limit that ended the run names its result subtype. `limit.cost-unknown` and `limit.tokens-unknown` are the server refusing a limit
// it cannot count, which is a plain error, not a limit that was reached.
export function subtype(input: { failed: boolean; interrupted: boolean; limit: SessionStructuredError | undefined }) {
  if (input.interrupted) return "interrupted"
  const type = input.limit?.type
  if (type === "limit.steps") return "error_max_steps"
  if (type === "limit.tokens") return "error_max_tokens"
  if (type === "limit.cost") return "error_max_cost"
  if (type === "limit.structured-output") return "error_max_structured_output_retries"
  return input.failed ? "error" : "success"
}

// Whether the prompt the server admitted carries what was asked for. An older server drops the fields it does not know
// (or refuses them); either way the run must not go on without the answer shape that was asked for.
export function echoes(sent: SessionTurnOptions, admitted: SessionTurnOptions | undefined) {
  if (!admitted) return false
  const model = (value: SessionTurnOptions["fallbackModel"]) =>
    value && `${value.providerID}/${value.id}#${value.variant ?? ""}`
  return (
    sent.maxSteps === admitted.maxSteps &&
    sent.maxCost === admitted.maxCost &&
    sent.maxTokens === admitted.maxTokens &&
    model(sent.fallbackModel) === model(admitted.fallbackModel) &&
    (sent.output === undefined
      ? admitted.output === undefined
      : admitted.output !== undefined &&
        sent.output.attempts === admitted.output.attempts &&
        canonical(sent.output.schema) === canonical(admitted.output.schema))
  )
}

// Keys sorted, so a schema that the server stored in another order is still the schema that was sent.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`
}

/**
 * The structured answer of a run: the input of its latest hand-in when the server accepted that hand-in. It is read from
 * the history, where the call and its outcome are recorded, and never parsed out of the model's text. A later hand-in
 * that was rejected leaves no answer, because a turn only ends successfully on an accepted one.
 */
export function structuredAnswer(messages: ReadonlyArray<SessionMessageInfo>): { value: unknown } | undefined {
  const latest = messages
    .flatMap((message) => (message.type === "assistant" ? message.content : []))
    .findLast((part) => part.type === "tool" && part.name === OUTPUT_TOOL)
  if (latest?.type !== "tool" || latest.state.status !== "completed") return undefined
  return { value: latest.state.input }
}

// The reason a failed run gives besides "error": the turn ended without the answer that was asked for.
export function failureReason(type: string | undefined) {
  return type === "output.missing" ? "invalid_output" : undefined
}

let resultWritten = false

/** Whether this process already printed its result object, so a late error report does not print a second. */
export function wroteResult() {
  return resultWritten
}

export function markResultWritten() {
  resultWritten = true
}

export type EnvelopeResult = {
  sessionID: string
  text: string
  failed: boolean
  /** Whether the run asked for a structured answer. */
  schema: unknown
  /** The accepted answer, from `structuredAnswer`. */
  structured: { value: unknown } | undefined
  subtype: string
  truncated: boolean
  outcome: "succeeded" | "failed" | "interrupted"
  reason: string | undefined
  error: string | undefined
  steps: number
  duration: number
  cost: number
  tokens: unknown
  rejected: unknown
}

// The result line of the envelope: what `writeResult` prints, plus how the run ended and what it used. `failed` says
// whether the run counts as failed, which includes an answer that does not follow the schema.
export function envelopeResultLine(run: EnvelopeResult) {
  // The run's own failure is what happened; a missing answer matters only when the run itself succeeded.
  const invalid = !run.failed && run.schema !== undefined && run.structured === undefined
  return {
    failed: run.failed || invalid,
    line: jsonLine({
      type: "result",
      sessionID: run.sessionID,
      is_error: run.failed || invalid,
      subtype: invalid && !run.failed ? "error" : run.subtype,
      outcome: run.outcome === "succeeded" && invalid ? "failed" : run.outcome,
      ...(run.reason === undefined && !invalid ? {} : { reason: run.reason ?? "invalid_output" }),
      result: run.text,
      ...(run.structured === undefined || run.failed ? {} : { structured_output: run.structured.value }),
      ...(run.error !== undefined
        ? { error: run.error }
        : invalid
          ? { error: "The run ended without an accepted structured answer." }
          : {}),
      steps: run.steps,
      duration_ms: run.duration,
      cost: run.cost,
      tokens: run.tokens,
      rejected: run.rejected,
      truncated: run.truncated,
    }),
  }
}
