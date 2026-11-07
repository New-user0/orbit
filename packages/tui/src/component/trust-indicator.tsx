import type { TrustStatus } from "@orbit/client"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { asksTrust } from "../util/trust"

/** Shown while the folder in view is not trusted; opens the question of trusting it. */
export function TrustIndicator(props: { status: TrustStatus | undefined; onOpen: () => void }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const [hovered, setHovered] = createSignal(false)

  return (
    <Show when={asksTrust(props.status)}>
      <box
        flexShrink={0}
        flexDirection="row"
        gap={1}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={props.onOpen}
      >
        <text fg={theme.text.feedback.warning.base} wrapMode="none">
          ⊙ Untrusted
        </text>
        <Show when={dimensions().width >= 80}>
          <text fg={hovered() ? theme.text.base : theme.text.muted} wrapMode="none">
            /trust
          </text>
        </Show>
      </box>
    </Show>
  )
}
