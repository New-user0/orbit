import { createMemo, For, Show } from "solid-js"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { contextBreakdown } from "../util/session"

const WIDTH = 24

/** /context: how full the session's context window is, and what fills it. */
export function DialogContext(props: { readonly sessionID: string }) {
  const data = useData()
  const theme = useTheme()
  const breakdown = createMemo(() => {
    const session = data.session.get(props.sessionID)
    if (!session) return
    return contextBreakdown(
      data.session.message.list(props.sessionID) ?? [],
      data.location.model.list(session.location),
      session.revert?.messageID,
    )
  })
  const bar = (tokens: number, of: number) => {
    const filled = Math.max(tokens > 0 ? 1 : 0, Math.round((tokens / Math.max(1, of)) * WIDTH))
    return `${"▮".repeat(Math.min(WIDTH, filled))}${"▯".repeat(Math.max(0, WIDTH - filled))}`
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text.base} attributes={1}>
        Context
      </text>
      <Show when={breakdown()} fallback={<text fg={theme.text.muted}>No model response yet in this session.</text>}>
        {(value) => (
          <box gap={0}>
            <text fg={theme.text.base}>
              {value().limit
                ? `${Locale.number(value().total)} of ${Locale.number(value().limit!)} tokens (${Math.round((value().total / value().limit!) * 100)}%)`
                : `${Locale.number(value().total)} tokens`}
            </text>
            <For each={value().rows}>
              {(row) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.brand.base}>{bar(row.tokens, value().limit ?? value().total)}</text>
                  <text fg={theme.text.base}>{Locale.number(row.tokens).padStart(8)}</text>
                  <text fg={theme.text.muted}>{row.label}</text>
                </box>
              )}
            </For>
            <Show when={value().limit}>
              {(limit) => (
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text.muted}>{bar(Math.max(0, limit() - value().total), limit())}</text>
                  <text fg={theme.text.base}>{Locale.number(Math.max(0, limit() - value().total)).padStart(8)}</text>
                  <text fg={theme.text.muted}>Free</text>
                </box>
              )}
            </Show>
            <text fg={theme.text.muted}>Conversation shares are estimates; the total is reported by the model.</text>
          </box>
        )}
      </Show>
    </box>
  )
}
