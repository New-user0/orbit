export * as ConfigInstructionFile from "./instruction-file.js"

import { CompatInstructions } from "@orbit/compat/instructions"
import type { Entry } from "@orbit/schema/config"
import { Glob } from "@orbit/util/glob"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { Effect } from "effect"
import { basename, dirname, extname, posix, relative, win32 } from "path"
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

/** The names of a person's private variants, which have a slot of their own in each directory (`pick`). */
export function localNames(compat: boolean) {
  return CompatInstructions.localFilenames(compat)
}

/** Every name a walk looks for: the shared ones, then the local ones. */
export function walkNames(compat: boolean) {
  return [...names(compat), ...localNames(compat)]
}

/**
 * Picks the files a walk loads from what it found, in render order: directory by directory, the farthest first, and in
 * each directory the first shared name and then the first local name. The first-of rule applies to each slot, so a shared
 * file never hides the local one beside it, and a directory with only a local file loads it. `found` is in the order of a
 * walk that starts at the nearest directory and goes up. `skipShared` names the directories whose shared files another
 * checkout supplies: only their local files load.
 */
export function pick<T>(
  found: readonly T[],
  options: {
    readonly compat: boolean
    /** The path the walk built for the item, whose folder and name say which directory and slot it is in. */
    readonly file: (item: T) => string
    readonly skipShared?: (directory: string) => boolean
  },
): T[] {
  const locals = localNames(options.compat)
  const walked = [...new Set(found.map((item) => dirname(options.file(item))))]
  const directories = walked.reverse()
  return directories.flatMap((directory) => {
    const inside = found.filter((item) => dirname(options.file(item)) === directory)
    const shared = options.skipShared?.(directory)
      ? undefined
      : inside.find((item) => !locals.includes(basename(options.file(item))))
    const local = inside.find((item) => locals.includes(basename(options.file(item))))
    return [shared, local].filter((item): item is T => item !== undefined)
  })
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

/** A heading of a document: `depth` is its number of hash characters and `body` the text under it. */
export type Section = { readonly heading: string; readonly depth: number; readonly body: string }

/**
 * The ATX headings of an instruction file (`#` to `######`, then a space, a tab or the end of the line, with at most three
 * columns of indentation) and the text under each, in file order. A body runs to the next heading of the same or a
 * shallower depth, so subsections stay inside it. It has LF line endings and no blank line at either end, and may be
 * empty. Only headings at the top level of the document count: one inside fenced or indented code, an HTML block, a quote
 * or a list item opens nothing, and a `#` line inside a fence does not end a body. Underlined (Setext) headings are not
 * recognised. The function reads the text once, in linear time, and does not throw.
 */
export function sections(text: string): Section[] {
  return scan(text).map((item) => item.section)
}

/**
 * The bodies of the sections of `text` whose heading is one of `names`, in file order, without the empty ones. A name and
 * a heading are compared whole, ignoring case, runs of spaces and tabs, and one colon at the end. A section inside a
 * section that matched is part of its body and is not returned again.
 */
export function section(text: string, names: string | readonly string[]) {
  const wanted = new Set((typeof names === "string" ? [names] : names).map(normalize))
  let covered = -1
  return scan(text).flatMap((item) => {
    if (item.line < covered || !wanted.has(normalize(item.section.heading))) return []
    covered = item.end
    return item.section.body === "" ? [] : [item.section.body]
  })
}

function normalize(value: string) {
  return value
    .replaceAll(/[ \t]+/g, " ")
    .trim()
    .replace(/ ?:$/, "")
    .toLowerCase()
}

// The sections, each with the index of its heading line and of the line after its body.
function scan(text: string) {
  const lines = (text.startsWith("﻿") ? text.slice(1) : text).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const starts: number[] = []
  removeComments(lines.join("\n"), starts)
  const headings = starts.map((line) => {
    const rest = lines[line]!.replace(/^[ \t]*/, "")
    const depth = /^#+/.exec(rest)![0].length
    const after = rest.slice(depth)
    let end = after.length
    while (after[end - 1] === "#") end--
    // A closing run of hashes counts only after a space or a tab, or when it is all the text.
    const title = end === 0 || after[end - 1] === " " || after[end - 1] === "\t" ? after.slice(0, end) : after
    return { line, depth, heading: title.trim() }
  })
  // The body of a heading ends at the next one that is not deeper: the stack holds the headings still waiting for it.
  const ends = new Map<number, number>()
  const open: typeof headings = []
  for (const item of headings) {
    while (open.length > 0 && open.at(-1)!.depth >= item.depth) ends.set(open.pop()!.line, item.line)
    open.push(item)
  }
  return headings.map((item) => {
    const end = ends.get(item.line) ?? lines.length
    let from = item.line + 1
    let to = end
    while (from < to && isBlank(lines[from]!)) from++
    while (to > from && isBlank(lines[to - 1]!)) to--
    return { line: item.line, end, section: { heading: item.heading, depth: item.depth, body: lines.slice(from, to).join("\n") } }
  })
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
  const absolute = (platform === "win32" && /^[A-Z]:\//.test(pattern)) || (pattern.startsWith("/") && !pattern.startsWith("//"))
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
// block lexer splits it: it starts a line that is indented by at most three columns, outside fenced
// code, outside another HTML block, and outside the list item, quote or paragraph that it could belong to. The
// document is read once, line by line, and every kind of block that can hold a comment line without being one is
// followed just far enough to tell where it ends, so the time is linear in the size of the file, whatever it holds
// (`test/config/instruction-file.test.ts` runs hostile files under a deadline). The block lexer of a Markdown library is
// not: it is far from linear on a long list item, and a clone chooses these files before anyone has trusted it.
//
// Where that lexer reads a construct other than the CommonMark rules say, this follows the lexer:
// a comment indented under a paragraph line is more of the paragraph, and a line that opens with a tag
// ends a list item. The tests pin each of those, and name the cases that the two readings split.

type Fence = { readonly char: string; readonly length: number }

// What ends an HTML block that is open: a pattern that a line holds, or a blank line.
type End = RegExp | "blank"

// When `headings` is given the walk also records the index of every line that opens a heading at the top level of the
// document (`sections`), and it runs on text that holds no comment too.
function removeComments(text: string, headings?: number[]) {
  if (!headings && !text.includes("<!--")) return undefined
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
    const heading = /^#{1,6}(?:[ \t]|$)/.test(rest)
    if (heading || isBreak(rest) || (paragraph && /^(?:=+|-+)[ \t]*$/.test(rest))) {
      if (heading) headings?.push(at)
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
// first column: the block lexer reads the others, and an indented one, as more of the paragraph.
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
// Any line that opens with a tag or a comment ends the item, as the block lexer has it.
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

// ---------------------------------------------------------------------------------------------------------------------
// Imports
//
// A line of prose can write `@path` to pull another file into the prompt. `imports` finds the tokens and `load` follows
// them. Both treat the file as hostile input: the scan reads the document once, line by line, with no Markdown library
// (see the comment on linear time above), and `load` asks the caller's gate about every path before it reads one.

/** The most files in one chain of imports: the file itself and four levels below it. A deeper file is left out, silently. */
export const DEPTH = 5

/**
 * The import tokens that a processed instruction file holds, cleaned up and in the order they are written, each once.
 *
 * A token is an at sign that starts a run of plain text or follows whitespace, and the characters after it up to the next
 * whitespace (a backslash followed by a space is part of the name). Fenced and indented code, code spans, HTML blocks,
 * inline tags, comments and the target of a link are not text, and a backslash before the at sign keeps it literal.
 * Everything from a `#` on is dropped, a backslash and space is a space, and a token is kept only if it is a path: it
 * starts with `./`, `~/`, `/` and something more, or a letter, digit, dot, underscore or hyphen. A token with a control
 * character in it is dropped, and only that token.
 */
export function imports(content: string): string[] {
  const found = new Set<string>()
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  let segment: string[] = []
  // A fence ends with the quote or the list item that holds it, so it remembers which it was opened in.
  let fence: (Fence & { readonly indent: number; readonly quoted: boolean; readonly item: number | undefined }) | undefined
  let quoted = false
  let html: End | undefined
  // The column that a line must reach to belong to the list item above it.
  let offset: number | undefined
  let paragraph = false
  // Whether the line before in a fence was blank or opened it, which lets a line that is not indented enough end a fence
  // in a list item. Any other line of text goes on being code, as a lazy continuation of the item does.
  let loose = false

  const flush = () => {
    if (segment.length === 0) return
    for (const token of tokens(segment.join("\n"))) found.add(token)
    segment = []
  }

  // One piece of a line once its quote markers are off, and its list marker too when `depth` allows another.
  const block = (text: string, indent: number, depth: number) => {
    const relative = offset !== undefined && indent >= offset ? indent - offset : indent
    if (relative >= 4) {
      // Code, unless the paragraph above is still going, which takes the line as more of itself.
      if (paragraph) segment.push(text)
      else flush()
      return
    }
    const opening = fenceOpening(text)
    if (opening) {
      flush()
      fence = { ...opening, indent, quoted, item: offset !== undefined && indent >= offset ? offset : undefined }
      loose = true
      paragraph = false
      return
    }
    if (text.startsWith("<!--") && !(paragraph && relative > 0)) {
      flush()
      paragraph = false
      // A comment that its first line closes leaves whatever follows it on the line as text.
      if (!text.includes("-->")) {
        html = COMMENT_END
        return
      }
      const left = withoutSpans(text)
      if (left.trim() !== "") {
        segment.push(left)
        // What is left of the line is a run of its own, so a backtick or tag in it opens nothing on the next line.
        flush()
      }
      return
    }
    const end = htmlBlock(text, relative, paragraph)
    if (end !== undefined) {
      flush()
      if (end === "blank" || !end.test(text)) html = end
      paragraph = false
      return
    }
    if (/^#{1,6}(?:[ \t]|$)/.test(text)) {
      flush()
      segment.push(text.replace(/^#+/, ""))
      flush()
      paragraph = false
      return
    }
    if (isBreak(text) || (paragraph && /^(?:=+|-+)[ \t]*$/.test(text))) {
      flush()
      paragraph = false
      return
    }
    const item = listItem(text, indent)
    if (item && (!paragraph || (!item.empty && item.first))) {
      flush()
      offset = item.offset
      paragraph = false
      // The text of an item can be a list, a fence or more.
      if (depth < 8 && item.content !== "") {
        const lead = /^[ \t]*/.exec(item.content)![0]
        block(item.content.slice(lead.length), item.offset + width(lead, 0), depth + 1)
      }
      return
    }
    segment.push(text)
    paragraph = true
  }

  for (const line of lines) {
    const unquoted = withoutQuote(line)
    quoted = unquoted !== line
    if (fence) {
      // Quote markers belong to the line only when the fence was opened inside a quote.
      const inner = fence.quoted ? unquoted : line
      const trimmed = inner.replace(/^[ \t]*/, "")
      const margin = inner.length - trimmed.length
      // A line outside the quote ends the fence that one holds. One not indented enough for the item ends it only after
      // a blank line or the opener, or when it starts a block of its own; any other text is a lazy line of the code.
      if (
        (fence.quoted && !quoted) ||
        (fence.item !== undefined &&
          trimmed !== "" &&
          width(inner.slice(0, margin), 0) < fence.item &&
          (loose || startsBlock(trimmed, margin)))
      )
        fence = undefined
      else {
        if (margin < fence.indent + 4 && closes(fence, trimmed)) fence = undefined
        loose = trimmed === ""
        continue
      }
    }
    if (html) {
      if (html === "blank" ? !isBlank(line) : !html.test(line)) continue
      // The line that ends a comment block goes on as text after the marker that closes it.
      if (html === COMMENT_END && line.includes("-->")) {
        const left = line.slice(line.indexOf("-->") + 3)
        if (left.trim() !== "") {
          segment.push(left.trimStart())
          flush()
        }
      }
      html = undefined
      continue
    }
    if (isBlank(line)) {
      flush()
      paragraph = false
      continue
    }
    const lead = /^[ \t]*/.exec(unquoted)![0]
    const text = unquoted.slice(lead.length)
    const indent = width(lead, 0)
    // A line that is not indented enough ends the list, unless it goes on with the paragraph in the item.
    if (offset !== undefined && indent < offset && (!paragraph || interrupts(text)) && !(listItem(text, indent) && !isBreak(text))) offset = undefined
    block(text, indent, 0)
  }
  flush()
  return [...found]
}

// The line without its quote markers: up to three columns of space, then any number of `>` each with the space after it.
function withoutQuote(line: string) {
  let at = 0
  let columns = 0
  while (at < line.length && (line[at] === " " || line[at] === "\t") && columns < 4)
    columns += line[at++] === "\t" ? 4 - (columns % 4) : 1
  if (columns >= 4 || line[at] !== ">") return line
  while (line[at] === ">") at += line[at + 1] === " " ? 2 : 1
  return line.slice(at)
}

const TAG = /<\/?[A-Za-z][^<>]*>/y

// What ends a comment block, as against any other HTML block: the rest of its closing line is text.
const COMMENT_END = /-->/

// The tokens of a run of text lines, from one pass over the characters. Code spans are paired from the list of backtick
// runs, one list for each width, so that a text full of unclosed runs costs no more than a text with none.
function tokens(text: string): string[] {
  const runs = new Map<number, number[]>()
  for (const match of text.matchAll(/`+/g)) {
    const list = runs.get(match[0].length)
    if (list) list.push(match.index!)
    else runs.set(match[0].length, [match.index!])
  }
  const cursor = new Map<number, number>()
  const found: string[] = []
  let noBracket = false
  let noParen = false
  let start = true
  let at = 0
  while (at < text.length) {
    const char = text[at]!
    if (char === "\\") {
      const next = text[at + 1]
      // A backslash before a line break is a hard break, which starts a new run of text.
      if (next === "\n") {
        at += 2
        start = true
        continue
      }
      // Only ASCII punctuation is escaped, and an escaped character never starts anything, an at sign included. A
      // backslash before anything else is a character of its own.
      const punctuation = next !== undefined && /[!-/:-@[-`{-~]/.test(next)
      at += punctuation ? 2 : 1
      // The escaped character is text on its own, so what follows it starts a new run unless it was the at sign.
      start = punctuation && next !== "@"
      continue
    }
    if (char === "`") {
      let end = at
      while (text[end] === "`") end++
      const size = end - at
      const list = runs.get(size) ?? []
      let index = cursor.get(size) ?? 0
      while (index < list.length && list[index]! < end) index++
      cursor.set(size, index)
      // A run closes only on a run of the same width, and an unclosed one is text.
      at = index < list.length ? list[index]! + size : end
      start = index < list.length
      continue
    }
    if (char === "<") {
      if (text.startsWith("<!--", at)) {
        const close = text.indexOf("-->", at + 4)
        at = close === -1 ? text.length : close + 3
        start = true
        continue
      }
      TAG.lastIndex = at
      const tag = TAG.exec(text)
      if (tag) {
        at += tag[0].length
        start = true
        continue
      }
    }
    if (char === "!" && text[at + 1] === "[" && !noBracket) {
      // The alt text of an image is not read.
      const close = text.indexOf("]", at + 2)
      if (close === -1) noBracket = true
      else {
        at = close
        continue
      }
    }
    if (char === "]") {
      at++
      if (text[at] === "(" && !noParen) {
        const close = text.indexOf(")", at)
        if (close === -1) noParen = true
        else at = close + 1
      }
      start = false
      continue
    }
    if (char === "@" && start) {
      let end = at + 1
      while (end < text.length) {
        const next = text[end]!
        if (next === "\\" && text[end + 1] === " ") end += 2
        else if (/[\s\\*`<\]]/.test(next)) break
        else end++
      }
      if (end > at + 1) {
        // Underscores that close an emphasis that opened just before the at sign are not part of the name.
        const raw = text.slice(at + 1, end)
        const token = clean(text[at - 1] === "_" ? raw.replace(/_+$/, "") : raw)
        if (token !== undefined) found.push(token)
      }
      at = end
      start = false
      continue
    }
    // Whitespace, the opening bracket of a link and emphasis markers start a new run of text.
    start = /\s/.test(char) || char === "[" || ((char === "*" || char === "_") && (start || /\s/.test(text[at - 1] ?? " ")))
    at++
  }
  return found
}

// A token as a path, or `undefined` when it is not one.
function clean(raw: string) {
  const hash = raw.indexOf("#")
  const token = (hash === -1 ? raw : raw.slice(0, hash)).replaceAll("\\ ", " ")
  if (token === "" || /[\u0000-\u001f\u007f]/.test(token)) return undefined
  return /^(?:\.\/|~\/|\/.|[A-Za-z0-9._-])/.test(token) ? token : undefined
}

// Extensions that stand for text. The decision is made on the name as it is written and never on the contents, and a name
// with no extension counts: `LICENSE`, `Makefile`, and a dotfile such as `.env`, whose extension Node reports as empty.
const TEXT = new Set(
  (
    ".md .mdx .markdown .txt .text .rst .adoc .asciidoc .org .tex .rtf .log .diff .patch .json .jsonc .json5 .jsonl .ndjson " +
    ".yaml .yml .toml .ini .cfg .conf .config .properties .env .xml .csv .tsv .html .htm .xhtml .css .scss .sass .less .svg " +
    ".js .mjs .cjs .jsx .ts .mts .cts .tsx .vue .svelte .astro .py .pyi .rb .php .java .kt .kts .scala .groovy .gradle .go " +
    ".rs .c .h .cc .cpp .cxx .hpp .hh .m .mm .cs .fs .vb .swift .dart .lua .pl .pm .r .jl .ex .exs .erl .hs .clj .cljs " +
    ".elm .ml .mli .nim .zig .sh .bash .zsh .fish .ps1 .psm1 .bat .cmd .sql .graphql .gql .proto .thrift .tf .tfvars .hcl " +
    ".nix .cmake .mk .make .dockerfile .ejs .hbs .pug .njk .liquid .j2 .jinja .tmpl .lock .sum .mod"
  ).split(" "),
)

/** A file that an instruction file imported, or the file itself when `importedBy` is not set. `path` is the real path. */
export type Loaded = {
  readonly path: string
  readonly content: string
  readonly importedBy?: string
  /** Set only for a file loaded as a rule (`rules`) whose own front matter has patterns: it waits for a matching read. */
  readonly patterns?: readonly string[]
}

/**
 * An import that a project file made and that was left out because it leads outside the project and the folder that holds
 * the importing file is not trusted to reach out. `directory` is the folder whose trust would lift it, when a grant made
 * from this session could.
 */
export type Skipped = { readonly importer: string; readonly target: string; readonly directory?: string }

type LoadInput = {
  /** The file itself, as a real path. */
  readonly path: string
  /** Where the file comes from: a user-level file may import anything that is not a network path, a project file only what `allow` accepts. */
  readonly scope: "user" | "project"
  /** The files this pass has handled. Share one set across every file of a pass, and pass a new one to start another. */
  readonly visited: Set<string>
  readonly patterns: readonly string[]
  readonly home: string
  readonly fs: Pick<FSUtil.Interface, "isFile" | "readFileStringSafe">
  /** Where a path really leads, a link to a network share named as the share without being opened (`ProjectTrust.leads`). */
  readonly leads: (spelling: string) => Effect.Effect<string>
  /** Whether a project file may import this file (project scope only): its real path and the way it was spelled. */
  readonly allow: (real: string, spelling: string) => Effect.Effect<boolean>
  /**
   * Asked only after `allow` refused: whether the folder that holds the importing file (a real path) lets it import from
   * outside, and the folder to trust to make it so. Its answer is kept for one pass and never longer, so that a grant is
   * seen by the next one. Without it a refused import stays refused.
   */
  readonly outward?: (importer: string) => Effect.Effect<{ readonly open: boolean; readonly directory?: string }>
  /** Asked before an import is read, to leave out one that something else already has. */
  readonly claim?: (real: string) => Effect.Effect<boolean>
  readonly platform?: NodeJS.Platform
  /** The file is a rule: every file loaded carries the patterns of its own front matter (`rulePatterns`). */
  readonly rules?: boolean
  /** False loads the file alone, without following its imports. */
  readonly imports?: boolean
}

/**
 * The file and what it imports, depth first: the file, its first import, that import's imports, its second import. A
 * file is handled once in a pass, whatever way it was reached, and a chain is `DEPTH` files long. A target that is not
 * there, is a folder, is not text, is excluded or cannot be read is skipped with a line in the log, and costs only
 * itself. A file with nothing left once it is processed adds nothing, and its imports are not followed.
 *
 * Before an import is statted, resolved or read, a network path is refused, then the path is followed to where it really
 * leads and that real path is what `allow` is asked about and what is read. The result is `undefined` when the file
 * itself cannot be read; `read` lists every import that was read, for the caller to watch.
 */
export const load = Effect.fn("ConfigInstructionFile.load")(function* (input: LoadInput) {
  const platform = input.platform ?? process.platform
  const files: Loaded[] = []
  const skipped: Skipped[] = []
  const read: string[] = []
  const outward = new Map<string, { readonly open: boolean; readonly directory?: string }>()
  const key = (value: string) =>
    platform === "win32" ? win32.normalize(value).replaceAll("/", "\\").toLowerCase() : posix.normalize(value)

  // False only when the file at depth 0 cannot be read.
  const handle = (spelling: string, importer: string | undefined, depth: number): Effect.Effect<boolean, FSUtil.Error> =>
    Effect.gen(function* () {
      if (depth >= DEPTH) return true
      if (importer === undefined && input.visited.has(key(input.path))) return true
      if (importer !== undefined) {
        if (/^[\\/]{2}/.test(spelling) || input.visited.has(key(spelling))) return true
        if (excluded(input.patterns, [spelling])) {
          yield* Effect.logDebug("instruction import excluded", { path: spelling })
          return true
        }
      }
      // Windows does not tell drive letters apart, and the file system may hand either back.
      const led = importer === undefined ? input.path : yield* input.leads(spelling)
      const real = platform === "win32" ? led.replace(/^[a-z]:/, (drive) => drive.toUpperCase()) : led
      if (importer !== undefined) {
        if (/^[\\/]{2}/.test(real) || LinkShare.isUnresolved(real)) {
          yield* Effect.logDebug("instruction import refused", { path: spelling, reason: "a network path, or links with no end" })
          return true
        }
        if (input.visited.has(key(real))) return true
        if (excluded(input.patterns, [real])) {
          yield* Effect.logDebug("instruction import excluded", { path: spelling })
          return true
        }
        // Not there, or not a file (a folder, a pipe, a device): skipped without a word, as prose such as `@team` is common.
        if (!(yield* input.fs.isFile(real))) return true
        if (input.scope === "project" && !(yield* input.allow(real, spelling))) {
          // The holder of the importing file decides, not the file that was imported: a chain does not inherit.
          const known = outward.get(importer) ?? (input.outward ? yield* input.outward(importer) : { open: false })
          outward.set(importer, known)
          if (!known.open) {
            // One warning for each importer and target, however many ways the importer spells it.
            if (!skipped.some((item) => item.importer === importer && key(item.target) === key(real)))
              skipped.push(
                known.directory === undefined ? { importer, target: real } : { importer, target: real, directory: known.directory },
              )
            return true
          }
        }
        if (!isText(spelling)) {
          yield* Effect.logDebug("instruction import skipped", { path: spelling, reason: "not a text file" })
          return true
        }
        if (input.claim && !(yield* input.claim(real))) return true
        input.visited.add(key(spelling))
      }
      input.visited.add(key(real))
      const text =
        importer === undefined
          ? yield* input.fs.readFileStringSafe(real)
          : yield* input.fs.readFileStringSafe(real).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) {
        if (importer === undefined) return false
        yield* Effect.logDebug("instruction import skipped", { path: spelling, reason: "unreadable" })
        return true
      }
      if (importer !== undefined) {
        if (text.includes("\u0000")) {
          yield* Effect.logDebug("instruction import skipped", { path: spelling, reason: "holds a NUL character" })
          return true
        }
        read.push(real)
      }
      const processed = parse(text, { frontmatter: true })
      if (processed.content.trim() === "") {
        yield* Effect.logDebug("instruction file left out", { path: real, reason: "nothing left once processed" })
        return true
      }
      // A rule file is classified by its own front matter, an imported file by its own too and not by its importer's.
      const rule = input.rules ? rulePatterns(ConfigMarkdown.split(text).frontmatter) : undefined
      if (rule?.malformed)
        yield* Effect.logDebug("rule front matter not read, so the rule applies from the start", { path: real })
      if (rule !== undefined && rule.dropped > 0)
        yield* Effect.logDebug("rule patterns left out", { path: real, dropped: rule.dropped })
      files.push({
        path: real,
        content: processed.content,
        ...(importer === undefined ? {} : { importedBy: importer }),
        ...(rule?.patterns === undefined ? {} : { patterns: rule.patterns }),
      })
      if (input.imports === false) return true
      for (const token of imports(processed.content)) {
        const target = resolveToken(token, dirname(real), input.home, platform)
        if (target !== undefined) yield* handle(target, real, depth + 1)
      }
      return true
    })

  if (!(yield* handle(input.path, undefined, 0))) return undefined
  return { files, skipped, read }
})

// Whether a name stands for a text file: an extension from the list, or none at all.
function isText(name: string) {
  const extension = extname(name).toLowerCase()
  return extension === "" || TEXT.has(extension)
}

// The place a token names: `~/` is the home folder, a Git Bash drive spelling is the drive on Windows, an absolute path is
// itself and anything else is next to the file that wrote it. `undefined` for a network path, which is never resolved.
function resolveToken(token: string, folder: string, home: string, platform: NodeJS.Platform) {
  const spelled = FSUtil.windowsPath(token, platform)
  if (/^[\\/]{2}/.test(spelled)) return undefined
  const flavor = platform === "win32" ? win32 : posix
  return (spelled.startsWith("~/") ? flavor.join(home, spelled.slice(2)) : flavor.resolve(folder, spelled)).normalize("NFC")
}

// ---------------------------------------------------------------------------------------------------------------------
// Rule files
//
// A file in a `rules` folder may name, in a `paths` key of its front matter, the files it is about. Without the key it is
// read like any instruction file, at the start of the session. With it, it waits for the model to read a file that
// matches. The key only chooses when text the folder already supplies is shown: a pattern never names a file to read.

/** The most patterns one rule keeps, after its braces are expanded. A file cannot make Orbit build a longer list. */
export const RULE_PATTERNS = 256

/** The longest pattern a rule keeps, in characters. A longer one is dropped. */
const RULE_PATTERN_LENGTH = 1024

/** Whether a name in a rules folder is a rule file. The test is on the name as it is written, in lower case on every platform. */
export function isRuleName(name: string) {
  return name.endsWith(".md")
}

/**
 * The patterns of the `paths` key in the front matter block that `ConfigMarkdown.split` found, or `undefined` when the
 * rule has none and so applies from the start: no front matter, no key, a key that is not a string or a list of strings,
 * nothing left once the patterns are cleaned up, or only patterns that match everything. Braces are expanded
 * (`src/*.{ts,tsx}` is two patterns) because the matcher has none, and a trailing `/**` goes because a folder pattern already
 * covers what is below it. The block is parsed by `ConfigMarkdown.parseOption` and nothing else, so no front matter language
 * is evaluated. `malformed` is set when the block does not parse, which also makes the rule apply from the start: the text is
 * the folder's own, and the only thing lost is the condition.
 */
export function rulePatterns(frontmatter: string | undefined): {
  readonly patterns: readonly string[] | undefined
  readonly malformed: boolean
  /** How many patterns were left out for a cap or because the matcher does not take them. */
  readonly dropped: number
} {
  if (frontmatter === undefined) return { patterns: undefined, malformed: false, dropped: 0 }
  // The block is read with plain delimiters, whatever spaces followed the dashes on the file's own lines.
  const lines = frontmatter.replaceAll("\r\n", "\n").split("\n")
  const end = lines.findLastIndex((line) => /^---[ \t]*$/.test(line))
  const parsed = ConfigMarkdown.parseOption(`---\n${lines.slice(1, end).join("\n")}\n---\n`, true)
  if (parsed === undefined) return { patterns: undefined, malformed: true, dropped: 0 }
  const value: unknown = parsed.data["paths"]
  const strings =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : []
  // Parts are taken one at a time and the work stops once the cap is kept, so what a file spells out past it costs nothing.
  const patterns: string[] = []
  let dropped = 0
  for (const text of strings) {
    for (const part of splitCommas(text)) {
      if (patterns.length >= RULE_PATTERNS) {
        dropped++
        break
      }
      // A part this long is dropped before its braces are expanded: each group is a level of recursion.
      if (part.length > RULE_PATTERN_LENGTH) {
        dropped++
        continue
      }
      for (const spelling of expandBraces(part)) {
        const pattern = spelling.replace(/\/\*\*$/, "").trim()
        if (pattern === "") continue
        if (pattern.length > RULE_PATTERN_LENGTH || compileRulePattern(pattern) === undefined) dropped++
        else patterns.push(pattern)
        if (patterns.length >= RULE_PATTERNS) break
      }
    }
    if (patterns.length >= RULE_PATTERNS) break
  }
  // A rule whose patterns were all dropped still waits, and matches nothing.
  if (patterns.length === 0 && dropped > 0) return { patterns, malformed: false, dropped }
  if (patterns.every((pattern) => pattern === "**")) return { patterns: undefined, malformed: false, dropped }
  return { patterns, malformed: false, dropped }
}

// The parts of a string between the commas that are outside braces, trimmed, without the empty ones. A closing brace with
// no opener takes the depth below zero, and then no later comma splits.
function* splitCommas(value: string) {
  let depth = 0
  let from = 0
  for (let at = 0; at <= value.length; at++) {
    const char = value[at]
    if (at < value.length && char === "{") depth++
    else if (at < value.length && char === "}") depth--
    else if (at === value.length || (char === "," && depth === 0)) {
      const part = value.slice(from, at).trim()
      from = at + 1
      if (part !== "") yield part
    }
  }
}

// Every spelling of a pattern once its first brace group is replaced by each alternative, then the next, depth first. A
// group with no closing brace is left as written. The list stops growing at `RULE_PATTERNS`.
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{")
  if (open === -1) return [pattern]
  let depth = 0
  let close = -1
  const commas: number[] = []
  for (let at = open; at < pattern.length && close === -1; at++) {
    const char = pattern[at]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) close = at
    } else if (char === "," && depth === 1) commas.push(at)
  }
  if (close === -1) return [pattern]
  const edges = [open, ...commas, close]
  const alternatives = edges.slice(0, -1).map((edge, index) => pattern.slice(edge + 1, edges[index + 1]).trim())
  const result: string[] = []
  for (const alternative of alternatives) {
    for (const spelling of expandBraces(pattern.slice(0, open) + alternative + pattern.slice(close + 1))) {
      result.push(spelling)
      if (result.length >= RULE_PATTERNS) return result
    }
  }
  return result
}

/**
 * Whether a rule applies to a file. Both paths are real, which is the one way `FSUtil.contains` may decide containment:
 * a file outside the base, or the base itself, matches nothing. What is left is the path from the base, written with
 * forward slashes, which the patterns meet under the rules of a `.gitignore`: a pattern with no slash other than a trailing
 * one matches a name at any depth, one with a slash is anchored to the base, a trailing slash matches folders only, a folder
 * that matches covers what is below it, wildcards match names that start with a dot, patterns are read in order and the last
 * match wins, `!` takes a match back unless a folder above it matched, and case is ignored. Bun's glob matcher does the
 * matching and does not backtrack, so a read takes time that grows with the path and the patterns and no faster.
 */
export function ruleMatches(patterns: readonly string[], base: string, target: string) {
  const from = relative(base, target)
  if (from === "" || !FSUtil.contains(base, target)) return false
  const real = from.replaceAll("\\", "/").toLowerCase()
  // A path this long or this deep matches nothing, so the work of a read has a bound whatever a repository names.
  const segments = real.split("/")
  if (real.length > RULE_PATH_LENGTH || segments.length > RULE_PATH_DEPTH) return false
  const compiled = patterns.flatMap((pattern) => compileRulePattern(pattern) ?? [])
  if (compiled.length === 0) return false
  // A folder above the file that a positive pattern leaves matched covers the file, whatever a `!` below says.
  for (let end = 1; end < segments.length; end++) {
    if (matchedAt(compiled, segments.slice(0, end).join("/"), true)) return true
  }
  return matchedAt(compiled, real, false)
}

const RULE_PATH_LENGTH = 1_024
const RULE_PATH_DEPTH = 32

type CompiledRulePattern = { readonly glob: Bun.Glob; readonly negated: boolean; readonly folderOnly: boolean }

// The last pattern that matches decides, and a `!` pattern decides "not matched".
function matchedAt(compiled: readonly CompiledRulePattern[], at: string, folder: boolean) {
  return compiled.reduce(
    (matched, pattern) => ((pattern.folderOnly && !folder) || !pattern.glob.match(at) ? matched : !pattern.negated),
    false,
  )
}

/**
 * A pattern as a glob from the base, or `undefined` when nothing is left of it or Bun's matcher refuses it. A repository
 * writes the pattern, so a refusal costs that pattern alone. `rulePatterns` uses it to count what it drops.
 */
export function compileRulePattern(pattern: string): CompiledRulePattern | undefined {
  if (compiledPatterns.has(pattern)) return compiledPatterns.get(pattern)
  const compiled = compile(pattern)
  // Every read matches the same patterns again, so each is compiled once. The table is cleared when it fills, which bounds
  // what a repository with many patterns can hold.
  if (compiledPatterns.size >= COMPILED_PATTERNS) compiledPatterns.clear()
  compiledPatterns.set(pattern, compiled)
  return compiled
}

const COMPILED_PATTERNS = 4_096
const compiledPatterns = new Map<string, CompiledRulePattern | undefined>()

function compile(pattern: string): CompiledRulePattern | undefined {
  const negated = pattern.startsWith("!")
  const body = (negated ? pattern.slice(1) : pattern).toLowerCase()
  const name = body.replace(/\/+$/, "")
  const rest = name.startsWith("/") ? name.slice(1) : name
  if (rest === "") return undefined
  try {
    return { glob: new Bun.Glob(name.includes("/") ? rest : `**/${rest}`), negated, folderOnly: body.endsWith("/") }
  } catch {
    return undefined
  }
}

