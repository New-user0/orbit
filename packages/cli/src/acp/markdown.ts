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

/** What one piece of a model's streamed text leaves open for the next: see `withoutImages`. */
export type Prose = {
  /** The length of the backtick run that opened the code the text is in, or 0 outside code. */
  readonly code: number
  /** The backticks at the end of the text so far, whose run may go on in the next piece. */
  readonly run: number
  /** The last character of the text so far. */
  readonly last: string
}

export const prose: Prose = { code: 0, run: 0, last: "" }

// A raw HTML tag opens with `<` and a letter; an autolink (`<https://...>`) names a scheme and a colon first.
const TAG = /^[a-z]/i
const AUTOLINK = /^[a-z][a-z0-9+.-]{1,31}:/i

/**
 * A model's own Markdown, for a client that renders it: prose and code stay as written, but nothing in it is an image or
 * a raw HTML tag, which a client would fetch from an address that a model, or a repository that steers it, chose
 * (classes 6 and 9). Outside code, the `[` of an image's `![` is written `\[`, so the image reads as its text and its
 * address, as the reference's own renderer shows it; and the `<` that opens a tag is written `&lt;`, which a Markdown
 * client draws as `<`. Code spans and fenced blocks are left alone. Text arrives in pieces, so `state` carries what one
 * piece leaves open to the next; a `<` that ends a piece is written `&lt;`, since the tag it may open is not known yet.
 */
export function withoutImages(state: Prose, text: string): [Prose, string] {
  const out: string[] = []
  // By UTF-16 unit, so an index is a position in `text`; every mark looked at is one unit.
  const next = text.split("").reduce<Prose>((current, char, index) => {
    if (char === "`") {
      out.push(char)
      return { ...current, run: current.run + 1, last: char }
    }
    // A run of backticks has ended: it opens code, or closes the code a run of its length (or a fence, a longer one) opened.
    const code =
      current.run === 0
        ? current.code
        : current.code === 0
          ? current.run
          : current.run === current.code || (current.code >= 3 && current.run >= current.code)
            ? 0
            : current.code
    const rest = text.slice(index + 1)
    out.push(
      code !== 0
        ? char
        : char === "[" && current.last === "!"
          ? "\\["
          : char === "<" && (rest === "" || (TAG.test(rest) && !AUTOLINK.test(rest)))
            ? "&lt;"
            : char,
    )
    return { code, run: 0, last: char }
  }, state)
  return [next, out.join("")]
}

export * as ACPMarkdown from "./markdown"
