import { EditBuffer } from "@opentui/core"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Offsets are the textarea's own cell counts (a newline one, a tab its tab width, a heart or a double exclamation
// mark two, an invisible direction mark one). Each grapheme is measured by an edit buffer of the same kind instead of
// a width table kept in step by hand, and the result is cached.
const cells = new Map<string, number>()
let probe: EditBuffer | undefined

export function promptOffsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) width += graphemeCells(part.segment)
  return width
}

function graphemeCells(grapheme: string) {
  if (grapheme === "\n" || (grapheme.length === 1 && grapheme >= " " && grapheme <= "~")) return 1
  const known = cells.get(grapheme)
  if (known !== undefined) return known
  probe ??= EditBuffer.create("unicode")
  probe.setText(grapheme)
  probe.setCursor(0, Number.MAX_SAFE_INTEGER)
  const measured = probe.getCursorPosition().offset
  cells.set(grapheme, measured)
  return measured
}

function displayOffsetIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + graphemeCells(part.segment)
    if (next > offset) return part.index
    width = next
  }

  return value.length
}

export function displaySlice(value: string, start = 0, end = promptOffsetWidth(value)) {
  return value.slice(displayOffsetIndex(value, start), displayOffsetIndex(value, end))
}

export function displayCharAt(value: string, offset: number) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + graphemeCells(part.segment)
    if (offset === width || offset < next) return part.segment
    width = next
  }
}

export function mentionTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  const text = displaySlice(value, 0, offset)
  const index = text.lastIndexOf("@")
  if (index === -1) return

  const before = index === 0 ? undefined : text[index - 1]
  const query = text.slice(index)
  if ((before === undefined || /\s/.test(before)) && !/\s/.test(query)) {
    return promptOffsetWidth(text.slice(0, index))
  }
}

export function slashTriggerIndex(value: string, offset = promptOffsetWidth(value)) {
  const text = displaySlice(value, 0, offset)
  for (let index = text.lastIndexOf("/"); index >= 0; index = text.lastIndexOf("/", index - 1)) {
    const before = index === 0 ? undefined : text[index - 1]
    const query = text.slice(index)
    if (before !== undefined && !/\s/.test(before)) continue
    if (/\s/.test(query) || query.slice(1).includes("/")) return
    return promptOffsetWidth(text.slice(0, index))
  }
}
