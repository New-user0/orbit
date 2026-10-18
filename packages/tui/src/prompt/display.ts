import { EditBuffer, type WidthMethod } from "@opentui/core"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Offsets are the textarea's own cell counts (a newline one, a tab its tab width, a heart or a double exclamation
// mark two, an invisible direction mark one). Each grapheme is measured by an edit buffer in the width mode the caller
// names, because the renderer decides the textarea's mode (some terminals use wcwidth, most use unicode). One probe
// and one cache exist per mode; a caller without a renderer in reach gets "unicode".
const cells: Partial<Record<WidthMethod, Map<string, number>>> = {}
const probes: Partial<Record<WidthMethod, EditBuffer>> = {}

export function promptOffsetWidth(value: string, method: WidthMethod = "unicode") {
  let width = 0
  for (const part of graphemes.segment(value)) width += graphemeCells(part.segment, method)
  return width
}

function graphemeCells(grapheme: string, method: WidthMethod) {
  if (grapheme === "\n" || (grapheme.length === 1 && grapheme >= " " && grapheme <= "~")) return 1
  const cache = (cells[method] ??= new Map<string, number>())
  const known = cache.get(grapheme)
  if (known !== undefined) return known
  const probe = (probes[method] ??= EditBuffer.create(method))
  probe.setText(grapheme)
  probe.setCursor(0, Number.MAX_SAFE_INTEGER)
  const measured = probe.getCursorPosition().offset
  cache.set(grapheme, measured)
  return measured
}

function displayOffsetIndex(value: string, offset: number, method: WidthMethod) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + graphemeCells(part.segment, method)
    if (next > offset) return part.index
    width = next
  }

  return value.length
}

export function displaySlice(value: string, start = 0, end?: number, method: WidthMethod = "unicode") {
  return value.slice(
    displayOffsetIndex(value, start, method),
    displayOffsetIndex(value, end ?? promptOffsetWidth(value, method), method),
  )
}

export function displayCharAt(value: string, offset: number, method: WidthMethod = "unicode") {
  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + graphemeCells(part.segment, method)
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
