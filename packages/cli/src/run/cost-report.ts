import type { ModelInfo } from "@orbit/client"
import type { OrbitClient } from "@orbit/client/promise"
import { SessionCost } from "@orbit/schema/session-cost"
import { jsonLine, plain } from "@orbit/flow/plain"
import { costSummary, money, NO_USAGE, price } from "@orbit/tui/util/cost"
import { Locale } from "@orbit/tui/util/locale"
import { errorMessage } from "../util/error"
import { UI } from "./ui"

// `orb run "/cost"` and `orb -p "/cost"`: the whole session's cost, as the reference prints it in its print mode, a block
// of plain lines with compact token figures, as the dialog shows them. The server sums the session and its subagents from
// stored rows, so the figures do not depend on how
// much history the run loaded. Every model name comes from a record or a provider, so each goes through `plain` (class 9).

const count = new Intl.NumberFormat("en-US")
const lines = (value: number) => `${count.format(value)} ${value === 1 ? "line" : "lines"}`

/**
 * The block `orb run "/cost"` prints. With the session's catalog, a response that recorded $0 for a model the catalog
 * lists without a price reads as unknown, as in the dialog; without one, only a response with no recorded cost does.
 */
export function costText(info: SessionCost.Info, models?: ReadonlyArray<ModelInfo>) {
  const summary = costSummary(info, models)
  const span = (value: number | undefined) => (value === undefined ? "-" : Locale.duration(value))
  const usage = summary.models.map((row) => {
    const name = `${plain(row.providerID)}/${plain(row.modelID)}`
    const tokens = [
      `${Locale.number(row.tokens.input)} input`,
      `${Locale.number(row.tokens.output)} output`,
      `${Locale.number(row.tokens.cache.read)} cache read`,
      `${Locale.number(row.tokens.cache.write)} cache write`,
      ...(row.tokens.reasoning > 0 ? [`${Locale.number(row.tokens.reasoning)} reasoning`] : []),
    ].join(", ")
    return `  ${name}:  ${tokens} (${price(row.cost, row.unpriced > 0)})`
  })
  const row = (label: string, value: string) => `${label.padEnd(22)} ${value}`
  return [
    row("Total cost:", price(summary.cost, summary.partial)),
    ...(summary.subagents === undefined ? [] : [row("Subagents:", `${money(summary.subagents)} (included above)`)]),
    row("Total API duration:", span(summary.api)),
    row("Total wall duration:", span(summary.wall)),
    ...(summary.lines === undefined
      ? []
      : [row("Total code changes:", `${lines(summary.lines.added)} added, ${lines(summary.lines.removed)} removed`)]),
    ...(summary.other === undefined
      ? []
      : [row("Other:", `${money(summary.other)} (undone responses, older usage)`)]),
    ...(usage.length > 0 ? ["Usage by model:", ...usage] : [row("Usage:", NO_USAGE)]),
  ].join("\n")
}

/** The line `--format json` prints: the summary as it came, with every string escaped as `jsonLine` does (class 9). */
export function costLine(sessionID: string, cost: SessionCost.Info) {
  return jsonLine({ type: "cost", sessionID, cost })
}

/**
 * Asks the server for a session's cost, and turns each way it can fail into one message: the server's own refusal (an
 * unknown session), a server older than the route, an answer that is not the summary, and no answer in time (classes 7
 * and 13). A row that does not decode is left out and named in `dropped`, so that it costs only itself.
 */
export async function readSessionCost(
  client: OrbitClient,
  sessionID: string,
  timeout: number,
): Promise<
  { readonly info: SessionCost.Info; readonly dropped: ReadonlyArray<string> } | { readonly error: string }
> {
  const signal = AbortSignal.timeout(timeout)
  const expired = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  )
  return Promise.race([client.session.cost({ sessionID }, { signal }), expired]).then(
    (value) => SessionCost.decode(value) ?? { error: "The server's answer about session cost could not be read" },
    (error: unknown) => ({ error: failure(error) }),
  )
}

/**
 * The session's model catalog, which tells a model without a price from a free one. It is optional: when the catalog
 * cannot be read in time, one line says so and the figures read as they would without it (class 7).
 */
export async function readCatalog(
  client: OrbitClient,
  location: { readonly directory: string },
  timeout: number,
): Promise<ReadonlyArray<ModelInfo> | undefined> {
  return client.model.list({ location }, { signal: AbortSignal.timeout(timeout) }).then(
    (answer) => answer.data,
    (error: unknown) => {
      UI.println(`Could not read the model catalog, so unpriced models may show $0: ${plain(errorMessage(error))}`)
      return undefined
    },
  )
}

function failure(error: unknown) {
  const named = (value: unknown, name: string) =>
    typeof value === "object" && value !== null && "name" in value && value.name === name
  if (named(error, "TimeoutError") || (error instanceof Error && named(error.cause, "TimeoutError")))
    return "The server did not answer in time"
  // A server from before the route answers 404 with no body. The route declares 404, so the client reads that body as
  // a typed error and finds no content type.
  if (error instanceof Error && error.name === "ClientError" && error.message === "UnsupportedContentType")
    return "The server is older than this client and does not report session cost"
  return errorMessage(error)
}
