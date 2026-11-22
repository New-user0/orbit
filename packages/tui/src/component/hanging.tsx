/** @jsxImportSource @opentui/solid */
import type { ColorInput } from "@opentui/core"
import { Show } from "solid-js"

// The first words of the lines that carry a name a repository or a model chose.
const LEAD = /^(?:Link |Path: |Folder: |Resource: |Make |- )/

export function hangingLead(line: string) {
  return LEAD.exec(line)?.[0] ?? ""
}

/**
 * A line of an approval whose wrapped rows are indented under what follows its first word, so that only a line of
 * Orbit's own starts where a link warning starts: a name that is long enough to wrap cannot draw one (class 9). `lead`
 * is that first word where the caller has it apart, as an icon is. A line without one is drawn as plain text.
 */
export function Hanging(props: {
  text: string
  fg: ColorInput
  lead?: string
  leadFg?: ColorInput
  wrapMode?: "char" | "word"
}) {
  const lead = () => props.lead ?? hangingLead(props.text)
  const rest = () => (props.lead === undefined ? props.text.slice(lead().length) : props.text)
  return (
    <Show
      when={lead()}
      fallback={
        <text fg={props.fg} wrapMode={props.wrapMode ?? "word"}>
          {props.text}
        </text>
      }
    >
      {(value) => (
        <box width="100%" flexDirection="row">
          <text flexShrink={0} fg={props.leadFg ?? props.fg}>
            {value()}
          </text>
          <text flexShrink={1} fg={props.fg} wrapMode={props.wrapMode ?? "word"}>
            {rest()}
          </text>
        </box>
      )}
    </Show>
  )
}
