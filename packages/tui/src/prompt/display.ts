import { stringWidth } from "../util/string-width"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// The textarea gives these a cell count that terminal width does not: a newline one, a tab its tab width, and the
// invisible direction marks and soft hyphen one each.
const offsetCells: Record<string, number> = {
  "\n": 1,
  "\t": 2,
  [String.fromCharCode(0xad)]: 1,
  [String.fromCharCode(0x200e)]: 1,
  [String.fromCharCode(0x200f)]: 1,
}

export function promptOffsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) {
    width += offsetCells[part.segment] ?? stringWidth(part.segment)
  }
  return width
}

function displayOffsetIndex(value: string, offset: number) {
  if (offset <= 0) return 0

  let width = 0
  for (const part of graphemes.segment(value)) {
    const next = width + promptOffsetWidth(part.segment)
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
    const next = width + promptOffsetWidth(part.segment)
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
