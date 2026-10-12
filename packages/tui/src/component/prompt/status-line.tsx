/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { createStatusLine } from "../../util/status-line"

/** The events after which something the status line shows has changed. */
export const STATUS_LINE_EVENTS = [
  "session.step.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

export type StatusLineBus = (
  type: (typeof STATUS_LINE_EVENTS)[number],
  handler: (event: { data: { sessionID: string } }) => void,
) => () => void

/**
 * A user-configured status line command, drawn under the prompt footer. It runs again when a step or an execution of
 * this session ends or starts (any session on the home screen) and when `watch()` changes, besides its interval.
 */
export function StatusLine(props: {
  readonly sessionID?: string
  readonly command: () => string | undefined
  readonly interval: () => number | undefined
  readonly colors: () => boolean | undefined
  readonly payload: () => Record<string, unknown>
  readonly on: StatusLineBus
  /** What else the line shows, such as the selected agent and model: it runs again when any of them changes. */
  readonly watch: () => ReadonlyArray<unknown>
  readonly fg: RGBA
  readonly run?: (command: string, stdin: string) => Promise<string | undefined>
}) {
  const statusLine = createStatusLine({
    command: props.command,
    interval: props.interval,
    colors: props.colors,
    payload: props.payload,
    run: props.run,
  })
  const offs = STATUS_LINE_EVENTS.map((type) =>
    props.on(type, (event) => {
      if (!props.sessionID || event.data.sessionID === props.sessionID) statusLine.trigger()
    }),
  )
  onCleanup(() => offs.forEach((off) => off()))
  createEffect(
    on(
      () => props.watch(),
      () => statusLine.trigger(),
      { defer: true },
    ),
  )
  return (
    <Show when={props.command() ? statusLine.spans() : undefined}>
      {(spans) => (
        <box paddingLeft={1} flexShrink={0}>
          <text fg={props.fg} wrapMode="none" truncate>
            <For each={spans()}>
              {(span) => <span style={{ fg: span.fg, bg: span.bg, attributes: span.attributes }}>{span.text}</span>}
            </For>
          </text>
        </box>
      )}
    </Show>
  )
}
