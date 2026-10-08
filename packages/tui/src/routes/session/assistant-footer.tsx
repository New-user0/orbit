import type { RGBA } from "@opentui/core"
import type { SessionMessageAssistant } from "@orbit/client"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { bodyText } from "../../util/renderer"

const OUTCOME_LABEL = {
  retried: "retried",
  continued: "continued",
  truncated: "truncated at output limit",
} as const

/**
 * Presentation of the line under an assistant step. The route resolves the model name, duration and outcome and passes
 * them in; a retried or continued step hides its error line because a later step carried the run on.
 */
export function AssistantFooter(props: {
  agent: string
  color: RGBA
  model: string
  duration: number
  tokensPerSecond: number | undefined
  /** Error text of a failed step. */
  error: string | undefined
  retry: SessionMessageAssistant["retry"]
  interrupted: boolean
  outcome: keyof typeof OUTCOME_LABEL | undefined
  width: number
}) {
  const theme = useTheme()
  const showError = () =>
    props.error && !props.interrupted && !props.retry && props.outcome !== "retried" && props.outcome !== "continued"
  return (
    <>
      <Show when={showError()}>
        <box paddingLeft={3}>
          <text fg={theme.text.feedback.error.base}>Error: {bodyText(props.error!)}</text>
        </box>
      </Show>
      <AssistantRetry retry={props.retry} />
      <box paddingLeft={3} marginTop={props.retry || showError() ? 1 : 0}>
        <text>
          <span style={{ fg: props.error ? theme.text.muted : props.color }}>
            {bodyText(Locale.titlecase(props.agent))}
          </span>
          <Show when={props.width >= 28}>
            <span style={{ fg: theme.text.muted }}> · {bodyText(props.model)}</span>
          </Show>
          <Show when={props.duration && (props.width < 28 || props.width >= 36)}>
            <span style={{ fg: theme.text.muted }}> · {Locale.duration(props.duration)}</span>
          </Show>
          <Show when={props.tokensPerSecond}>
            {(value) => <span style={{ fg: theme.text.muted }}> · {value().toFixed(1)} tok/s</span>}
          </Show>
          <Show when={props.interrupted}>
            <span style={{ fg: theme.text.muted }}> · interrupted</span>
          </Show>
          <Show when={props.outcome}>
            {(outcome) => <span style={{ fg: theme.text.muted }}> · {bodyText(OUTCOME_LABEL[outcome()])}</span>}
          </Show>
        </text>
      </box>
    </>
  )
}

function AssistantRetry(props: { retry: SessionMessageAssistant["retry"] }) {
  const theme = useTheme()
  const [seconds, setSeconds] = createSignal(0)
  createEffect(() => {
    const at = props.retry?.at
    if (at === undefined) return
    const update = () => setSeconds(Math.max(0, Math.ceil((at - Date.now()) / 1_000)))
    if (update() === 0) return
    const timer = setInterval(() => {
      if (update() === 0) clearInterval(timer)
    }, 1_000)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <Show when={props.retry}>
      {(retry) => (
        <box paddingLeft={3}>
          <text fg={theme.text.feedback.warning.base}>
            ⚠ {seconds() > 0 ? `Retrying in ${seconds()}s` : "Retry due"} · attempt {retry().attempt} ·{" "}
            {bodyText(retry().error.message)}
          </text>
        </box>
      )}
    </Show>
  )
}
