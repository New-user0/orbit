import { plainPath } from "@orbit/util/plain"

// Text that Markdown draws letter for letter: it has no mark that pairs with another or takes what follows it as
// markup, a backslash only before a letter or a digit, an underscore only inside a word, at most the one tilde of a
// short name such as `RUNNER~1` and that only where no other path shares the text, and it starts no block and holds
// nothing that becomes a link by itself.
const LITERAL =
  /^(?:[\p{L}\p{M}\p{N} /.,:;=@+'"!?%$#(){}~-]|\](?![([:])|(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])|\\(?=[\p{L}\p{N}]))+$/u
const ACTIVE = /^(?:[-+=#]|\d+[.)])|:\/\/|www\.|@[^/\\]*\./i
// Text that opens with the words of a warning would read as one, so it is quoted too.
const WARNING = /^(?:link ends|\d+ linked paths)/i
// A subagent's title stands before the warning itself, so its words are quoted wherever they are in it.
const WARNING_WORDS = /link ends|linked paths/i
const NAME_LENGTH = 40

/**
 * Text a model, a file, a subagent or a tool chose, for a client that renders it as Markdown, as the protocol has it do
 * with content and some do with titles: one line, as it is where Markdown shows it so, and otherwise in a code span with
 * a longer fence than any in it. So the text a person reads is the text itself, whole, and nothing a repository or a
 * model chose becomes a link, an image or a tag (classes 6, 8 and 9). `alone` is false for text that shares its line with
 * another such text, where even one tilde could pair with the other's.
 */
export function literal(value: string, alone = true) {
  const text = plainPath(value)
  const tildes = text.split("~").length - 1
  if (tildes <= (alone ? 1 : 0) && LITERAL.test(text) && !ACTIVE.test(text) && !WARNING.test(text)) return text
  return codeSpan(text)
}

/**
 * Text a tool gave back, such as a file's text, a command's output or an error, for content a client renders as
 * Markdown: as it is when it is one line that Markdown draws letter for letter, and otherwise in a fenced code block
 * whose fence is longer than any run of backticks in it, so no line of it closes the block. Its lines keep their breaks,
 * and nothing a repository or a model wrote becomes a link, an image or a tag (classes 6 and 9).
 */
export function literalBlock(text: string) {
  // `literal` writes a line break out, so text of several lines is never its own literal.
  if (literal(text) === text) return text
  const fence = "`".repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1)
  return `${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`
}

export function codeSpan(text: string) {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * A subagent's title, which a model chose, in front of a warning or a call: one line, short enough that a warning stays
 * in a title that an editor cuts, and quoted where a warning's words are anywhere in it, so that it leads as none of
 * Orbit's (classes 8 and 9).
 */
export function subagentName(title: string | undefined) {
  if (!title?.trim()) return undefined
  const whole = plainPath(title.trim())
  const characters = Array.from(whole)
  const text =
    characters.length > NAME_LENGTH
      ? `${characters
          .slice(0, NAME_LENGTH - 3)
          .join("")
          .trimEnd()}...`
      : whole
  return WARNING_WORDS.test(whole) ? codeSpan(text) : literal(text)
}

type Fence = { readonly mark: string; readonly length: number; readonly indent: number }

/** What one piece of a model's streamed text leaves open for the next: see `withoutImages`. */
export type Prose = {
  /** The fenced code block the text is in. */
  readonly fence?: Fence
  /**
   * Whether a fenced block may be open that the tracker cannot follow: one behind a list's or a quote's mark or more than
   * three spaces in, or one that a line left by starting to the left of its opening line. Its closing line may open a
   * block for one renderer and close one for another, so from then on no block is thought open.
   */
  readonly lost: boolean
  /** A backtick run that may open a code span, with the text after it on its line, held back until the span closes. */
  readonly held: string
  /** The length of the run that opened `held`, or 0 while that run may still grow. */
  readonly open: number
  /** The backticks at the end of `held` after its opening run. */
  readonly run: number
  /** The current line so far. */
  readonly line: string
  /** The last character written. */
  readonly last: string
  /** Whether that character is a backslash that escapes the next one. */
  readonly escape: boolean
  /** The mark that ends the link address or autolink the text is in: `)` or `>`, or "" outside one. */
  readonly until: string
  /** Whether a backtick in the rest of the paragraph may belong to something other than a code span. */
  readonly mixed: boolean
}

export const prose: Prose = {
  lost: false,
  held: "",
  open: 0,
  run: 0,
  line: "",
  last: "",
  escape: false,
  until: "",
  mixed: false,
}

// `<` and a letter, `/`, `!` or `?` opens a raw HTML tag, comment or declaration; an autolink (`<https://...>`) names a
// scheme and a colon first.
const TAG = /^[a-z/!?]/i
const AUTOLINK = /^[a-z][a-z0-9+.-]{1,31}:/i
// A mark that can make a link's address or an autolink other than a plain run up to its end: a space or a line break,
// a quote or a parenthesis of a title, an angle bracket, a backslash or a backtick.
const UNPLAIN = /[\s"'()<>\\`]/
// A fence's run behind any indentation and any list or quote marks.
const FENCE_LINE = /^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*(?:`{3}|~{3})/

/**
 * A model's own Markdown, for a client that renders it: prose and code stay as written, but nothing in it is an image or
 * a raw HTML tag, which a client would fetch from an address that a model, or a repository that steers it, chose
 * (classes 6 and 9). In prose, the `[` of an image's `![` is written `\[`, so the image reads as its text and its
 * address, as the reference's own renderer shows it; and the `<` that opens a tag is written `&lt;`, which a Markdown
 * client draws as `<`. Text is left as written only where Markdown is sure to read it as code:
 *
 * - A fenced block, opened by a line of three or more backticks or tildes after at most three spaces, and ended by a
 *   line of a run as long at any indentation, or by a line that starts to the left of the opening one, which may end
 *   the list item that holds the block. After such a line, or a fence behind a list's or a quote's mark or more than
 *   three spaces in, renderers differ on which block is open, so no later block in the text is taken as code.
 * - A code span, whose text is held back from its opening run until a run of the same length closes it on the same
 *   line. A run that a backslash escapes, or that is inside a link's address after its `](` or an autolink, opens
 *   nothing. An address or autolink that is not a plain run up to its `)` or `>` may hold a title or a backtick of its
 *   own, so the backticks in the rest of that paragraph open nothing. A span that its line or the text ends before it
 *   closes is written as prose, and so is one with a `|`, which a table splits into two cells; the backticks in the rest
 *   of that paragraph then open nothing too.
 *
 * Text arrives in pieces, so `state` carries what one piece leaves open to the next, and `end` writes what is still
 * held when the text ends. A `<` that ends a piece is written `&lt;`, since the tag it may open is not known yet.
 */
export function withoutImages(state: Prose, text: string, end = false): [Prose, string] {
  const out: string[] = []
  // By UTF-16 unit, so an index is a position in `text`; every mark looked at is one unit.
  const next = text
    .split("")
    .reduce<Prose>((current, char, index) => step(current, char, () => text.slice(index + 1), out), state)
  if (!end) return [next, out.join("")]
  settle(next, out)
  return [prose, out.join("")]
}

function step(state: Prose, char: string, rest: () => string, out: string[]): Prose {
  // A carriage return ends a line as a line feed does, and the two together end one line.
  if (char === "\n" && state.last === "\r") {
    out.push(char)
    return { ...state, last: char }
  }
  if (char === "\n" || char === "\r") return newline(settle(state, out), char, out)
  if (state.fence) {
    if (state.line.length < state.fence.indent && char !== " " && /^ *$/.test(state.line))
      return step({ ...state, fence: undefined, lost: true }, char, rest, out)
    out.push(char)
    return { ...state, line: state.line + char, last: char }
  }
  const current = { ...state, line: state.line + char }
  if (current.held === "") return write(current, char, rest, out)
  if (char === "`") return { ...current, held: current.held + char, run: current.open === 0 ? 0 : current.run + 1 }
  if (current.open === 0) return { ...current, held: current.held + char, open: current.held.length }
  if (current.run === current.open) return write(close(current, out), char, rest, out)
  return { ...current, held: current.held + char, run: 0 }
}

// Prose: a backtick run that may open a span starts to be held back, and anything else is written, with an image's `[`
// and a tag's `<` escaped.
function write(state: Prose, char: string, rest: () => string, out: string[]): Prose {
  if (char === "`" && !state.escape && !state.mixed && state.until === "") return { ...state, held: char, open: 0, run: 0 }
  const after = char === "<" ? rest() : ""
  const autolink = char === "<" && AUTOLINK.test(after)
  out.push(
    char === "[" && state.last === "!"
      ? "\\["
      : char === "<" && (after === "" || (TAG.test(after) && !autolink))
        ? "&lt;"
        : char,
  )
  const ends = state.until !== "" && char === state.until
  const unplain = state.until !== "" && !ends && UNPLAIN.test(char)
  return {
    ...state,
    last: char,
    escape: char === "\\" && !state.escape,
    until:
      ends || unplain
        ? ""
        : state.until !== ""
          ? state.until
          : autolink
            ? ">"
            : char === "(" && state.last === "]"
              ? ")"
              : "",
    mixed: state.mixed || unplain,
  }
}

// What is held when a line or the text ends: a span that its closing run has just closed, or else prose.
function settle(state: Prose, out: string[]) {
  if (state.held === "") return state
  return state.open !== 0 && state.run === state.open ? close(state, out) : release(state, out)
}

function close(state: Prose, out: string[]) {
  if (state.held.includes("|")) return release(state, out)
  out.push(state.held)
  return { ...state, held: "", open: 0, run: 0, last: "`", escape: false }
}

function release(state: Prose, out: string[]) {
  const held = state.held
  return held
    .split("")
    .reduce<Prose>(
      (current, char, index) => write(current, char, () => held.slice(index + 1), out),
      { ...state, held: "", open: 0, run: 0, mixed: true },
    )
}

function newline(state: Prose, char: string, out: string[]): Prose {
  out.push(char)
  // An address or autolink that a line break cuts is not plain.
  const next = { ...state, line: "", last: char, escape: false, until: "", mixed: state.mixed || state.until !== "" }
  if (state.fence) return { ...next, fence: closes(state.fence, state.line) ? undefined : state.fence }
  const fence = state.lost ? undefined : opens(state.line)
  return {
    ...next,
    fence,
    lost: state.lost || (fence === undefined && FENCE_LINE.test(state.line)),
    // A blank line ends the paragraph, and so does a fence.
    mixed: fence === undefined && !/^[ \t]*$/.test(state.line) && next.mixed,
  }
}

function opens(line: string): Fence | undefined {
  const found = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
  if (!found) return undefined
  const indent = found[1] ?? ""
  const run = found[2] ?? ""
  // A backtick fence's info string has no backtick, or the line is a paragraph.
  if (run.startsWith("`") && found[3]?.includes("`")) return undefined
  return { mark: run.charAt(0), length: run.length, indent: indent.length }
}

// Any indentation is taken, more than Markdown takes, so a block is never thought open after Markdown has ended it.
function closes(fence: Fence, line: string) {
  const run = /^[ \t]*(`+|~+)[ \t]*$/.exec(line)?.[1]
  return run !== undefined && run.charAt(0) === fence.mark && run.length >= fence.length
}

export * as ACPMarkdown from "./markdown"
