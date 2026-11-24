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
   * Whether the tracker is unsure what is code from here on: after a fenced block that it cannot follow (one behind a
   * list's or a quote's mark or more than three spaces in, one that a line left by starting to the left of its opening
   * line, one whose closing run stands more than three spaces or a tab in or has anything but spaces after it), after a
   * line with a tilde or the start of an address that GFM links by itself, or in a text that a client may join to
   * another's (`follow`). Renderers then differ on what is code, so from then on no block or span is thought code, and
   * a `!` or a `<` in either takes a word joiner as in prose.
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
  /** The last four characters of the current line, held ones too. */
  readonly tail: string
  /** Whether that character is a backslash that escapes the next one. */
  readonly escape: boolean
  /** The mark that ends the link address or autolink the text is in: `)` or `>`, or "" outside one. */
  readonly until: string
  /** Whether a backtick in the rest of the paragraph may belong to something other than a code span. */
  readonly mixed: boolean
  /**
   * Whether the paragraph has a `[` that no `]` has closed yet. A full, collapsed or shortcut reference's label may
   * take a backtick in it from a code span (md4c and `marked`), so a backtick after it opens no span.
   */
  readonly bracket: boolean
  /**
   * How far the lines so far go into a link reference definition that `marked` may still read over the next line: its
   * label (`label`), its `]:` with no destination yet (`destination`), a destination that a title may still follow on
   * the next line (`after`), or a title left open by its quote or parenthesis (`"`, `'` or `)`); "" for none. `marked`
   * reads a definition before it looks for any block, so a fence line there is part of the definition to it, where
   * md4c opens a block.
   */
  readonly definition: Definition
  /**
   * What the lines since the last blank line or fence make, as far as a fence line after them goes: "" for nothing,
   * "text" for a paragraph, "table" for a table, whose rows run to a blank line and take a fence line as one more row,
   * or "task" for a list item that holds only a task box, which takes the next line that is not blank as its text,
   * a fence line too.
   */
  readonly paragraph: Paragraph
  /**
   * Whether the text before this one ended in a backtick that a client joining the two would run on into a backtick
   * that starts this one, so that one is written escaped.
   */
  readonly joined: boolean
}

type Paragraph = "" | "text" | "table" | "task"
type Title = '"' | "'" | ")"
type Definition = "" | "label" | "destination" | "after" | Title
// From the least to the most a fence line after it is unsure.
const PARAGRAPHS: Paragraph[] = ["", "text", "table", "task"]

export const prose: Prose = {
  lost: false,
  held: "",
  open: 0,
  run: 0,
  line: "",
  last: "",
  tail: "",
  escape: false,
  until: "",
  mixed: false,
  bracket: false,
  definition: "",
  paragraph: "",
  joined: false,
}

// `<` and a letter, `/`, `!` or `?` opens a raw HTML tag, comment or declaration, and `!` and `[` open an image. A word
// joiner (U+2060) between the two marks is drawn as nothing and read as text by every renderer, so it parts them
// anywhere, even in a link's text that `marked` unescapes and reads again, where an escape would not hold.
const TAG = /^[a-z/!?]/i
const JOINER = String.fromCharCode(0x2060)
// An autolink (`<https://...>`) names a scheme and a colon after its `<`.
const AUTOLINK = /^[a-z][a-z0-9+.-]{1,31}:/i
// A mark that can make a link's address or an autolink other than a plain run up to its end: a space or a line break,
// a quote or a parenthesis of a title, an angle bracket, a backslash or a backtick.
const UNPLAIN = /[\s"'()<>\\`]/
// A fence's run behind any indentation and any list or quote marks.
const FENCE_LINE = /^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*(?:`{3}|~{3})/
// A table's delimiter row under its header, such as `|---|:-:|` or `--|--`, at any indentation and behind quote marks.
const DELIMITER_ROW = /^[ \t>]*(?=[^|]*\|)(?=[^-]*-)[-|: \t]+$/
// A list item that holds only a task box, behind any indentation and any list or quote marks.
const EMPTY_TASK = /^(?:[ \t>]*(?:[-+*]|\d{1,9}[.)])[ \t]+)+\[[ xX]\][ \t]*$/
// The start of an address that GFM links by itself, which `marked` runs on over a backtick, and a tilde, after which
// `marked` takes a backtick as text: after either no backtick is sure to open a span.
const LINK_START = /^(?:www\.|http|ftp:)$/i
const UNSURE = /~|www\.|http|ftp:/i
// A line's indentation and any list or quote marks in front of what it holds.
const CONTAINER = /^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*/
// The parts of a link reference definition, as `marked` reads them: a label has no unescaped bracket, a destination is
// `<...>` on one line or a run with no space, and a title is quoted or in parentheses and may run over several lines.
const LABEL = /^(?:\\.|[^[\]\\])*/
const DESTINATION = /^[ \t]*(?:<[^<>]*>|[^<\s]\S*)/
const TITLE = { '"': /^(?:\\.|[^"\\])*/, "'": /^(?:\\.|[^'\\])*/, ")": /^[^()]*/ }
const TITLE_OPENER: Record<string, Title | undefined> = { '"': '"', "'": "'", "(": ")" }
// A label, a `"` title and a `(` title run on over a blank line to `marked`.
const OVER_BLANK: Definition[] = ["label", '"', ")"]

/**
 * A model's own Markdown, for a client that renders it: prose and code stay as written, but nothing in it is an image or
 * a raw HTML tag, which a client would fetch from an address that a model, or a repository that steers it, chose
 * (classes 6 and 9). Outside code, a word joiner (U+2060) follows every `!` before a `[` and every `<` before a letter,
 * `/`, `!` or `?`: it is drawn as nothing, so a person reads the text as written, while the image becomes a link to its
 * address that nothing fetches and the tag reads as text. Text is left as written only where Markdown is sure to read
 * it as code, and the tracker that decides so gives up (`lost`) wherever renderers may differ:
 *
 * - A fenced block, opened by a line of three or more backticks or tildes after at most three spaces, and ended by a
 *   line of a run of the same mark at least as long after at most three spaces, with only spaces after it. A line of
 *   such a run further in, after a tab or before anything else is code to Markdown, and so is a line that starts to
 *   the left of the opening one, which may yet end the list item that holds the block. After any of them, or a fence
 *   behind a list's or a quote's mark or more than three spaces in, renderers differ on which block is open, so the
 *   tracker gives up. It gives up as well at a fence line in a table, from the delimiter row under the table's header
 *   to a blank line, and at a fence line that is the first line not blank after a list item that holds only a task box,
 *   as md4c reads either line as text.
 * - A code span, whose text is held back from its opening run until a run of the same length closes it on the same
 *   line. A run that a backslash escapes, or that is inside a link's address after its `](` or an autolink, opens
 *   nothing. An address or autolink that is not a plain run up to its `)` or `>` may hold a title or a backtick of its
 *   own, so the backticks in the rest of that paragraph open nothing, and so do the backticks after a tilde or the
 *   start of an address that GFM links by itself, which the tracker then gives up at. A span that its line or the text
 *   ends before it closes is written as prose, and so is one with a `|`, which a table splits into two cells; the
 *   backticks in the rest of that paragraph then open nothing too.
 *
 * Text arrives in pieces, so `state` carries what one piece leaves open to the next, and `end` writes what is still
 * held when the text ends; the state it then returns is what the text leaves for one sent after it (`follow`). A `!` or
 * a `<` that ends a piece takes a joiner too, since what follows it is not known yet.
 */
export function withoutImages(state: Prose, text: string, end = false): [Prose, string] {
  const out: string[] = []
  // By UTF-16 unit, so an index is a position in `text`; every mark looked at is one unit.
  const next = text
    .split("")
    .reduce<Prose>((current, char, index) => step(current, char, () => text.slice(index + 1), out), state)
  if (!end) return [next, out.join("")]
  // `settle` writes what is held before the pieces are joined.
  const settled = settle(next, out)
  // A client that joins this text to the next would run a backtick that ends it on into one that starts that text.
  return [{ ...settled, joined: settled.last === "`" }, out.join("")]
}

/**
 * Where a text picks up after a client was sent a piece of another: a client may draw it in a block of its own, or
 * append it to the block that holds the text sent before it, as some do with every chunk until a tool call (`before`
 * is the state that text left). The two read it alike only where both texts stand at the start of a line with no
 * block, span or mixed paragraph open, and even there a fence line that starts this text is not taken as code after a
 * table or an empty task item that ends the text before. Anywhere else what is held is written as prose and nothing
 * more of the text is taken as code; this text's first line continues the line the text before left, and a backtick
 * that starts it after one that ended the text before is written escaped, so it lengthens no run that closed a span.
 * Either reading then at most carries a joiner in code (classes 6 and 9).
 */
export function follow(state: Prose, before: Prose): [Prose, string] {
  // A client that joins the two reads a fence line that starts this text after the lines that ended the text before.
  const strictest = PARAGRAPHS[Math.max(PARAGRAPHS.indexOf(state.paragraph), PARAGRAPHS.indexOf(before.paragraph))]
  if (clear(state) && clear(before)) return [{ ...state, paragraph: strictest ?? "" }, ""]
  const out: string[] = []
  const released = state.held === "" ? state : release(state, out)
  return [
    {
      ...released,
      fence: undefined,
      lost: true,
      mixed: true,
      // A client that joins the two continues the line the text before left, so this text's first line break ends
      // that line rather than a blank one.
      line: before.line + released.line,
      joined: before.last === "`" || released.joined,
    },
    out.join(""),
  ]
}

function clear(state: Prose) {
  return (
    state.fence === undefined &&
    !state.lost &&
    !state.mixed &&
    !state.bracket &&
    state.definition === "" &&
    state.line === ""
  )
}

function step(state: Prose, char: string, rest: () => string, out: string[]): Prose {
  // A carriage return ends a line as a line feed does, and the two together end one line: only when nothing came
  // between them, as a held backtick leaves `last` as it was.
  if (char === "\n" && state.last === "\r" && state.line === "") {
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
  const tail = (state.tail + char).slice(-4)
  const current = {
    ...state,
    line: state.line + char,
    tail,
    mixed: state.mixed || char === "~" || LINK_START.test(tail),
  }
  if (current.held === "") return write(current, char, rest, out)
  if (char === "`") return { ...current, held: current.held + char, run: current.open === 0 ? 0 : current.run + 1 }
  if (current.open === 0) return { ...current, held: current.held + char, open: current.held.length }
  if (current.run === current.open) return write(close(current, out), char, rest, out)
  return { ...current, held: current.held + char, run: 0 }
}

// Prose: a backtick run that may open a span starts to be held back, unless the tracker is unsure, and anything else is
// written, with a word joiner after a `!` or a `<` that the piece's end or what opens an image or a tag follows.
function write(state: Prose, char: string, rest: () => string, out: string[]): Prose {
  if (
    char === "`" &&
    !state.escape &&
    !state.mixed &&
    !state.joined &&
    !state.lost &&
    !state.bracket &&
    state.until === ""
  )
    return { ...state, held: char, open: 0, run: 0 }
  const after = char === "<" || char === "!" ? rest() : ""
  const autolink = char === "<" && AUTOLINK.test(after)
  out.push(
    (char === "!" && (after === "" || after.startsWith("["))) || (char === "<" && (after === "" || TAG.test(after)))
      ? char + JOINER
      : char === "`" && state.joined
        ? "\\`"
        : char,
  )
  const ends = state.until !== "" && char === state.until
  const unplain = state.until !== "" && !ends && UNPLAIN.test(char)
  return {
    ...state,
    last: char,
    joined: false,
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
    mixed: state.mixed || unplain || (char === "`" && state.bracket),
    bracket: state.escape || (char !== "[" && char !== "]") ? state.bracket : char === "[",
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
    .reduce<Prose>((current, char, index) => write(current, char, () => held.slice(index + 1), out), {
      ...state,
      held: "",
      open: 0,
      run: 0,
      mixed: true,
    })
}

function newline(state: Prose, char: string, out: string[]): Prose {
  out.push(char)
  // An address or autolink that a line break cuts is not plain.
  const next = {
    ...state,
    line: "",
    last: char,
    tail: "",
    escape: false,
    until: "",
    mixed: state.mixed || state.until !== "",
    joined: false,
  }
  if (state.fence) {
    const closing = closes(state.fence, state.line)
    if (closing === "open") return next
    return { ...next, fence: undefined, lost: state.lost || closing === "unsure" }
  }
  // md4c reads a fence line in a table's rows, or after a list item that holds only a task box, as text, where other
  // renderers open a block, and `marked` reads one inside a link reference definition as part of it, so a fence line in
  // any of them opens none.
  const fence =
    state.lost ||
    state.paragraph === "table" ||
    state.paragraph === "task" ||
    (state.definition !== "" && state.definition !== "after")
      ? undefined
      : opens(state.line)
  const blank = /^[ \t]*$/.test(state.line)
  return {
    ...next,
    fence,
    // A fence line that opens no block leaves the tracker unsure, and so does a line with a tilde or the start of an
    // address that GFM links by itself.
    lost: state.lost || (fence === undefined && (FENCE_LINE.test(state.line) || UNSURE.test(state.line))),
    // A blank line ends the paragraph, and so does a fence.
    mixed: fence === undefined && !blank && next.mixed,
    bracket: fence === undefined && !blank && state.bracket,
    definition: definition(state.definition, state.line, blank),
    paragraph: fence ? "" : blank ? (state.paragraph === "task" ? "task" : "") : paragraph(state.paragraph, state.line),
  }
}

// What a line that is neither blank nor a fence makes of the lines before it.
function paragraph(before: Paragraph, line: string): Paragraph {
  if (EMPTY_TASK.test(line)) return "task"
  if (before === "table" || (before === "text" && DELIMITER_ROW.test(line))) return "table"
  return "text"
}

// Where a line leaves a link reference definition that `marked` may read over the next line. Any line that starts with
// a `[` may start one, as far as the tracker knows.
function definition(before: Definition, line: string, blank: boolean): Definition {
  if (blank) return OVER_BLANK.includes(before) ? before : ""
  const text = line.replace(CONTAINER, "")
  const opener = TITLE_OPENER[text.charAt(0)]
  if (before === "after" && opener) return title(opener, text.slice(1))
  if (before === "" || before === "after") return text.startsWith("[") ? label(text.slice(1)) : ""
  if (before === "label") return label(text)
  if (before === "destination") return destination(text)
  return title(before, text)
}

function label(text: string): Definition {
  const rest = text.slice(LABEL.exec(text)?.[0].length)
  if (rest === "" || rest === "\\") return "label"
  return rest.startsWith("]:") ? destination(rest.slice(2)) : ""
}

function destination(text: string): Definition {
  if (/^[ \t]*$/.test(text)) return "destination"
  const found = DESTINATION.exec(text)
  if (!found) return ""
  const rest = text.slice(found[0].length)
  if (/^[ \t]*$/.test(rest)) return "after"
  const opener = /^[ \t]+(.)/.exec(rest)
  const closer = TITLE_OPENER[opener?.[1] ?? ""]
  return opener && closer ? title(closer, rest.slice(opener[0].length)) : ""
}

// A title the line opens or carries on stays open while its closing mark is not on the line.
function title(closer: Title, text: string): Definition {
  return text.slice(TITLE[closer].exec(text)?.[0].length) === "" ? closer : ""
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

// A run of the block's mark, at least as long as its opening run, closes it after at most three spaces when only spaces
// follow it. Renderers differ on the rest: Markdown reads a run further in, after a tab, or before anything but spaces
// and tabs as code; `marked` closes the block on a run with more backticks or tildes after it, and not on one with a
// tab after it. A renderer that read such a line otherwise would take the next fence line the other way, so that is
// where the tracker gives up.
function closes(fence: Fence, line: string) {
  const found = /^([ \t]*)(`+|~+)(.*)$/.exec(line)
  const run = found?.[2] ?? ""
  if (run.charAt(0) !== fence.mark || run.length < fence.length) return "open"
  return /^ {0,3}$/.test(found?.[1] ?? "") && /^ *$/.test(found?.[3] ?? "") ? "closed" : "unsure"
}

export * as ACPMarkdown from "./markdown"
