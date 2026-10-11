import type { LocationRef, SessionStructuredError, SessionTurnOptions } from "@orbit/client/promise"
import { jsonLine } from "@orbit/flow/plain"
import { SessionMessage } from "@orbit/schema/session-message"
import { Option, Schema } from "effect"
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
  return { text: `<file name="${file.filename}">\n${content}\n</file>` }
}

export function schemaInstruction(schema: unknown) {
  return [
    "Reply with only a JSON value that follows this JSON Schema, with no other text and no code fence:",
    JSON.stringify(schema, null, 2),
  ].join("\n")
}

export function unfence(text: string) {
  return text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")
}

// The notice that the runner publishes when it raises the output limit and answers again, with the message it replaces.
export const decodeEscalation = Schema.decodeUnknownOption(
  Schema.Struct({ notice: Schema.Literal("output-escalation"), replaces: SessionMessage.ID }),
)

export const decodeNotice = Schema.decodeUnknownOption(Schema.Struct({ notice: Schema.String }))

export const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// The finishes the server counts as a step when it checks a step limit.
export const countedFinishes = new Set<string>(["stop", "length", "tool-calls", "content-filter"])

// The limit that ended the run names its result subtype. `limit.cost-unknown` is the server refusing a cost limit it
// cannot count, which is a plain error, not a limit that was reached.
export function subtype(input: { failed: boolean; interrupted: boolean; limit: SessionStructuredError | undefined }) {
  if (input.interrupted) return "interrupted"
  const type = input.limit?.type
  if (type === "limit.steps") return "error_max_steps"
  if (type === "limit.tokens") return "error_max_tokens"
  if (type === "limit.cost") return "error_max_cost"
  return input.failed ? "error" : "success"
}

// Whether the prompt the server admitted carries what was asked for.
export function echoes(sent: SessionTurnOptions, admitted: SessionTurnOptions | undefined) {
  if (!admitted) return false
  const model = (value: SessionTurnOptions["fallbackModel"]) =>
    value && `${value.providerID}/${value.id}#${value.variant ?? ""}`
  return (
    sent.maxSteps === admitted.maxSteps &&
    sent.maxCost === admitted.maxCost &&
    sent.maxTokens === admitted.maxTokens &&
    model(sent.fallbackModel) === model(admitted.fallbackModel)
  )
}

export function parseJson(text: string): { value: unknown } | undefined {
  return Option.match(decodeJson(text), { onNone: () => undefined, onSome: (value) => ({ value }) })
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
  schema: unknown
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
  const parsed = run.schema === undefined ? undefined : parseJson(unfence(run.text))
  // The run's own failure is what happened; an answer that is not JSON matters only when the run itself succeeded.
  const invalid = !run.failed && run.schema !== undefined && parsed === undefined
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
      ...(parsed === undefined ? {} : { structured_output: parsed.value }),
      ...(run.error !== undefined ? { error: run.error } : invalid ? { error: "The answer was not valid JSON." } : {}),
      steps: run.steps,
      duration_ms: run.duration,
      cost: run.cost,
      tokens: run.tokens,
      rejected: run.rejected,
      truncated: run.truncated,
    }),
  }
}
