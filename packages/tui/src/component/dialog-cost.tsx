import { plain } from "@orbit/flow/plain"
import { TokenUsage } from "@orbit/schema/token-usage"
import { createMemo, For, Show } from "solid-js"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { costSummary, type CostSummary } from "../util/cost"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 })

/** A price that is not known reads "unknown"; a model the catalog prices at zero shows $0.00. Sub-cent spend shows to six places. */
const price = (value: number | undefined, partial = false) =>
  value === undefined ? "unknown" : `${money.format(value)}${partial ? " + unpriced" : ""}`

const span = (value: number | undefined) => (value === undefined ? "-" : Locale.duration(value))

/** /cost (alias /usage): what the session has cost, the tokens it used and where they went, by model. */
export function DialogCost(props: { readonly sessionID: string }) {
  const data = useData()
  const summary = createMemo(() => {
    const session = data.session.get(props.sessionID)
    if (!session) return
    return costSummary(
      session,
      data.session.message.list(props.sessionID) ?? [],
      data.location.model.list(session.location),
      data.session.message.more(props.sessionID),
    )
  })
  return <CostView summary={summary()} />
}

/** The dialog's layout, apart from the data store so that a story can draw it from a fixture. */
export function CostView(props: { readonly summary?: CostSummary }) {
  const theme = useTheme()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text.base} attributes={1}>
        Cost
      </text>
      <Show when={props.summary} fallback={<text fg={theme.text.muted}>No session is open.</text>}>
        {(value) => (
          <>
            <box>
              <Row label="Session cost" value={price(value().cost, value().partial)} />
              <Row label="Wall-clock time" value={span(value().wall)} />
              <Row label="API time" value={span(value().api)} />
            </box>
            <box>
              <Row label="Input tokens" value={Locale.number(value().tokens.input)} />
              <Row label="Output tokens" value={Locale.number(value().tokens.output)} />
              <Row label="Reasoning tokens" value={Locale.number(value().tokens.reasoning)} />
              <Row label="Cache read" value={Locale.number(value().tokens.cache.read)} />
              <Row label="Cache write" value={Locale.number(value().tokens.cache.write)} />
            </box>
            <Show when={value().loaded !== undefined}>
              <text fg={theme.text.muted}>
                {`The breakdown and API time cover only the ${value().loaded} newest loaded responses.`}
              </text>
            </Show>
            <Show
              when={value().models.length > 0}
              fallback={<text fg={theme.text.muted}>No model response yet in this session.</text>}
            >
              <box>
                <text fg={theme.text.base}>By model</text>
                <For each={value().models}>
                  {(row) => (
                    <box flexDirection="row" gap={1}>
                      {/* Names and IDs come from the server and its providers. */}
                      <text fg={theme.text.base}>{plain(row.name)}</text>
                      <text fg={theme.text.muted}>
                        {`${Locale.number(TokenUsage.total(row.tokens))} tokens · ${price(row.cost, row.unpriced > 0)}`}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={value().other !== undefined}>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.text.base}>Other</text>
                    <text fg={theme.text.muted}>{`${price(value().other)} · titles and other usage not itemized`}</text>
                  </box>
                </Show>
              </box>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

function Row(props: { readonly label: string; readonly value: string }) {
  const theme = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.muted}>{props.label.padEnd(16)}</text>
      <text fg={theme.text.base}>{props.value}</text>
    </box>
  )
}
