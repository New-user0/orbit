import { plain } from "@orbit/flow/plain"
import type { OrbitClient } from "@orbit/client"
import { SessionCost } from "@orbit/schema/session-cost"
import { createResource, For, Show } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLog } from "../context/log"
import { useTheme } from "../context/theme"
import { costSummary, NO_USAGE, price, type CostSummary } from "../util/cost"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"

const TIMEOUT = 30_000

const span = (value: number | undefined) => (value === undefined ? "-" : Locale.duration(value))
const lines = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`

type Answer = { readonly summary: CostSummary } | { readonly error: string }

/** /cost (alias /usage): what the session and its subagents have cost, the tokens they used and where they went, by model. */
export function DialogCost(props: { readonly sessionID: string; readonly timeout?: number }) {
  const client = useClient()
  const data = useData()
  const log = useLog({ component: "cost" })
  const [answer] = createResource(
    () => props.sessionID,
    async (sessionID): Promise<Answer> => {
      // The command is offered on a session route, where the session is already loaded; without it nothing is priced.
      const session = data.session.get(sessionID)
      const read = await readSessionCost(client.api, sessionID, props.timeout ?? TIMEOUT)
      if ("error" in read) return read
      if (read.dropped.length > 0) log.warn("Left out cost rows this client could not read", { dropped: read.dropped })
      return { summary: costSummary(read.info, session ? data.location.model.list(session.location) : undefined) }
    },
  )
  return (
    <CostView
      summary={(answer() as { summary?: CostSummary } | undefined)?.summary}
      error={(answer() as { error?: string } | undefined)?.error}
    />
  )
}

/**
 * Asks the server for a session's cost, and turns each way it can fail into one line a person can read: the server's own
 * refusal (an unknown session), a server older than the route, an answer that is not the summary, and no answer in time
 * (classes 7 and 13). A row that does not decode is left out and named in `dropped`, so that it costs only itself.
 */
async function readSessionCost(api: OrbitClient, sessionID: string, timeout: number) {
  const signal = AbortSignal.timeout(timeout)
  const expired = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  )
  return Promise.race([api.session.cost({ sessionID }, { signal }), expired]).then(
    (value) => SessionCost.decode(value) ?? { error: "The server's answer about session cost could not be read." },
    (error: unknown) => ({ error: failure(error) }),
  )
}

function failure(error: unknown) {
  const named = (value: unknown, name: string) =>
    typeof value === "object" && value !== null && "name" in value && value.name === name
  if (named(error, "TimeoutError") || (error instanceof Error && named(error.cause, "TimeoutError")))
    return "The server did not answer in time."
  // A typed refusal: the server's message, which names the session.
  if (typeof error === "object" && error !== null && "_tag" in error) return plain(errorMessage(error))
  // A server from before the route answers 404 with no body. The route declares 404, so the client reads that body as
  // a typed error and finds no content type.
  if (error instanceof Error && error.name === "ClientError" && error.message === "UnsupportedContentType")
    return "The server is older than this client and does not report session cost."
  return plain(`Could not read session cost: ${errorMessage(error)}`)
}

/** The dialog's layout, apart from the request so that a story can draw it from a fixture. */
export function CostView(props: { readonly summary?: CostSummary; readonly error?: string }) {
  const theme = useTheme()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text.base} attributes={1}>
        Cost
      </text>
      <Show when={props.error}>{(message) => <text fg={theme.text.feedback.error.base}>{message()}</text>}</Show>
      <Show when={!props.error && !props.summary}>
        <text fg={theme.text.muted}>Reading the cost…</text>
      </Show>
      <Show when={props.summary}>
        {(value) => (
          <>
            <box>
              <Row label="Total cost" value={price(value().cost, value().partial)} />
              <Show when={value().subagents !== undefined}>
                <Row label="Subagents" value={`${price(value().subagents)} (included above)`} />
              </Show>
              <Row label="API time" value={span(value().api)} />
              <Row label="Wall time" value={span(value().wall)} />
              <Show when={value().lines}>
                {(changed) => (
                  <Row
                    label="Code changes"
                    value={`${lines(changed().added)} added, ${lines(changed().removed)} removed`}
                  />
                )}
              </Show>
            </box>
            <Show
              when={value().models.length > 0}
              fallback={
                <box>
                  <text fg={theme.text.base}>By model</text>
                  <text fg={theme.text.muted}>{`  Usage: ${NO_USAGE}`}</text>
                  <Other value={value().other} />
                </box>
              }
            >
              <box>
                <text fg={theme.text.base}>By model</text>
                <For each={value().models}>
                  {(row) => (
                    <box>
                      <box flexDirection="row" gap={1}>
                        {/* Names and IDs come from the server, its records and its providers. */}
                        <text fg={theme.text.base}>{plain(row.name)}</text>
                        {/* One model at two providers keeps two rows, so the provider tells them apart. */}
                        <text fg={theme.text.muted}>{`· ${plain(row.providerID)}`}</text>
                        <text fg={theme.text.muted}>{price(row.cost, row.unpriced > 0)}</text>
                      </box>
                      <text fg={theme.text.muted}>{`  ${tokens(row.tokens)}`}</text>
                    </box>
                  )}
                </For>
                <Other value={value().other} />
              </box>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

function tokens(value: CostSummary["models"][number]["tokens"]) {
  return [
    `${Locale.number(value.input)} input`,
    `${Locale.number(value.output)} output`,
    `${Locale.number(value.cache.read)} cache read`,
    `${Locale.number(value.cache.write)} cache write`,
    ...(value.reasoning > 0 ? [`${Locale.number(value.reasoning)} reasoning`] : []),
  ].join(", ")
}

function Other(props: { readonly value: number | undefined }) {
  const theme = useTheme()
  return (
    <Show when={props.value}>
      {(value) => (
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.base}>Other</text>
          <text fg={theme.text.muted}>{`${price(value())} · undone responses, older usage`}</text>
        </box>
      )}
    </Show>
  )
}

function Row(props: { readonly label: string; readonly value: string }) {
  const theme = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.muted}>{props.label.padEnd(14)}</text>
      <text fg={theme.text.base}>{props.value}</text>
    </box>
  )
}
