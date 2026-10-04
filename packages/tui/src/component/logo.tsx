import { TextAttributes } from "@opentui/core"
import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { mark } from "../logo"

/** The mark with the wordmark beside it. */
export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={dimensions().height >= 12}>
      <box flexDirection="row" alignItems="center" gap={2}>
        <box flexShrink={0}>
          <text fg={theme.brand.base} selectable={false}>
            {mark.top}
          </text>
          <text selectable={false}>
            <span style={{ fg: theme.text.muted }}>{mark.ring}</span>
            <span style={{ fg: theme.brand.base }}>{mark.planet}</span>
            <span style={{ fg: theme.text.muted }}>{mark.ring}</span>
            <span style={{ fg: theme.text.base }}>{mark.moon}</span>
          </text>
          <text fg={theme.brand.base} selectable={false}>
            {mark.bottom}
          </text>
        </box>
        <Show when={dimensions().width >= 30}>
          <text fg={theme.brand.base} attributes={TextAttributes.BOLD} selectable={false}>
            Orbit
          </text>
        </Show>
      </box>
    </Show>
  )
}
