export * as Vim from "./vim-state"

/**
 * Vim-style editing for the prompt, as a pure engine. Insert mode is the ordinary editor; Escape enters normal mode,
 * where keys move and edit instead of typing. The engine reads a snapshot of the prompt (text, cursor, parts) and a key,
 * and returns the next state plus what to do: edits to apply, the new cursor and the mode. It knows nothing of the
 * renderer, so the adapter in `index.tsx` applies the edits through the textarea and tests drive it over a string.
 *
 * Every offset here is a UTF-16 index into `text` that sits on a grapheme boundary. The textarea counts display width
 * instead, so the adapter converts at its edge.
 */

export type Mode = "insert" | "normal"
export type Operator = "d" | "c" | "y"

/** A prompt part (mention, pasted-text summary, image chip) that edits and motions treat as one atomic unit. */
export interface Part {
  readonly start: number
  readonly end: number
}

/** Replace `text.slice(start, end)` with `insert`. Edits in one result are sorted and never overlap. */
export interface Edit {
  readonly start: number
  readonly end: number
  readonly insert: string
}

export type Pending =
  | { readonly kind: "idle" }
  | { readonly kind: "count"; readonly count: number }
  /** `count` is the count typed before the operator, `inner` the one typed after it; zero means none. */
  | { readonly kind: "operator"; readonly operator: Operator; readonly count: number; readonly inner: number }
  | { readonly kind: "object"; readonly operator: Operator; readonly count: number; readonly around: boolean }
  | { readonly kind: "g"; readonly count: number }
  | { readonly kind: "operatorG"; readonly operator: Operator; readonly count: number }
  | { readonly kind: "replace"; readonly count: number }
  | { readonly kind: "shift"; readonly shift: ">" | "<"; readonly count: number }
  /** After a double quote: waiting for the register name. */
  | { readonly kind: "register" }

export interface State {
  readonly mode: Mode
  readonly pending: Pending
  /** Set by `"+`: the next yank, delete or paste goes through the system clipboard. */
  readonly clipboard: boolean
  /** The unnamed register. Text that ends with a line break is linewise. Never persisted. */
  readonly register: string
}

export const initial: State = { mode: "insert", pending: { kind: "idle" }, clipboard: false, register: "" }

export interface Snapshot {
  readonly text: string
  readonly cursor: number
  readonly parts: readonly Part[]
  /** Where the cursor lands after moving one display row, for `gj` and `gk`. */
  readonly row?: (cursor: number, direction: "up" | "down") => number
}

export interface Key {
  readonly name: string
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
  readonly sequence?: string
}

/** What a completed command was, so that a later task can replay it. Nothing records these yet. */
export interface Command {
  readonly command: string
  readonly operator?: Operator
  readonly motion?: string
  readonly object?: string
  readonly count: number
}

export interface Result {
  readonly state: State
  readonly edits: readonly Edit[]
  /** The cursor in the text after the edits. */
  readonly cursor: number
  /** Not a vim key: let the ordinary editor have it (Enter, Escape, idle arrows). */
  readonly pass?: boolean
  /** Run the textarea's undo. */
  readonly undo?: boolean
  readonly clipboard?: { readonly write: string } | { readonly read: { readonly before: boolean; readonly count: number } }
  readonly record?: Command
}

export const COUNT_LIMIT = 10000

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function apply(text: string, edits: readonly Edit[]) {
  return edits.reduceRight((value, edit) => value.slice(0, edit.start) + edit.insert + value.slice(edit.end), text)
}

/**
 * The text that a clipboard read may paste: only a text result with something in it. Windows hands back CRLF, and a
 * lone CR is a line break too, so both become LF.
 */
export function clipboardText(content: { readonly data: string; readonly mime: string } | undefined) {
  if (!content || !content.mime.startsWith("text/") || !content.data) return
  return content.data.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Where the cursor goes when Escape leaves insert mode: one grapheme left, except at the start of a line. */
export function leaveInsert(snap: Snapshot) {
  if (snap.cursor <= 0 || snap.text[snap.cursor - 1] === "\n") return snap.cursor
  return context(snap).prev(snap.cursor)
}

/** Pastes `text` (an unnamed register or clipboard value) as `p` or `P` would. */
export function paste(state: State, snap: Snapshot, text: string, before: boolean, count: number): Result {
  const ctx = context(snap)
  const cursor = ctx.snap(snap.cursor)
  if (!text) return stay(state, cursor)
  const n = Math.max(1, count)
  const record = { command: before ? "P" : "p", count: n }
  if (text.endsWith("\n")) {
    const lines = Array.from({ length: n }, () => text.slice(0, -1)).join("\n")
    if (before) {
      const at = ctx.lineStart(cursor)
      return result(state, { edits: [{ start: at, end: at, insert: lines + "\n" }], cursor: at, record })
    }
    const at = ctx.lineEnd(cursor)
    return result(state, { edits: [{ start: at, end: at, insert: "\n" + lines }], cursor: at + 1, record })
  }
  const at = before || cursor >= ctx.len || snap.text[cursor] === "\n" ? cursor : ctx.next(cursor)
  const insert = text.repeat(n)
  const last = [...segmenter.segment(insert)].at(-1)?.index ?? 0
  return result(state, { edits: [{ start: at, end: at, insert }], cursor: at + last, record })
}

/**
 * Handles one key in normal mode. `pass` marks a key that is not a vim command and goes to the ordinary editor.
 */
export function step(state: State, key: Key, snap: Snapshot): Result {
  const ctx = context(snap)
  const cursor = ctx.snap(snap.cursor)
  if (key.ctrl || key.meta) return { state, edits: [], cursor, pass: true }
  const char = typed(key)
  const pending = state.pending
  if (!char && (key.name === "escape" || key.name === "return" || key.name === "enter"))
    return { state: reset(state), edits: [], cursor, pass: true }

  const arrow = char ? undefined : ARROWS[key.name]
  if (arrow && pending.kind === "idle") return { state, edits: [], cursor, pass: true }
  const cancel = pending.kind === "replace" && !char && (key.name === "backspace" || key.name === "delete")
  if (cancel) return stay(reset(state), cursor)

  // Arrows act as h j k l while a count or an operator waits for a motion, Backspace as h, Delete as x.
  const motionState = pending.kind === "idle" || pending.kind === "count" || pending.kind === "operator"
  const ch =
    char ??
    (arrow && (pending.kind === "count" || pending.kind === "operator") ? arrow : undefined) ??
    (key.name === "backspace" && motionState ? "h" : undefined) ??
    (key.name === "delete" && pending.kind === "idle" ? "x" : undefined)
  if (!ch) return stay(reset(state), cursor)

  const run = { state, ctx, cursor, snap }
  switch (pending.kind) {
    case "register":
      if (ch === "+") return stay({ ...state, pending: { kind: "idle" }, clipboard: true }, cursor)
      if (ch === '"') return stay({ ...state, pending: { kind: "idle" }, clipboard: false }, cursor)
      return stay(reset(state), cursor)
    case "replace":
      return replace(run, pending.count || 1, ch)
    case "shift":
      if (ch !== pending.shift) return stay(reset(state), cursor)
      return shift(run, pending.shift, pending.count || 1)
    case "g":
      if (ch === "g") return motion(run, "gg", pending.count)
      if (ch === "j" || ch === "k") return motion(run, "g" + ch, pending.count)
      return stay(reset(state), cursor)
    case "operatorG":
      if (ch === "g") return operatorMotion(run, pending.operator, "gg", pending.count)
      if (ch === "j" || ch === "k") return operatorMotion(run, pending.operator, "g" + ch, pending.count)
      return stay(reset(state), cursor)
    case "object":
      return operatorObject(run, pending.operator, ch, pending.around)
    case "operator":
      return operatorKey(run, pending, ch)
    default:
      return normalKey(run, pending.kind === "count" ? pending.count : 0, ch)
  }
}

interface Run {
  readonly state: State
  readonly ctx: Context
  readonly cursor: number
  readonly snap: Snapshot
}

const ARROWS: Partial<Record<string, string>> = { left: "h", down: "j", up: "k", right: "l" }

function typed(key: Key) {
  if (key.sequence) {
    const parts = [...segmenter.segment(key.sequence)]
    const code = key.sequence.codePointAt(0) ?? 0
    if (parts.length === 1 && code >= 32 && code !== 127) return key.sequence
  }
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name
}

const reset = (state: State): State => ({ ...state, pending: { kind: "idle" }, clipboard: false })
const stay = (state: State, cursor: number): Result => ({ state, edits: [], cursor })
const extend = (count: number, digit: number) => Math.min(COUNT_LIMIT, count * 10 + digit)
const isDigit = (ch: string) => ch.length === 1 && ch >= "0" && ch <= "9"

/** A finished command: back to idle, with the clipboard prefix spent and the register possibly replaced. */
function result(
  state: State,
  input: {
    edits?: readonly Edit[]
    cursor: number
    mode?: Mode
    register?: string
    record?: Command
    undo?: boolean
    clipboard?: Result["clipboard"]
  },
): Result {
  const write = input.register !== undefined && state.clipboard ? { write: input.register } : undefined
  return {
    state: {
      mode: input.mode ?? state.mode,
      pending: { kind: "idle" },
      clipboard: false,
      register: input.register ?? state.register,
    },
    edits: input.edits ?? [],
    cursor: input.cursor,
    undo: input.undo,
    record: input.record,
    clipboard: input.clipboard ?? write,
  }
}

/** The cursor never rests past the start of the last grapheme of the text. */
function clampCursor(text: string, cursor: number) {
  const last = [...segmenter.segment(text)].at(-1)?.index ?? 0
  return Math.min(cursor, last)
}

function normalKey(run: Run, count: number, ch: string): Result {
  const { state, ctx, cursor } = run
  const n = count || 1
  const pend = (pending: Pending): Result => stay({ ...state, pending }, cursor)

  if (isDigit(ch) && (ch !== "0" || count > 0)) return pend({ kind: "count", count: extend(count, Number(ch)) })
  if (ch === '"' && count === 0) return pend({ kind: "register" })
  if (ch === "d" || ch === "c" || ch === "y") return pend({ kind: "operator", operator: ch, count, inner: 0 })
  if (ch === "g") return pend({ kind: "g", count })
  if (ch === "r") return pend({ kind: "replace", count })
  if (ch === ">" || ch === "<") return pend({ kind: "shift", shift: ch, count })
  if (MOTIONS.has(ch)) return motion(run, ch, count)

  const lineIndex = ctx.lineIndex(cursor)
  switch (ch) {
    case "x":
      return deleteGraphemes(run, n, "x", false)
    case "X":
      return deleteGraphemes(run, n, "X", false, true)
    case "s":
      return deleteGraphemes(run, n, "s", true)
    case "D":
      return operatorMotion(run, "d", "$", 1, "D")
    case "C":
      return operatorMotion(run, "c", "$", 1, "C")
    case "Y":
      return lines(run, "y", lineIndex, lineIndex + n - 1, "Y", n)
    case "S":
      return lines(run, "c", lineIndex, lineIndex + n - 1, "S", n)
    case "~":
      return toggle(run, n)
    case "J":
      return join(run, n)
    case "p":
    case "P": {
      if (state.clipboard)
        return result(state, { cursor, clipboard: { read: { before: ch === "P", count: n } } })
      return paste(reset(state), run.snap, state.register, ch === "P", n)
    }
    case "u":
      return result(state, { cursor, undo: true })
    case "o":
    case "O": {
      const at = ch === "o" ? ctx.lineEnd(cursor) : ctx.lineStart(cursor)
      return result(state, {
        edits: [{ start: at, end: at, insert: "\n" }],
        cursor: ch === "o" ? at + 1 : at,
        mode: "insert",
        record: { command: ch, count: 1 },
      })
    }
    case "i":
      return result(state, { cursor, mode: "insert" })
    case "I":
      return result(state, { cursor: ctx.firstNonBlank(cursor), mode: "insert" })
    case "a":
      return result(state, {
        cursor: cursor >= ctx.len || run.snap.text[cursor] === "\n" ? cursor : ctx.next(cursor),
        mode: "insert",
      })
    case "A":
      return result(state, { cursor: ctx.lineEnd(cursor), mode: "insert" })
  }
  return stay(reset(state), cursor)
}

const MOTIONS = new Set(["h", "j", "k", "l", "w", "b", "e", "W", "B", "E", "0", "^", "$", "G"])

/** A motion with no operator: only the cursor moves. */
function motion(run: Run, name: string, count: number): Result {
  const target = run.ctx.target(name, count || 1, run.cursor, run.snap)
  return result(run.state, { cursor: target ?? run.cursor })
}

function operatorKey(run: Run, pending: Extract<Pending, { kind: "operator" }>, ch: string): Result {
  const { state, ctx, cursor } = run
  const total = Math.min(COUNT_LIMIT, (pending.count || 1) * (pending.inner || 1))
  if (isDigit(ch) && (ch !== "0" || pending.inner > 0))
    return stay({ ...state, pending: { ...pending, inner: extend(pending.inner, Number(ch)) } }, cursor)
  if (ch === pending.operator) {
    // A count between the operator and its double is not understood.
    if (pending.inner > 0) return stay(reset(state), cursor)
    const first = ctx.lineIndex(cursor)
    return lines(run, pending.operator, first, first + (pending.count || 1) - 1, pending.operator + pending.operator, pending.count || 1)
  }
  if (ch === "g") return stay({ ...state, pending: { kind: "operatorG", operator: pending.operator, count: total } }, cursor)
  if (ch === "i" || ch === "a")
    return stay({ ...state, pending: { kind: "object", operator: pending.operator, count: total, around: ch === "a" } }, cursor)
  if (MOTIONS.has(ch)) return operatorMotion(run, pending.operator, ch, total)
  return stay(reset(state), cursor)
}

function operatorMotion(run: Run, operator: Operator, name: string, count: number, command?: string): Result {
  const { state, ctx, cursor } = run
  const n = count || 1
  const record = { command: command ?? operator, operator, motion: name, count: n }
  const idle = stay(reset(state), cursor)

  // Linewise motions: whole lines from the cursor's line to the target line.
  if (name === "j" || name === "k" || name === "G" || name === "gg") {
    const line = ctx.lineIndex(cursor)
    const last = ctx.lineStarts.length - 1
    if (name === "j" && line === last) return idle
    if (name === "k" && line === 0) return idle
    const other =
      name === "j"
        ? Math.min(last, line + n)
        : name === "k"
          ? Math.max(0, line - n)
          : name === "G"
            ? n > 1
              ? Math.min(n, last + 1) - 1
              : last
            : n > 1
              ? Math.min(n, last + 1) - 1
              : 0
    return lines(run, operator, Math.min(line, other), Math.max(line, other), command ?? operator, n, record)
  }

  const range = ctx.motionRange(operator, name, n, cursor, run.snap)
  if (!range || range.start === range.end) return idle
  return operate(run, operator, ctx.widen(range), record)
}

function operatorObject(run: Run, operator: Operator, kind: string, around: boolean): Result {
  const { state, ctx, cursor } = run
  const found = ctx.object(kind, around, cursor)
  if (!found) return stay(reset(state), cursor)
  return operate(run, operator, ctx.widen(found), { command: operator, operator, object: (around ? "a" : "i") + kind, count: 1 }, true)
}

/** Applies an operator to a characterwise range. */
function operate(run: Run, operator: Operator, range: { start: number; end: number }, record: Command, allowEmpty = false): Result {
  const { state, snap } = run
  const text = snap.text.slice(range.start, range.end)
  if (!text) {
    if (operator === "c" && allowEmpty) return result(state, { cursor: range.start, mode: "insert", record })
    return stay(reset(state), run.cursor)
  }
  if (operator === "y") return result(state, { cursor: range.start, register: text, record })
  const edits = [{ start: range.start, end: range.end, insert: "" }]
  if (operator === "c") return result(state, { edits, cursor: range.start, mode: "insert", register: text, record })
  return result(state, {
    edits,
    cursor: clampCursor(apply(snap.text, edits), range.start),
    register: text,
    record,
  })
}

/** Applies an operator to whole lines `first` to `last` (clamped to the text). */
function lines(run: Run, operator: Operator, first: number, last: number, command: string, count: number, record?: Command): Result {
  const { state, ctx, snap } = run
  const end = Math.min(last, ctx.lineStarts.length - 1)
  const start = ctx.lineStarts[first]!
  const stop = ctx.lineEnd(ctx.lineStarts[end]!)
  const register = snap.text.slice(start, stop) + "\n"
  const rec = record ?? { command, operator, count }
  if (operator === "y") return result(state, { cursor: start, register, record: rec })
  if (operator === "c")
    return result(state, { edits: [{ start, end: stop, insert: "" }], cursor: start, mode: "insert", register, record: rec })
  // The lines go with one of their line breaks; at the end of the text it is the one before them.
  const edits =
    stop < ctx.len
      ? [{ start, end: stop + 1, insert: "" }]
      : [{ start: Math.max(0, start - 1), end: stop, insert: "" }]
  return result(state, {
    edits,
    cursor: clampCursor(apply(snap.text, edits), edits[0]!.start),
    register,
    record: rec,
  })
}

/** `x`, `X` and `s`: graphemes on the cursor's line, into the register. */
function deleteGraphemes(run: Run, n: number, command: string, enter: boolean, backward = false): Result {
  const { state, ctx, cursor, snap } = run
  const record = { command, count: n }
  const bound = backward ? ctx.lineStart(cursor) : ctx.lineEnd(cursor)
  const edge = (() => {
    let p = cursor
    for (let i = 0; i < n; i++) {
      const q = backward ? ctx.prev(p) : ctx.next(p)
      if (backward ? q < bound : q > bound) break
      p = q
    }
    return p
  })()
  const range = backward ? { start: edge, end: cursor } : { start: cursor, end: edge }
  const wide = ctx.widen(range)
  const text = snap.text.slice(wide.start, wide.end)
  if (!text) return enter ? result(state, { cursor, mode: "insert", record }) : stay(reset(state), cursor)
  const edits = [{ start: wide.start, end: wide.end, insert: "" }]
  return result(state, {
    edits,
    cursor: enter ? wide.start : clampCursor(apply(snap.text, edits), wide.start),
    mode: enter ? "insert" : undefined,
    register: text,
    record,
  })
}

/** `r`: replaces n graphemes on the line; with fewer than n left, nothing changes. */
function replace(run: Run, n: number, char: string): Result {
  const { state, ctx, cursor, snap } = run
  const cells = ctx.cells(cursor, ctx.lineEnd(cursor), n)
  if (cells.length < n) return stay(reset(state), cursor)
  const edits = cells.filter((cell) => !cell.part).map((cell) => ({ start: cell.start, end: cell.end, insert: char }))
  const last = cells[cells.length - 1]!
  const shift = edits.filter((edit) => edit.start < last.start).reduce((sum, edit) => sum + edit.insert.length - (edit.end - edit.start), 0)
  return result(state, { edits, cursor: last.start + shift, record: { command: "r", count: n } })
}

/** `~`: toggles the case of n graphemes on the line and moves just past them. */
function toggle(run: Run, n: number): Result {
  const { state, ctx, cursor, snap } = run
  const cells = ctx.cells(cursor, ctx.lineEnd(cursor), n)
  if (cells.length === 0) return stay(reset(state), cursor)
  const edits = cells.flatMap((cell) => {
    if (cell.part) return []
    const value = snap.text.slice(cell.start, cell.end)
    const next = value === value.toUpperCase() ? value.toLowerCase() : value.toUpperCase()
    return next === value ? [] : [{ start: cell.start, end: cell.end, insert: next }]
  })
  const delta = edits.reduce((sum, edit) => sum + edit.insert.length - (edit.end - edit.start), 0)
  return result(state, { edits, cursor: cells[cells.length - 1]!.end + delta, record: { command: "~", count: n } })
}

/** `J`: joins the cursor's line with the next n lines. The count is the number of lines appended. */
function join(run: Run, n: number): Result {
  const { state, ctx, cursor, snap } = run
  const line = ctx.lineIndex(cursor)
  if (line >= ctx.lineStarts.length - 1) return stay(reset(state), cursor)
  const first = ctx.lineStarts[line]!
  const joinAt = ctx.lineEnd(first)
  const head = snap.text.slice(first, joinAt)
  const edits: Edit[] = []
  let at = joinAt
  let empty = head === ""
  let spaced = head.endsWith(" ")
  for (let k = line + 1; k <= Math.min(line + n, ctx.lineStarts.length - 1); k++) {
    const start = ctx.lineStarts[k]!
    const end = ctx.lineEnd(start)
    const body = start + (snap.text.slice(start, end).length - snap.text.slice(start, end).trimStart().length)
    if (body === end) {
      edits.push({ start: at, end, insert: "" })
      at = end
      continue
    }
    edits.push({ start: at, end: body, insert: empty || spaced ? "" : " " })
    empty = false
    spaced = snap.text.slice(start, end).endsWith(" ")
    at = end
  }
  return result(state, { edits: edits.filter((edit) => edit.end > edit.start || edit.insert), cursor: joinAt, record: { command: "J", count: n } })
}

/** `>>` and `<<`: shift n lines from the cursor's line by two columns. */
function shift(run: Run, direction: ">" | "<", n: number): Result {
  const { state, ctx, cursor, snap } = run
  const line = ctx.lineIndex(cursor)
  const edits = ctx.lineStarts.slice(line, line + n).flatMap((start): Edit[] => {
    const end = ctx.lineEnd(start)
    const body = snap.text.slice(start, end)
    if (direction === ">") return body ? [{ start, end: start, insert: "  " }] : []
    const width = body.startsWith("  ") ? 2 : body.startsWith("\t") ? 1 : (/^\s{1,2}/.exec(body)?.[0].length ?? 0)
    return width ? [{ start, end: start + width, insert: "" }] : []
  })
  const next = apply(snap.text, edits)
  const lineStart = ctx.lineStarts[line]!
  const rest = next.slice(lineStart)
  const eol = rest.indexOf("\n") < 0 ? rest.length : rest.indexOf("\n")
  const indent = rest.slice(0, eol).length - rest.slice(0, eol).trimStart().length
  return result(state, {
    edits,
    cursor: lineStart + (indent === eol ? 0 : indent),
    record: { command: direction + direction, count: n },
  })
}

// --- text analysis ---

type Context = ReturnType<typeof context>

function context(snap: Snapshot) {
  const text = snap.text
  const len = text.length
  const starts = [...segmenter.segment(text)].map((item) => item.index)
  starts.push(len)
  const parts = snap.parts

  /** Largest grapheme start at or before i. */
  const floor = (i: number) => {
    if (i >= len) return len
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= i) lo = mid
      else hi = mid - 1
    }
    return starts[lo]!
  }
  const partAt = (i: number) => parts.find((part) => part.start <= i && i < part.end)
  const inside = (i: number) => parts.find((part) => part.start < i && i < part.end)
  const snapTo = (i: number) => {
    const at = floor(Math.max(0, Math.min(i, len)))
    return inside(at)?.start ?? at
  }
  const next = (i: number) => {
    if (i >= len) return len
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid]! > i) hi = mid
      else lo = mid + 1
    }
    const n = starts[lo]!
    return inside(n)?.end ?? n
  }
  const prev = (i: number) => {
    if (i <= 0) return 0
    const p = floor(i - 1)
    return inside(p)?.start ?? p
  }
  const lineStart = (i: number) => (i <= 0 ? 0 : text.lastIndexOf("\n", i - 1) + 1)
  const lineEnd = (i: number) => {
    const k = text.indexOf("\n", i)
    return k < 0 ? len : k
  }
  const lineStarts = [0, ...Array.from(text.matchAll(/\n/g), (match) => match.index + 1)]
  const lineIndex = (i: number) => lineStarts.filter((start) => start <= i).length - 1
  const firstNonBlank = (i: number) => {
    const start = lineStart(i)
    const end = lineEnd(i)
    let q = start
    while (q < end && (text[q] === " " || text[q] === "\t")) q++
    return q === end ? start : q
  }

  /** 0 is whitespace, 1 a word character, 2 punctuation, 3 a prompt part. For a WORD, everything non-blank is 1. */
  const cls = (i: number, big: boolean) => {
    if (i >= len) return 0
    if (partAt(i)) return 3
    const first = String.fromCodePoint(text.codePointAt(i)!)
    if (/\s/u.test(first)) return 0
    if (big) return 1
    return /[\p{L}\p{N}\p{M}_]/u.test(first) ? 1 : 2
  }

  const wordForward = (p: number, big: boolean) => {
    if (p >= len) return len
    const c = cls(p, big)
    let q = p
    if (c !== 0) while (q < len && cls(q, big) === c) q = next(q)
    while (q < len && cls(q, big) === 0) q = next(q)
    return q
  }
  const wordBack = (p: number, big: boolean) => {
    if (p <= 0) return 0
    let q = prev(p)
    while (q > 0 && cls(q, big) === 0) q = prev(q)
    const c = cls(q, big)
    if (c === 0) return q
    while (q > 0 && cls(prev(q), big) === c) q = prev(q)
    return q
  }
  const wordEnd = (p: number, big: boolean) => {
    if (p >= len) return p
    let q = next(p)
    while (q < len && cls(q, big) === 0) q = next(q)
    if (q >= len) return Math.max(p, prev(len))
    const c = cls(q, big)
    while (next(q) < len && cls(next(q), big) === c) q = next(q)
    return q
  }
  const down = (p: number) => {
    const end = lineEnd(p)
    if (end >= len) return len
    const col = p - lineStart(p)
    const start = end + 1
    return snapTo(Math.min(start + col, lineEnd(start)))
  }
  const up = (p: number) => {
    const start = lineStart(p)
    if (start === 0) return 0
    const before = lineStart(start - 1)
    return snapTo(Math.min(before + (p - start), start - 1))
  }

  const steps: Partial<Record<string, (p: number) => number>> = {
    h: prev,
    l: next,
    j: down,
    k: up,
    w: (p) => wordForward(p, false),
    W: (p) => wordForward(p, true),
    b: (p) => wordBack(p, false),
    B: (p) => wordBack(p, true),
    e: (p) => wordEnd(p, false),
    E: (p) => wordEnd(p, true),
  }
  /** A motion applied n times, stopping as soon as a step no longer moves. */
  const repeat = (stepFn: (p: number) => number, from: number, n: number) => {
    let p = from
    for (let i = 0; i < n; i++) {
      const q = stepFn(p)
      if (q === p) break
      p = q
    }
    return p
  }
  const lineAt = (line: number) => snapTo(lineStarts[Math.max(0, Math.min(line, lineStarts.length - 1))]!)

  /** Where a plain motion leaves the cursor, or undefined when the name is not a motion. */
  const target = (name: string, n: number, from: number, snapshot: Snapshot) => {
    const stepFn = steps[name]
    if (stepFn) return repeat(stepFn, from, n)
    switch (name) {
      case "0":
        return lineStart(from)
      case "^":
        return firstNonBlank(from)
      case "$":
        return lineEnd(from)
      case "G":
        return lineAt(n > 1 ? n - 1 : lineStarts.length - 1)
      case "gg":
        return lineAt(n > 1 ? n - 1 : 0)
      case "gj":
      case "gk": {
        const row = snapshot.row
        if (!row) return from
        return repeat((p) => snapTo(row(p, name === "gj" ? "down" : "up")), from, n)
      }
    }
  }

  /** The characterwise range an operator covers for a motion. Linewise motions never come here. */
  const motionRange = (operator: Operator, name: string, n: number, from: number, snapshot: Snapshot) => {
    if (name === "$") return { start: from, end: lineEnd(from) }
    if (name === "w" || name === "W") {
      const big = name === "W"
      if (operator === "c") {
        // cw acts like ce, but stays on the word the cursor is already on.
        const p = repeat(steps[name]!, from, n - 1)
        if (cls(p, big) !== 0) {
          const c = cls(p, big)
          let q = p
          while (q < len && cls(q, big) === c) q = next(q)
          return { start: from, end: q }
        }
        const q = wordEnd(p, big)
        return { start: from, end: q >= len ? len : next(q) }
      }
      const before = repeat(steps[name]!, from, n - 1)
      let end = steps[name]!(before)
      // Over the last word of a line the range stops at the line break instead of running on to the next line.
      const wordStop = cls(before, big) === 0 ? before : (() => {
        const c = cls(before, big)
        let q = before
        while (q < len && cls(q, big) === c) q = next(q)
        return q
      })()
      const lineBreak = text.indexOf("\n", wordStop)
      if (lineBreak >= 0 && lineBreak < end) end = lineBreak
      return { start: from, end }
    }
    const to = target(name, n, from, snapshot)
    if (to === undefined || to === from) return
    if (name === "e" || name === "E") return { start: from, end: to >= len ? len : next(to) }
    return { start: Math.min(from, to), end: Math.max(from, to) }
  }

  /** A range never cuts a prompt part in half. */
  const widen = (range: { start: number; end: number }) => ({
    start: inside(range.start)?.start ?? range.start,
    end: inside(range.end)?.end ?? range.end,
  })

  /** Up to n graphemes (a part counts as one) from `from`, not past `limit`. */
  const cells = (from: number, limit: number, n: number) => {
    const out: Array<{ start: number; end: number; part: boolean }> = []
    let p = from
    while (out.length < n && p < limit) {
      const q = next(p)
      out.push({ start: p, end: q, part: partAt(p) !== undefined })
      p = q
    }
    return out
  }

  const object = (kind: string, around: boolean, cursor: number) => {
    if (kind === "w" || kind === "W") return wordObject(kind === "W", around, cursor)
    if (kind === '"' || kind === "'" || kind === "`") return quoteObject(kind, around, cursor)
    const pair = BRACKETS[kind]
    if (pair) return bracketObject(pair[0], pair[1], around, cursor)
  }
  const wordObject = (big: boolean, around: boolean, cursor: number) => {
    if (cursor >= len || text[cursor] === "\n") return
    const c = cls(cursor, big)
    const same = (i: number) => cls(i, big) === c && text[i] !== "\n"
    let start = cursor
    let end = next(cursor)
    while (start > 0 && same(prev(start))) start = prev(start)
    while (end < len && same(end)) end = next(end)
    if (!around || c === 0) return { start, end }
    let after = end
    while (after < len && cls(after, big) === 0 && text[after] !== "\n") after = next(after)
    if (after > end) return { start, end: after }
    let before = start
    while (before > 0 && cls(prev(before), big) === 0 && text[prev(before)] !== "\n") before = prev(before)
    return { start: before, end }
  }
  const quoteObject = (quote: string, around: boolean, cursor: number) => {
    const first = lineStart(cursor)
    const marks = Array.from(text.slice(first, lineEnd(cursor)).matchAll(new RegExp(quote, "g")), (m) => first + m.index)
    for (let k = 0; k + 1 < marks.length; k += 2) {
      const open = marks[k]!
      const close = marks[k + 1]!
      if (open <= cursor && cursor <= close) return around ? { start: open, end: close + 1 } : { start: open + 1, end: close }
    }
  }
  const bracketObject = (open: string, close: string, around: boolean, cursor: number) => {
    let depth = 0
    let start = -1
    for (let i = text[cursor] === close ? cursor - 1 : Math.min(cursor, len - 1); i >= 0; i--) {
      if (text[i] === close) depth++
      else if (text[i] === open) {
        if (depth === 0) {
          start = i
          break
        }
        depth--
      }
    }
    if (start < 0) return
    depth = 0
    for (let i = start + 1; i < len; i++) {
      if (text[i] === open) depth++
      else if (text[i] === close) {
        if (depth === 0) return around ? { start, end: i + 1 } : { start: start + 1, end: i }
        depth--
      }
    }
  }

  return {
    len,
    snap: snapTo,
    next,
    prev,
    lineStart,
    lineEnd,
    lineStarts,
    lineIndex,
    firstNonBlank,
    target,
    motionRange,
    widen,
    cells,
    object,
  }
}

const BRACKETS: Partial<Record<string, readonly [string, string]>> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "<": ["<", ">"],
  ">": ["<", ">"],
}
