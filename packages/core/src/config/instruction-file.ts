export * as ConfigInstructionFile from "./instruction-file.js"

import { CompatInstructions } from "@orbit/compat/instructions"
import type { Entry } from "@orbit/schema/config"
import { Glob } from "@orbit/util/glob"
import { Effect } from "effect"
import { ConfigMarkdown } from "./markdown.js"

/** The most characters an instruction file may hold before it is flagged. A flagged file is still sent whole. */
export const LIMIT = 40_000

/**
 * The instruction file names to look for in each directory, in priority order. Every loader asks here, the discovery at
 * session start and the one that follows the model's reads, so that the two never disagree about names.
 */
export function names(compat: boolean) {
  return CompatInstructions.filenames(compat)
}

/** Whether a processed instruction file is long enough to be flagged: more than `LIMIT` characters, as the string counts them. */
export function oversized(content: string) {
  return content.length > LIMIT
}

/**
 * What the model reads of an instruction file. With `frontmatter`, a block of front matter at the top of the file goes,
 * found by `ConfigMarkdown.split` and never evaluated, together with the blank lines after it. Then every HTML comment
 * that makes a block of its own at the top level of the document goes. Fenced and indented code, inline code, comments
 * inside a sentence, and comments inside a list, a quote or another HTML block are text, and stay.
 *
 * A file without front matter or comment blocks comes back as it is, line endings included. When a comment goes, the
 * text has LF line endings. `stripped` says whether anything went. The function reads the text once and keeps no state,
 * and it does not throw.
 */
export function parse(text: string, options?: { readonly frontmatter?: boolean }) {
  const split = options?.frontmatter ? ConfigMarkdown.split(text) : { body: text }
  const body = split.frontmatter === undefined ? text : split.body.replace(/^(?:[ \t]*\r?\n)+/, "")
  const content = removeComments(body)
  return { content: content ?? body, stripped: split.frontmatter !== undefined || content !== undefined }
}

/**
 * Every pattern of `instructions_exclude` that the documents in `entries` set, in the order of the entries and without
 * repeats. The lists of all scopes add together, as other settings' lists do, and a document that is not trusted has
 * already lost its list (`ConfigTrust`).
 */
export function excludes(entries: readonly Entry[]) {
  return [...new Set(entries.flatMap((entry) => (entry.type === "document" ? (entry.info.instructions_exclude ?? []) : [])))]
}

/**
 * Makes the patterns ready to match. A pattern is written with forward slashes, whatever the platform, and a backslash
 * cannot escape a glob character. Empty patterns go, and so does one that the matcher refuses, with a line in the log.
 * An absolute pattern is also given the form it has through the real path of its fixed part, so that a pattern written
 * through a link matches a file found under the folder the link leads to. A network path is never resolved, so no
 * pattern makes Orbit reach a share, and a folder that is not there adds nothing.
 */
export const prepare = Effect.fn("ConfigInstructionFile.prepare")(function* (
  patterns: readonly string[],
  resolve: (directory: string) => Effect.Effect<string>,
  platform: NodeJS.Platform = process.platform,
) {
  const written = [...new Set(patterns.map(slashed).filter((pattern) => pattern !== ""))]
  const usable = yield* Effect.filter(written, (pattern) =>
    matches(pattern, "") === undefined
      ? Effect.logWarning("instructions_exclude pattern ignored", { characters: pattern.length }).pipe(Effect.as(false))
      : Effect.succeed(true),
  )
  const real = yield* Effect.forEach(usable, (pattern) => realForm(pattern, resolve, platform))
  return [...new Set([...usable, ...real.flat()])]
})

/**
 * Whether any pattern matches any of the spellings of one file, both written with forward slashes first. A pattern
 * matches the whole absolute path, and wildcards match names that start with a dot. A pattern with no folder in it, such
 * as `AGENTS.md`, matches nothing: two asterisks and a slash in front of it make it match that name anywhere.
 */
export function excluded(patterns: readonly string[], paths: readonly string[]) {
  const spellings = paths.map(slashed)
  return patterns.some((pattern) => spellings.some((path) => matches(slashed(pattern), path) === true))
}

/**
 * The files of `found`, which a walk names by the path it built, that no pattern excludes, each with its real path. A file
 * is excluded when a pattern matches either spelling.
 */
export const included = Effect.fn("ConfigInstructionFile.included")(function* (
  patterns: readonly string[],
  found: readonly string[],
  resolve: (path: string) => Effect.Effect<string>,
) {
  const files = yield* Effect.forEach(found, (file) => resolve(file).pipe(Effect.map((real) => ({ file, real }))))
  return yield* Effect.filter(files, (item) =>
    excluded(patterns, [item.file, item.real])
      ? Effect.logDebug("instruction file excluded", { path: item.file }).pipe(Effect.as(false))
      : Effect.succeed(true),
  )
})

// Forward slashes, and an upper-case drive letter, which Windows does not tell apart and a Linux host would.
function slashed(value: string) {
  return value.replaceAll("\\", "/").replace(/^([a-z]):\//, (_, drive: string) => `${drive.toUpperCase()}:/`)
}

// A pattern that the matcher refuses, which it does by throwing for one over 64 KiB, excludes nothing and is `undefined`.
function matches(pattern: string, path: string) {
  try {
    return Glob.match(pattern, path)
  } catch {
    return undefined
  }
}

const realForm = Effect.fnUntraced(function* (
  pattern: string,
  resolve: (directory: string) => Effect.Effect<string>,
  platform: NodeJS.Platform,
) {
  const absolute = platform === "win32" ? /^[A-Z]:\//.test(pattern) : pattern.startsWith("/") && !pattern.startsWith("//")
  if (!absolute) return []
  // The fixed part is what comes before the first character that a glob gives a meaning, and the folder is the one it
  // names or, when it ends in a name, the one it is in.
  const glob = pattern.search(/[*?{[]/)
  const fixed = glob === -1 ? pattern : pattern.slice(0, glob)
  const folder = fixed.endsWith("/") ? fixed.slice(0, -1) : fixed.slice(0, fixed.lastIndexOf("/"))
  // A root is its own folder, and `C:` alone would be the current folder of the drive.
  const root = folder === "" || /^[A-Z]:$/.test(folder)
  const resolved = slashed(
    yield* resolve(root ? `${folder}/` : folder).pipe(Effect.catchDefect(() => Effect.succeed(folder))),
  ).replace(/\/$/, "")
  return resolved === folder ? [] : [resolved + pattern.slice(folder.length)]
})

// ---------------------------------------------------------------------------------------------------------------------
// Comment blocks
//
// An HTML comment is taken off only when it is a block of its own at the top level of the document, the way the block
// lexer that the reference uses splits it: it starts a line that is indented by at most three columns, outside fenced
// code, outside another HTML block, and outside the list item, quote or paragraph that it could belong to. The
// document is read once, line by line, and every kind of block that can hold a comment line without being one is
// followed just far enough to tell where it ends, so the time is linear in the size of the file, whatever it holds
// (`test/config/instruction-file.test.ts` runs hostile files under a deadline). The block lexer of a Markdown library is
// not: it is far from linear on a long list item, and a clone chooses these files before anyone has trusted it.
//
// Where that lexer reads a construct other than the CommonMark rules say, this follows the lexer, because it is the
// reference's: a comment indented under a paragraph line is more of the paragraph, and a line that opens with a tag
// ends a list item. The tests pin each of those, and name the cases that the two readings split.

type Fence = { readonly char: string; readonly length: number }

// What ends an HTML block that is open: a pattern that a line holds, or a blank line.
type End = RegExp | "blank"

function removeComments(text: string) {
  if (!text.includes("<!--")) return undefined
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const kept: string[] = []
  let removed = false
  let fence: Fence | undefined
  let html: End | undefined
  // The list that the line is in, by the column its items' text starts at, whether its last line was text, which a later
  // line that is not indented enough can still continue, and whether its item is still empty, which a blank line closes.
  let list: { offset: number; text: boolean; empty: boolean } | undefined
  // Whether a line that is not a quote's can still be part of it: the lines go on until a blank one or one that starts a
  // block, unless the quote's last line is empty or code.
  let quote = false
  let paragraph = false

  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!
    if (fence) {
      kept.push(line)
      if (closes(fence, line)) fence = undefined
      continue
    }
    if (html) {
      kept.push(line)
      if (html === "blank" ? isBlank(line) : html.test(line)) {
        html = undefined
        paragraph = false
      }
      continue
    }
    if (isBlank(line)) {
      kept.push(line)
      paragraph = false
      quote = false
      if (list?.empty) list = undefined
      else if (list) list.text = false
      continue
    }
    const lead = /^[ \t]*/.exec(line)![0]
    const rest = line.slice(lead.length)
    const indent = width(lead, 0)

    if (list) {
      if (indent >= list.offset) {
        kept.push(line)
        list.text = indent - list.offset < 4 && textual(rest)
        list.empty = false
        continue
      }
      const item = indent < 4 && !isBreak(rest) ? listItem(rest, indent) : undefined
      if (item) {
        list = { offset: item.offset, text: item.plain && textual(item.content), empty: item.empty }
        kept.push(line)
        continue
      }
      if (list.text && !(indent < 4 && interrupts(rest))) {
        kept.push(line)
        continue
      }
      list = undefined
    }
    if (indent < 4 && rest.startsWith(">")) {
      quote = quoted(rest)
      paragraph = false
      kept.push(line)
      continue
    }
    if (quote) {
      if (indent >= 4 || !startsBlock(rest, indent)) {
        kept.push(line)
        continue
      }
      quote = false
    }

    // Four columns make code, or more of the paragraph above, and neither holds a block.
    if (indent >= 4) {
      kept.push(line)
      continue
    }
    const opening = fenceOpening(rest)
    if (opening) {
      fence = opening
      paragraph = false
      kept.push(line)
      continue
    }
    if (rest.startsWith("<!--") && !(paragraph && indent > 0)) {
      let last = at
      while (last < lines.length - 1 && !lines[last]!.includes("-->")) last++
      const block = lines.slice(at, last + 1).join("\n")
      const left = withoutSpans(block)
      paragraph = false
      if (left === block) {
        for (let index = at; index <= last; index++) kept.push(lines[index]!)
        at = last
        continue
      }
      removed = true
      if (left.trim() !== "") {
        for (const remaining of left.split("\n")) kept.push(remaining)
        at = last
        continue
      }
      // The blank lines after the block go with it. One stays when the text before it has none, so that two paragraphs
      // that the comment kept apart are not made one.
      let next = last + 1
      while (next < lines.length && isBlank(lines[next]!)) next++
      const before = kept.at(-1)
      if (next < lines.length && next > last + 1 && before !== undefined && !isBlank(before)) kept.push("")
      at = next - 1
      continue
    }
    const end = htmlBlock(rest, indent, paragraph)
    if (end !== undefined) {
      // A block that its first line already closes is that line alone.
      if (end === "blank" || !end.test(rest)) html = end
      paragraph = false
      kept.push(line)
      continue
    }
    if (/^#{1,6}(?:[ \t]|$)/.test(rest) || isBreak(rest) || (paragraph && /^(?:=+|-+)[ \t]*$/.test(rest))) {
      paragraph = false
      kept.push(line)
      continue
    }
    const item = listItem(rest, indent)
    if (item && (!paragraph || (!item.empty && item.first))) {
      list = { offset: item.offset, text: item.plain && textual(item.content), empty: item.empty }
      paragraph = false
      kept.push(line)
      continue
    }
    paragraph = true
    kept.push(line)
  }

  if (!removed) return undefined
  // The text ends the way it did, with no blank lines before the end that a comment left.
  while (kept.length > 0 && isBlank(kept.at(-1)!)) kept.pop()
  return kept.join("\n") + (kept.length > 0 && text.endsWith("\n") ? "\n" : "")
}

// `block` without every complete comment in it: from an opening marker to the first closing marker after it. An opening
// marker that is never closed stays, with everything after it. Each search starts where the last one ended.
function withoutSpans(block: string) {
  let result = ""
  let from = 0
  for (;;) {
    const open = block.indexOf("<!--", from)
    if (open === -1) break
    const close = block.indexOf("-->", open + 4)
    if (close === -1) break
    result += block.slice(from, open)
    from = close + 3
  }
  return result + block.slice(from)
}

function isBlank(line: string) {
  return /^[ \t]*$/.test(line)
}

// The columns that spaces and tabs take from a column, a tab going to the next multiple of four.
function width(whitespace: string, from: number) {
  let column = from
  for (const char of whitespace) column += char === "\t" ? 4 - (column % 4) : 1
  return column - from
}

function fenceOpening(rest: string): Fence | undefined {
  const match = /^(`{3,}|~{3,})(.*)$/.exec(rest)
  if (!match || (match[1]!.startsWith("`") && match[2]!.includes("`"))) return undefined
  return { char: match[1]![0]!, length: match[1]!.length }
}

function closes(fence: Fence, line: string) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return match !== null && match[1]!.startsWith(fence.char) && match[1]!.length >= fence.length
}

function isBreak(rest: string) {
  if (!/^[-*_]/.test(rest)) return false
  const compact = rest.replaceAll(/[ \t]/g, "")
  return compact.length >= 3 && /^([-*_])\1+$/.test(compact)
}

const blockTags =
  /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$)/i
const lonelyTag =
  /^(?:<([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/([A-Za-z][A-Za-z0-9-]*)\s*>)\s*$/

// What ends the HTML block that a line starts, other than a comment, or `undefined` for a line that starts none. Inside a
// paragraph only a block of a script, pre, style or textarea tag or of a block-level tag takes over, and only from the
// first column: the lexer that the reference uses reads the others, and an indented one, as more of the paragraph.
function htmlBlock(rest: string, indent: number, paragraph: boolean): End | undefined {
  if (!rest.startsWith("<") || (paragraph && indent > 0)) return undefined
  const raw = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(rest)
  if (raw) return new RegExp(`</${raw[1]}>`, "i")
  if (blockTags.test(rest)) return "blank"
  if (paragraph) return undefined
  if (rest.startsWith("<?")) return /\?>/
  if (rest.startsWith("<![CDATA[")) return /\]\]>/
  if (/^<![A-Za-z]/.test(rest)) return />/
  if (rest.length > 1000) return undefined
  const tag = lonelyTag.exec(rest)
  if (tag && !/^(?:script|style|pre|textarea)$/i.test(tag[1] ?? tag[2]!)) return "blank"
  return undefined
}

// The first line of a list item, or `undefined` for a line that is not one. `offset` is the column that a later line
// must reach to belong to the item, which is where its text starts: after the marker and the spaces that follow it, or
// one column after the marker when the item is empty or opens with code.
function listItem(rest: string, indent: number) {
  const match = /^([-+*]|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/.exec(rest)
  if (!match) return undefined
  const content = match[4] ?? ""
  const gap = width(match[3] ?? "", indent + match[1]!.length)
  return {
    offset: indent + match[1]!.length + (content === "" || gap > 4 ? 1 : gap),
    content,
    empty: content === "",
    // The text of an item that opens with four spaces is code, which no later line goes on with.
    plain: gap < 4,
    // Only a bullet, or an ordered item numbered 1, can begin a list inside a paragraph.
    first: match[2] === undefined || Number(match[2]) === 1,
  }
}

// Whether a later line that is not indented enough can go on with this line of a list item. It cannot after a heading, a
// break, a fence or a line with nothing on it.
function textual(rest: string) {
  return rest !== "" && !/^#{1,6}(?:[ \t]|$)/.test(rest) && !isBreak(rest) && fenceOpening(rest) === undefined
}

// Whether a line that is not indented enough for the list above it starts a block, and so is not a continuation of it.
// Any line that opens with a tag or a comment ends the item, as the lexer that the reference uses has it.
function interrupts(rest: string) {
  return (
    rest.startsWith(">") ||
    /^#{1,6}(?:[ \t]|$)/.test(rest) ||
    isBreak(rest) ||
    fenceOpening(rest) !== undefined ||
    /^<(?:[a-z].*>|!--)/i.test(rest)
  )
}

// Whether the lines that follow a line of a quote, and are not its own, belong to it: not when its text, once the markers
// are off, is empty, a fence or indented code.
function quoted(rest: string) {
  let at = 0
  while (rest[at] === ">") at += rest[at + 1] === " " ? 2 : 1
  const text = rest.slice(at)
  return text !== "" && !/^ {4}/.test(text) && fenceOpening(text.trimStart()) === undefined
}

// Whether a line that is not part of a quote starts a block that ends it: a heading, a break, a fence, a list item, and a
// block of HTML that starts in the first column.
function startsBlock(rest: string, indent: number) {
  return (
    /^#{1,6}(?:[ \t]|$)/.test(rest) ||
    isBreak(rest) ||
    fenceOpening(rest) !== undefined ||
    listItem(rest, indent) !== undefined ||
    (indent === 0 && (rest.startsWith("<!--") || htmlBlock(rest, 0, true) !== undefined))
  )
}
