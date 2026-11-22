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
 * is that first word where the caller has it apart, as an icon is. A line without one is drawn as plain text. A line
 * keeps every row it has: one that shrank would be painted over by the next (class 8).
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
        <text flexShrink={0} fg={props.fg} wrapMode={props.wrapMode ?? "word"}>
          {props.text}
        </text>
      }
    >
      {(value) => (
        <box width="100%" flexDirection="row" flexShrink={0}>
          <text flexShrink={0} fg={props.leadFg ?? props.fg}>
            {value()}
          </text>
          {/* Measured at what the lead leaves: measured at the whole row, it would count a row fewer than it takes. */}
          <text flexGrow={1} flexShrink={1} flexBasis={0} fg={props.fg} wrapMode={props.wrapMode ?? "word"}>
            {rest()}
          </text>
        </box>
      )}
    </Show>
  )
}
