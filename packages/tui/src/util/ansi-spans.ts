import { TextAttributes } from "@opentui/core"

export type AnsiSpan = {
  readonly text: string
  readonly fg?: string
  readonly bg?: string
  readonly attributes: number
}

type Style = { fg?: string; bg?: string; attributes: number }

const BASIC = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
]

// Every escape sequence in one pass: CSI (with its final byte), the single-byte C1 form of CSI, OSC and the other string
// sequences up to their terminator, and two-byte escapes. Only a CSI whose final byte is "m" (SGR) is kept.
const SEQUENCE =
  /\u001b\[([0-?]*)[ -/]*([@-~])|\u009b([0-?]*)[ -/]*([@-~])|(?:\u001b[\]PX^_]|[\u009d\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|\u001b[ -/]*[0-~]?/g

/**
 * Turns the output of a user's script into styled spans. SGR colors (16, 256 and truecolor foreground and background)
 * and bold, dim, italic and underline are kept. Every other escape sequence is dropped whole, so an OSC title or
 * clipboard write never reaches the renderer, and each remaining control character is written out as its control
 * picture (U+2400 block) so it can neither move the cursor nor hide text.
 */
export function ansiSpans(input: string): ReadonlyArray<AnsiSpan> {
  const spans: AnsiSpan[] = []
  let style: Style = { attributes: 0 }
  let last = 0
  const push = (raw: string) => {
    const text = visible(raw)
    if (!text) return
    const previous = spans.at(-1)
    if (previous && previous.fg === style.fg && previous.bg === style.bg && previous.attributes === style.attributes)
      spans[spans.length - 1] = { ...previous, text: previous.text + text }
    else spans.push({ text, fg: style.fg, bg: style.bg, attributes: style.attributes })
  }
  for (const match of input.matchAll(SEQUENCE)) {
    push(input.slice(last, match.index))
    last = match.index + match[0].length
    const params = match[1] ?? match[3]
    const final = match[2] ?? match[4]
    if (final === "m" && params !== undefined && /^[0-9;:]*$/.test(params)) style = sgr(style, params)
  }
  push(input.slice(last))
  return spans
}

/** The text of the output with every style and escape removed. */
export function ansiText(input: string) {
  return ansiSpans(input)
    .map((span) => span.text)
    .join("")
}

function visible(text: string) {
  return text.replace(/\t/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    const code = char.charCodeAt(0)
    if (code === 0x7f) return "␡"
    return String.fromCharCode(code < 0x20 ? 0x2400 + code : 0xfffd)
  })
}

function sgr(style: Style, params: string): Style {
  const codes = (params === "" ? "0" : params).split(/[;:]/).map((code) => (code === "" ? 0 : Number(code)))
  const next = { ...style }
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]
    if (code === 0) {
      next.fg = undefined
      next.bg = undefined
      next.attributes = 0
    } else if (code === 1) next.attributes |= TextAttributes.BOLD
    else if (code === 2) next.attributes |= TextAttributes.DIM
    else if (code === 3) next.attributes |= TextAttributes.ITALIC
    else if (code === 4) next.attributes |= TextAttributes.UNDERLINE
    else if (code === 22) next.attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM)
    else if (code === 23) next.attributes &= ~TextAttributes.ITALIC
    else if (code === 24) next.attributes &= ~TextAttributes.UNDERLINE
    else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30]
    else if (code >= 90 && code <= 97) next.fg = BASIC[code - 90 + 8]
    else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40]
    else if (code >= 100 && code <= 107) next.bg = BASIC[code - 100 + 8]
    else if (code === 39) next.fg = undefined
    else if (code === 49) next.bg = undefined
    else if (code === 38 || code === 48) {
      const color = extended(codes, index + 1)
      index += color.used
      if (color.value) next[code === 38 ? "fg" : "bg"] = color.value
    }
  }
  return next
}

function extended(codes: ReadonlyArray<number>, from: number) {
  if (codes[from] === 5) {
    const value = codes[from + 1]
    return { used: 2, value: value !== undefined && value >= 0 && value <= 255 ? palette(value) : undefined }
  }
  if (codes[from] === 2) {
    const channels = codes.slice(from + 1, from + 4)
    const ok = channels.length === 3 && channels.every((channel) => channel >= 0 && channel <= 255)
    return {
      used: 4,
      value: ok ? `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}` : undefined,
    }
  }
  return { used: 0, value: undefined }
}

function palette(index: number) {
  if (index < 16) return BASIC[index]
  if (index >= 232) {
    const level = (index - 232) * 10 + 8
    return `#${level.toString(16).padStart(2, "0").repeat(3)}`
  }
  const cube = index - 16
  const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40).toString(16).padStart(2, "0")
  return `#${channel(Math.floor(cube / 36))}${channel(Math.floor(cube / 6) % 6)}${channel(cube % 6)}`
}
