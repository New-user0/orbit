export * as Vim from "./vim-state"

/**
 * Vim-style editing for the prompt, as a pure engine. Insert mode is the ordinary editor; Escape enters normal mode,
 * where keys move and edit instead of typing. The engine reads a snapshot of the prompt (text, cursor, parts) and a key,
 * and returns the next state plus what to do: edits to apply, the new cursor and the mode. It knows nothing of the
 * renderer, so the adapter in `vim-adapter.ts` applies the edits through the textarea and tests drive it over a string.
 *
 * Every offset here is a UTF-16 index into `text` that sits on a grapheme boundary. The textarea counts display width
 * instead, so the adapter converts at its edge.
 */

export type Mode = "insert" | "normal" | "visual" | "visual_line"
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
  /** After `f`, `F`, `t` or `T`: the next key is the character to look for, whatever it is. */
  | { readonly kind: "find"; readonly find: Find; readonly count: number }
  | { readonly kind: "operatorFind"; readonly operator: Operator; readonly find: Find; readonly count: number }

export type Find = "f" | "F" | "t" | "T"

/** What `.` replays. Nothing here is persisted. */
export type Change =
  /** The keys of a normal-mode command, replayed through the engine as they ran the first time. */
  | { readonly kind: "keys"; readonly keys: readonly string[] }
  /** Text typed in insert mode, put back at the cursor. */
  | { readonly kind: "text"; readonly text: string }
  /** A visual operator, replayed over the same amount of text from the cursor. */
  | {
      readonly kind: "visual"
      readonly operator: Operator | ">" | "<"
      readonly linewise: boolean
      /** Lines the selection touched. */
      readonly lines: number
      /** Characterwise on one line: the graphemes selected. */
      readonly width: number
      /** Characterwise over several lines: the column of the last selected character. */
      readonly column: number
      readonly levels: number
    }

export interface State {
  readonly mode: Mode
  readonly pending: Pending
  /** Set by `"+`: the next yank, delete or paste goes through the system clipboard. */
  readonly clipboard: boolean
  /** The unnamed register. Text that ends with a line break is linewise. Never persisted. */
  readonly register: string
  /** The other end of the selection in visual mode; the cursor is the head. */
  readonly anchor?: number
  /** The last change `.` repeats. Memory only. */
  readonly lastChange?: Change
  /** The last `f F t T`, for `;` and `,`. Memory only. */
  readonly lastFind?: { readonly kind: Find; readonly char: string }
  /** Text typed since insert mode began. It replaces the last change when Escape ends the insert. */
  readonly typed: string
  /** The keys of the command in progress. */
  readonly keys: readonly string[]
}

export const initial: State = {
  mode: "insert",
  pending: { kind: "idle" },
  clipboard: false,
  register: "",
  typed: "",
  keys: [],
}

export const isVisual = (mode: Mode) => mode === "visual" || mode === "visual_line"

/** Ends a selection without any key: the text was replaced, sent or clicked, or vim was switched off. */
export const endVisual = (state: State): State =>
  isVisual(state.mode)
    ? { ...state, mode: "normal", anchor: undefined, pending: { kind: "idle" }, clipboard: false, keys: [] }
    : state

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

/** What a completed command was. `.` replays the keys that made it, so this is for callers that want to know. */
export interface Command {
  readonly command: string
  readonly operator?: Operator
  readonly motion?: string
  readonly object?: string
  readonly find?: { readonly kind: Find; readonly char: string }
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
  readonly clipboard?:
    | { readonly write: string }
    | { readonly read: { readonly before: boolean; readonly count: number } }
  readonly record?: Command
  /** UTF-16 range to draw as selected, end exclusive. Present exactly while the resulting state is in visual mode. */
  readonly selection?: { readonly start: number; readonly end: number }
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
  if (!isVisual(state.mode)) return withSelection(normalStep(state, key, snap), snap)
  return withSelection(visualStep(state, key, snap), snap)
}

/** Escape from insert mode: a non-empty record of what was typed becomes the last change. */
export function leave(state: State): State {
  return {
    ...state,
    mode: "normal",
    pending: { kind: "idle" },
    clipboard: false,
    anchor: undefined,
    keys: [],
    typed: "",
    lastChange: state.typed ? { kind: "text", text: state.typed } : state.lastChange,
  }
}

/** Records one insert-mode key before the editor handles it. Backspace and Delete trim what was typed, nothing else is kept. */
export function insertKey(state: State, key: Key): State {
  if (key.ctrl || key.meta) return state
  const text = key.sequence && !/\p{Cc}/u.test(key.sequence) ? key.sequence : typed(key)
  if (text) return { ...state, typed: state.typed + text }
  if ((key.name === "backspace" || key.name === "delete") && state.typed)
    return { ...state, typed: state.typed.slice(0, [...segmenter.segment(state.typed)].at(-1)!.index) }
  return state
}

/** Forgets what was typed, for text that is sent or replaced from outside the editor. */
export const restartTyped = (state: State): State => (state.typed ? { ...state, typed: "" } : state)

function normalStep(state: State, key: Key, snap: Snapshot): Result {
  const ctx = context(snap)
  const cursor = ctx.snap(snap.cursor)
  if (key.ctrl || key.meta) return { state: reset(state), edits: [], cursor, pass: true }
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
  return track(state, ch, dispatch(run, pending, ch))
}

function dispatch(run: Run, pending: Pending, ch: string): Result {
  const { state, cursor } = run
  switch (pending.kind) {
    case "register":
      if (ch === "+") return stay({ ...state, pending: { kind: "idle" }, clipboard: true }, cursor)
      if (ch === '"') return stay({ ...state, pending: { kind: "idle" }, clipboard: false }, cursor)
      return stay(reset(state), cursor)
    case "replace":
      return replace(run, pending.count || 1, ch)
    case "find":
      return findMotion(run, pending.find, pending.count || 1, ch)
    case "operatorFind":
      return operatorFind(run, pending.operator, pending.find, pending.count || 1, ch)
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

/**
 * Remembers the keys of a command while it is in progress and, once it completes and changed something, makes them
 * the last change. Register prefixes are left out, and `p`, `P` and `.` itself are never recorded.
 */
function track(before: State, ch: string, out: Result): Result {
  const prefix = ch === '"' && before.pending.kind === "idle"
  const keys = prefix || before.pending.kind === "register" ? before.keys : [...before.keys, ch]
  if (out.state.pending.kind !== "idle") return { ...out, state: { ...out.state, keys } }
  const recorded = out.record && out.record.command !== "p" && out.record.command !== "P"
  return {
    ...out,
    state: { ...out.state, keys: [], lastChange: recorded ? { kind: "keys", keys } : out.state.lastChange },
  }
}

/** `.`: runs the last change again from the cursor. It never replaces the last change itself. */
function repeatChange(run: Run): Result {
  const { state, cursor, snap } = run
  const change = state.lastChange
  if (!change) return stay(reset(state), cursor)
  const from: State = { ...reset(state), mode: "normal" }
  const done = (out: Result): Result => ({
    ...out,
    record: undefined,
    state: { ...out.state, keys: [], lastChange: change },
  })
  if (change.kind === "text")
    return done(
      result(from, {
        edits: [{ start: cursor, end: cursor, insert: change.text }],
        cursor: cursor + change.text.length,
      }),
    )
  if (change.kind === "visual") return done(repeatVisual({ ...run, state: from }, change))
  const last = change.keys.reduce<Result>((previous, k) => normalStep(previous.state, { name: k, sequence: k }, snap), {
    state: from,
    edits: [],
    cursor,
  })
  return done(last)
}

function withSelection(out: Result, snap: Snapshot): Result {
  if (!isVisual(out.state.mode)) return out
  return { ...out, selection: visualRange(context(snap), out.state, out.cursor, true) }
}

/** What a visual selection covers. `display` also takes the line break after a linewise selection, so empty lines show. */
function visualRange(ctx: Context, state: State, head: number, display = false) {
  const anchor = state.anchor ?? head
  const lo = Math.min(anchor, head)
  const hi = Math.max(anchor, head)
  if (state.mode === "visual_line") {
    const end = ctx.lineEnd(hi)
    return { start: ctx.lineStart(lo), end: display && end < ctx.len ? end + 1 : end }
  }
  return ctx.widen({ start: lo, end: hi >= ctx.len ? ctx.len : ctx.next(hi) })
}

function visualStep(state: State, key: Key, snap: Snapshot): Result {
  const ctx = context(snap)
  const cursor = ctx.snap(snap.cursor)
  const normal: State = { ...reset(state), mode: "normal", anchor: undefined }
  if (key.ctrl || key.meta) return { state: normal, edits: [], cursor, pass: true }
  const char = typed(key)
  // Escape is consumed here: it ends the selection and does not reach a running session's interrupt.
  if (!char && key.name === "escape") return stay(normal, cursor)
  if (!char && (key.name === "return" || key.name === "enter")) return { state: normal, edits: [], cursor, pass: true }

  const pending = state.pending
  const moving = pending.kind === "idle" || pending.kind === "count"
  // Arrows (shifted or not) move the head even with nothing pending, and Backspace is h.
  const ch = char ?? (moving ? (ARROWS[key.name] ?? (key.name === "backspace" ? "h" : undefined)) : undefined)
  if (!ch) return stay(reset(state), cursor)

  const run = { state, ctx, cursor, snap }
  if (pending.kind === "g") {
    if (ch === "g") return motion(run, "gg", pending.count)
    if (ch === "j" || ch === "k") return motion(run, "g" + ch, pending.count)
    return stay(reset(state), cursor)
  }
  if (pending.kind === "find") return findMotion(run, pending.find, pending.count || 1, ch)
  if (pending.kind === "register") {
    if (ch === "+") return stay({ ...state, pending: { kind: "idle" }, clipboard: true }, cursor)
    if (ch === '"') return stay({ ...state, pending: { kind: "idle" }, clipboard: false }, cursor)
    return stay(reset(state), cursor)
  }
  return visualKey(run, pending.kind === "count" ? pending.count : 0, ch)
}

function visualKey(run: Run, count: number, ch: string): Result {
  const { state, ctx, cursor } = run
  const n = count || 1
  const pend = (pending: Pending): Result => stay({ ...state, pending }, cursor)
  if (isDigit(ch) && (ch !== "0" || count > 0)) return pend({ kind: "count", count: extend(count, Number(ch)) })
  if (ch === '"' && count === 0) return pend({ kind: "register" })
  if (ch === "g") return pend({ kind: "g", count })
  if (isFind(ch)) return pend({ kind: "find", find: ch, count })
  if (ch === ";" || ch === ",") return repeatFind(run, ch === ",", n)
  if (MOTIONS.has(ch)) return motion(run, ch, count)
  const line = state.mode === "visual_line"
  switch (ch) {
    case "v":
    case "V": {
      if (ch === (line ? "V" : "v")) return result({ ...state, anchor: undefined }, { cursor, mode: "normal" })
      return result(state, { cursor, mode: ch === "v" ? "visual" : "visual_line" })
    }
    case "o":
      return result(state, { cursor: state.anchor ?? cursor, anchor: cursor })
    case "d":
    case "c":
    case "y":
      return visualOperator(run, ch)
    case ">":
    case "<":
      return visualOperator(run, ch, n)
  }
  return stay(reset(state), cursor)
}

/** The visual operators. The selection ends; `.` later applies the same operator to the same amount of text. */
function visualOperator(run: Run, operator: Operator | ">" | "<", levels = 1): Result {
  const { ctx, cursor, snap } = run
  const state: State = { ...run.state, mode: "normal", anchor: undefined, pending: { kind: "idle" } }
  const base = { ...run, state }
  const head = cursor
  const anchor = run.state.anchor ?? head
  const first = ctx.lineIndex(Math.min(anchor, head))
  const last = ctx.lineIndex(Math.max(anchor, head))
  const linewise = run.state.mode === "visual_line"
  const range = visualRange(ctx, run.state, head)
  const change: Change = {
    kind: "visual",
    operator,
    linewise,
    lines: last - first + 1,
    width: ctx.cells(range.start, range.end, Infinity).length,
    column: Math.max(anchor, head) - ctx.lineStart(Math.max(anchor, head)),
    levels,
  }
  const record = { command: operator, count: change.lines }
  const out =
    operator === ">" || operator === "<"
      ? shiftLines(base, operator, first, last - first + 1, levels)
      : linewise
        ? lines(base, operator, first, last, operator, change.lines, { ...record, operator })
        : operate(base, operator, range, { ...record, operator }, true)
  // An empty selection (an empty prompt) changed nothing and so is not a change to repeat.
  return { ...out, state: { ...out.state, lastChange: out.record ? change : out.state.lastChange } }
}

/** Replays a visual operator from the cursor over as much text as it covered the first time. */
function repeatVisual(run: Run, change: Extract<Change, { kind: "visual" }>): Result {
  const { ctx, cursor } = run
  const first = ctx.lineIndex(cursor)
  const last = Math.min(ctx.lineStarts.length - 1, first + change.lines - 1)
  const record = { command: change.operator, count: change.lines }
  if (change.operator === ">" || change.operator === "<")
    return shiftLines(run, change.operator, first, last - first + 1, change.levels)
  if (change.linewise)
    return lines(run, change.operator, first, last, change.operator, change.lines, {
      ...record,
      operator: change.operator,
    })
  const end =
    change.lines === 1
      ? (ctx.cells(cursor, ctx.lineEnd(cursor), change.width).at(-1)?.end ?? cursor)
      : (() => {
          const start = ctx.lineStarts[last]!
          const column = Math.min(start + change.column, ctx.lineEnd(start))
          return column >= ctx.len ? ctx.len : ctx.next(ctx.snap(column))
        })()
  return operate(
    run,
    change.operator,
    ctx.widen({ start: cursor, end }),
    { ...record, operator: change.operator },
    true,
  )
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

const reset = (state: State): State => ({ ...state, pending: { kind: "idle" }, clipboard: false, keys: [] })
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
    anchor?: number
    register?: string
    find?: { kind: Find; char: string }
    record?: Command
    undo?: boolean
    clipboard?: Result["clipboard"]
  },
): Result {
  const write = input.register !== undefined && state.clipboard ? { write: input.register } : undefined
  const mode = input.mode ?? state.mode
  return {
    state: {
      ...state,
      mode,
      pending: { kind: "idle" },
      clipboard: false,
      register: input.register ?? state.register,
      anchor: isVisual(mode) ? (input.anchor ?? state.anchor) : undefined,
      lastFind: input.find ?? state.lastFind,
      typed: mode === "insert" && state.mode !== "insert" ? "" : state.typed,
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
  if (isFind(ch)) return pend({ kind: "find", find: ch, count })
  if (ch === ";" || ch === ",") return repeatFind(run, ch === ",", n)
  if (ch === ".") return repeatChange(run)
  // A count or a register prefix typed before v or V is dropped.
  if (ch === "v" || ch === "V")
    return result(state, { cursor, mode: ch === "v" ? "visual" : "visual_line", anchor: cursor })
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
      if (state.clipboard) return result(state, { cursor, clipboard: { read: { before: ch === "P", count: n } } })
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

const MOTIONS = new Set(["h", "j", "k", "l", "w", "b", "e", "W", "B", "E", "0", "^", "$", "G", "%"])

const isFind = (ch: string): ch is Find => ch === "f" || ch === "F" || ch === "t" || ch === "T"
const OPPOSITE: Record<Find, Find> = { f: "F", F: "f", t: "T", T: "t" }

/** A motion with no operator: only the cursor moves. */
function motion(run: Run, name: string, count: number): Result {
  // A count before % would be a percentage jump, which the prompt does not have.
  if (name === "%" && count > 0) return stay(reset(run.state), run.cursor)
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
    return lines(
      run,
      pending.operator,
      first,
      first + (pending.count || 1) - 1,
      pending.operator + pending.operator,
      pending.count || 1,
    )
  }
  if (ch === "g")
    return stay({ ...state, pending: { kind: "operatorG", operator: pending.operator, count: total } }, cursor)
  if (ch === "i" || ch === "a")
    return stay(
      { ...state, pending: { kind: "object", operator: pending.operator, count: total, around: ch === "a" } },
      cursor,
    )
  if (isFind(ch))
    return stay(
      { ...state, pending: { kind: "operatorFind", operator: pending.operator, find: ch, count: total } },
      cursor,
    )
  if (ch === "%" && (pending.count > 0 || pending.inner > 0)) return stay(reset(state), cursor)
  if (MOTIONS.has(ch)) return operatorMotion(run, pending.operator, ch, total)
  return stay(reset(state), cursor)
}

/** `f F t T` with its character: the cursor moves, and the find is remembered. A miss changes nothing. */
function findMotion(run: Run, kind: Find, count: number, char: string): Result {
  const to = run.ctx.find(kind, char, count, run.cursor)
  if (to === undefined) return stay(reset(run.state), run.cursor)
  return result(run.state, { cursor: to, find: { kind, char } })
}

/** `;` repeats the last find, `,` runs it the other way. The remembered find stays as it was. */
function repeatFind(run: Run, reverse: boolean, count: number): Result {
  const last = run.state.lastFind
  const to = last ? run.ctx.find(reverse ? OPPOSITE[last.kind] : last.kind, last.char, count, run.cursor) : undefined
  if (to === undefined) return stay(reset(run.state), run.cursor)
  return result(run.state, { cursor: to })
}

/** `d`, `c` or `y` with a find: the span runs from the cursor's grapheme to the target's, both included. */
function operatorFind(run: Run, operator: Operator, kind: Find, count: number, char: string): Result {
  const range = run.ctx.findSpan(kind, char, count, run.cursor)
  if (!range) return stay(reset(run.state), run.cursor)
  const find = { kind, char }
  const out = operate(run, operator, run.ctx.widen(range), { command: operator, operator, motion: kind, find, count })
  return { ...out, state: { ...out.state, lastFind: find } }
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
  return operate(
    run,
    operator,
    ctx.widen(found),
    { command: operator, operator, object: (around ? "a" : "i") + kind, count: 1 },
    true,
  )
}

/** Applies an operator to a characterwise range. */
function operate(
  run: Run,
  operator: Operator,
  range: { start: number; end: number },
  record: Command,
  allowEmpty = false,
): Result {
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
function lines(
  run: Run,
  operator: Operator,
  first: number,
  last: number,
  command: string,
  count: number,
  record?: Command,
): Result {
  const { state, ctx, snap } = run
  const end = Math.min(last, ctx.lineStarts.length - 1)
  const start = ctx.lineStarts[first]!
  const stop = ctx.lineEnd(ctx.lineStarts[end]!)
  const register = snap.text.slice(start, stop) + "\n"
  const rec = record ?? { command, operator, count }
  if (operator === "y") return result(state, { cursor: start, register, record: rec })
  if (operator === "c")
    return result(state, {
      edits: [{ start, end: stop, insert: "" }],
      cursor: start,
      mode: "insert",
      register,
      record: rec,
    })
  // The lines go with one of their line breaks; at the end of the text it is the one before them.
  const edits =
    stop < ctx.len ? [{ start, end: stop + 1, insert: "" }] : [{ start: Math.max(0, start - 1), end: stop, insert: "" }]
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
  const shift = edits
    .filter((edit) => edit.start < last.start)
    .reduce((sum, edit) => sum + edit.insert.length - (edit.end - edit.start), 0)
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
  return result(state, {
    edits: edits.filter((edit) => edit.end > edit.start || edit.insert),
    cursor: joinAt,
    record: { command: "J", count: n },
  })
}

/** `>>` and `<<`: shift n lines from the cursor's line by two columns. */
function shift(run: Run, direction: ">" | "<", n: number): Result {
  return shiftLines(run, direction, run.ctx.lineIndex(run.cursor), n, 1)
}

/** Shifts `n` lines from line `line` by `levels` levels of two columns each. */
function shiftLines(run: Run, direction: ">" | "<", line: number, n: number, levels: number): Result {
  const { state, ctx, snap } = run
  const edits = ctx.lineStarts.slice(line, line + n).flatMap((start): Edit[] => {
    const end = ctx.lineEnd(start)
    const body = snap.text.slice(start, end)
    if (direction === ">") return [{ start, end: start, insert: "  ".repeat(levels) }]
    const width = Array.from({ length: levels }).reduce<number>((removed) => {
      const rest = body.slice(removed)
      return (
        removed + (rest.startsWith("  ") ? 2 : rest.startsWith("\t") ? 1 : (/^\s{1,2}/.exec(rest)?.[0].length ?? 0))
      )
    }, 0)
    return width ? [{ start, end: start + width, insert: "" }] : []
  })
  const next = apply(snap.text, edits)
  const lineStart = ctx.lineStarts[line]!
  const rest = next.slice(lineStart)
  const eol = rest.indexOf("\n") < 0 ? rest.length : rest.indexOf("\n")
  const indent = rest.slice(0, eol).length - rest.slice(0, eol).trimStart().length
  return result(state, {
    edits,
    cursor: lineStart + indent,
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
      const atOrBefore = starts[mid]! <= i
      lo = atOrBefore ? mid : lo
      hi = atOrBefore ? hi : mid - 1
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
      const after = starts[mid]! > i
      hi = after ? mid : hi
      lo = after ? lo : mid + 1
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
      case "%":
        return match(from)
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
      const wordStop =
        cls(before, big) === 0
          ? before
          : (() => {
              const c = cls(before, big)
              let q = before
              while (q < len && cls(q, big) === c) q = next(q)
              return q
            })()
      const lineBreak = text.indexOf("\n", wordStop)
      if (lineBreak >= 0 && lineBreak < end) end = lineBreak
      return { start: from, end }
    }
    if (name === "%") {
      const to = match(from)
      if (to === undefined) return
      return to > from ? { start: from, end: next(to) } : { start: to, end: next(from) }
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

  /** Whether a code unit sits inside a prompt part, for scans that go code unit by code unit. */
  const inPart = (() => {
    const mask = new Uint8Array(len)
    parts.forEach((part) => mask.fill(1, Math.max(0, part.start), Math.min(len, part.end)))
    return mask
  })()

  /** `%`: from the cursor to the end of its line, the first bracket, then its partner (nesting of that pair only). */
  const match = (from: number) => {
    const end = lineEnd(from)
    let at = from
    while (at < end && (inPart[at] === 1 || !PAIRS[text[at]!])) at++
    if (at >= end) return
    const pair = PAIRS[text[at]!]!
    const direction = pair.forward ? 1 : -1
    let depth = 0
    for (let i = at; i >= 0 && i < len; i += direction) {
      if (inPart[i] === 1) continue
      if (text[i] === pair.self) depth++
      if (text[i] !== pair.other) continue
      depth--
      if (depth === 0) return i
    }
  }

  /** The Nth grapheme equal to `char` after (or before) `from`; a prompt part never matches. */
  const occurrence = (kind: Find, char: string, n: number, from: number) => {
    const forward = kind === "f" || kind === "t"
    if (forward ? from >= len : from <= 0) return
    let seen = 0
    for (let q = forward ? next(from) : prev(from); ; q = forward ? next(q) : prev(q)) {
      if (!partAt(q) && text.slice(q, next(q)) === char && ++seen >= n) return q
      if (forward ? q >= len : q <= 0) return
    }
  }
  /** Where `f F t T` leave the cursor. `t` and `T` stop short of the target but never behind where they started. */
  const find = (kind: Find, char: string, n: number, from: number) => {
    const q = occurrence(kind, char, n, from)
    if (q === undefined) return
    return kind === "t" ? prev(q) : kind === "T" ? next(q) : q
  }
  /** What an operator covers for a find: the cursor's grapheme and the target (or the one before it), both included. */
  const findSpan = (kind: Find, char: string, n: number, from: number) => {
    const q = occurrence(kind, char, n, from)
    if (q === undefined) return
    if (kind === "f") return { start: from, end: next(q) }
    if (kind === "t") return { start: from, end: q }
    return { start: kind === "F" ? q : next(q), end: next(from) }
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
    const marks = Array.from(
      text.slice(first, lineEnd(cursor)).matchAll(new RegExp(quote, "g")),
      (m) => first + m.index,
    )
    for (let k = 0; k + 1 < marks.length; k += 2) {
      const open = marks[k]!
      const close = marks[k + 1]!
      if (open <= cursor && cursor <= close)
        return around ? { start: open, end: close + 1 } : { start: open + 1, end: close }
    }
  }
  const bracketObject = (open: string, close: string, around: boolean, cursor: number) => {
    let depth = 0
    let start = -1
    for (let i = text[cursor] === close ? cursor - 1 : Math.min(cursor, len - 1); i >= 0; i--) {
      if (text[i] === close) depth++
      if (text[i] !== open) continue
      if (depth === 0) {
        start = i
        break
      }
      depth--
    }
    if (start < 0) return
    depth = 0
    for (let i = start + 1; i < len; i++) {
      if (text[i] === open) depth++
      if (text[i] !== close) continue
      if (depth === 0) return around ? { start, end: i + 1 } : { start: start + 1, end: i }
      depth--
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
    find,
    findSpan,
    motionRange,
    widen,
    cells,
    object,
  }
}

const PAIRS: Partial<Record<string, { self: string; other: string; forward: boolean }>> = {
  "(": { self: "(", other: ")", forward: true },
  ")": { self: ")", other: "(", forward: false },
  "[": { self: "[", other: "]", forward: true },
  "]": { self: "]", other: "[", forward: false },
  "{": { self: "{", other: "}", forward: true },
  "}": { self: "}", other: "{", forward: false },
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
