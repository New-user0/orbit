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
  /** The fenced code block the text is in, one the tracker is sure every renderer reads as code. */
  readonly fence?: Fence
  /**
   * Whether the tracker is unsure what is code from here on: after a fence line that opens no block it is sure of, a
   * fenced block that it cannot follow (one that a line left by starting to the left of its opening line, or whose
   * closing run stands more than three spaces or a tab in or has anything but spaces after it), after a line with a
   * tilde or the start of an address that GFM links by itself, after a line that starts with a `[` behind any
   * indentation and list or quote marks, which may open a link reference definition, or in a text that a client may
   * join to another's (`follow`). Renderers then differ on which block is open, so from then on no block is thought
   * code, and a `!` or a `<` in it takes a word joiner as in prose.
   */
  readonly lost: boolean
  /** The current line so far. */
  readonly line: string
  /** The last character written. */
  readonly last: string
  /** Whether the line before the current one holds anything, so that a fence line now would be in its paragraph. */
  readonly paragraph: boolean
  /** Whether a line of the text so far starts a list item, whose content a fence line a few spaces in may belong to. */
  readonly list: boolean
}

export const prose: Prose = {
  lost: false,
  line: "",
  last: "",
  paragraph: false,
  list: false,
}

// `<` and a letter, `/`, `!` or `?` opens a raw HTML tag, comment or declaration, and `!` and `[` open an image. A word
// joiner (U+2060) between the two marks is drawn as nothing and read as text by every renderer, so it parts them
// anywhere, even in a link's text that `marked` unescapes and reads again, where an escape would not hold.
const TAG = /^[a-z/!?]/i
const JOINER = String.fromCharCode(0x2060)
// A fence's run behind any indentation and any list or quote marks.
const FENCE_LINE = /^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*(?:`{3}|~{3})/
// A list item's mark, behind any indentation and quote marks.
const LIST_ITEM = /^[ \t>]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/
// A tilde, and the start of an address that GFM links by itself: renderers read either on over marks that end a line
// differently, so after a line with one the tracker gives up.
const UNSURE = /~|www\.|http|ftp:/i
// A line's indentation and any list or quote marks in front of what it holds.
const CONTAINER = /^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*/

/**
 * A model's own Markdown, for a client that renders it: prose and code stay as written, but nothing in it is an image or
 * a raw HTML tag, which a client would fetch from an address that a model, or a repository that steers it, chose
 * (classes 6 and 9). A word joiner (U+2060) follows every `!` before a `[` and every `<` before a letter, `/`, `!` or
 * `?`: it is drawn as nothing, so a person reads the text as written, while the image becomes a link to its address that
 * nothing fetches and the tag reads as text. Code spans take joiners too, as every renderer reads a backtick a little
 * differently, so `` `Vec<T>` `` carries one that a person does not see.
 *
 * The one place text is left as written is a fenced block that every renderer reads as code: it opens with a line of
 * three or more backticks or tildes at most three spaces in, with no list or quote mark and no pipe after it, right
 * after a blank line or at the text's start, so outside any paragraph or table, before any line of the text that starts
 * with a `[` behind any indentation and list or quote marks, and only at no indentation once a list item has started,
 * whose content a line a few spaces in may continue. It ends at a line of a run of the same mark at least as long, at
 * most three spaces in, with only spaces after it. A fence line anywhere else opens no block the tracker is sure of, so
 * it gives up (`lost`) and from then on writes joiners in every block. It gives up as well where a line left a block by
 * starting to the left of its opening line, at a closing run further in, after a tab or before anything but spaces,
 * after a line with a tilde or the start of an address that GFM links by itself, and after a line that starts with a
 * `[`. Such a line may open a link reference definition, whose label and title `marked` reads on over blank lines and
 * fence lines alike, and the tracker does not follow definitions; so a code block after it, a task box's or a link's
 * line too, carries joiners.
 *
 * Text arrives in pieces, so `state` carries what one piece leaves open to the next. A `!` or a `<` that ends a piece
 * takes a joiner too, since what follows it is not known yet.
 */
export function withoutImages(state: Prose, text: string): [Prose, string] {
  const out: string[] = []
  // By UTF-16 unit, so an index is a position in `text`; every mark looked at is one unit.
  const next = text
    .split("")
    .reduce<Prose>((current, char, index) => step(current, char, () => text.slice(index + 1), out), state)
  return [next, out.join("")]
}

/**
 * Where a text picks up after a client was sent a piece of another: a client may draw it in a block of its own, or
 * append it to the block that holds the text sent before it, as some do with every chunk until a tool call (`before`
 * is the state that text left). The two read it alike only where both texts stand at the start of a line with no
 * block open and the tracker sure of both (no `[` line in either, for one), and even there a fence line that starts
 * this text is taken as code only where it would be after the lines that ended either text, a list item that either
 * holds included. Anywhere else nothing more of the text is taken as code. Either reading then at most carries a joiner in code (classes 6 and 9).
 */
export function follow(state: Prose, before: Prose): Prose {
  // A client that joins the two reads a fence line that starts this text after the lines that ended the text before.
  if (clear(state) && clear(before))
    return { ...state, paragraph: state.paragraph || before.paragraph, list: state.list || before.list }
  return { ...state, fence: undefined, lost: true }
}

function clear(state: Prose) {
  return state.fence === undefined && !state.lost && state.line === ""
}

function step(state: Prose, char: string, rest: () => string, out: string[]): Prose {
  // A carriage return ends a line as a line feed does, and the two together end one line.
  if (char === "\n" && state.last === "\r" && state.line === "") {
    out.push(char)
    return { ...state, last: char }
  }
  if (char === "\n" || char === "\r") return newline(state, char, out)
  if (state.fence) {
    if (state.line.length < state.fence.indent && char !== " " && /^ *$/.test(state.line))
      return step({ ...state, fence: undefined, lost: true }, char, rest, out)
    out.push(char)
    return { ...state, line: state.line + char, last: char }
  }
  // Prose: a word joiner after a `!` or a `<` that the piece's end or what opens an image or a tag follows.
  const after = char === "<" || char === "!" ? rest() : ""
  out.push(
    (char === "!" && (after === "" || after.startsWith("["))) || (char === "<" && (after === "" || TAG.test(after)))
      ? char + JOINER
      : char,
  )
  return { ...state, line: state.line + char, last: char }
}

function newline(state: Prose, char: string, out: string[]): Prose {
  out.push(char)
  const next = { ...state, line: "", last: char }
  if (state.fence) {
    const closing = closes(state.fence, state.line)
    if (closing === "open") return next
    return { ...next, fence: undefined, lost: state.lost || closing === "unsure" }
  }
  const fence = opens(state)
  return {
    ...next,
    fence,
    // A fence line that opens no block leaves the tracker unsure, and so do a line with a tilde or the start of an
    // address that GFM links by itself and a line that may open a link reference definition.
    lost:
      state.lost ||
      state.line.replace(CONTAINER, "").startsWith("[") ||
      (fence === undefined && (FENCE_LINE.test(state.line) || UNSURE.test(state.line))),
    paragraph: !/^[ \t]*$/.test(state.line),
    list: state.list || LIST_ITEM.test(state.line),
  }
}

// The block that the line `state` ends opens, when every renderer is sure to read it as a fenced code block: see
// `withoutImages`.
function opens(state: Prose): Fence | undefined {
  if (state.lost || state.paragraph) return undefined
  const found = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(state.line)
  if (!found) return undefined
  const indent = found[1] ?? ""
  const run = found[2] ?? ""
  // A backtick fence's info string has no backtick, or the line is a paragraph, and a pipe might start a table.
  if ((run.startsWith("`") && found[3]?.includes("`")) || found[3]?.includes("|")) return undefined
  if (state.list && indent !== "") return undefined
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
