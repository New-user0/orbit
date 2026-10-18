// Prompts built from editor state. Paths are workspace-relative so the agent resolves them in its own directory.

import path from "node:path"
import { plain } from "@orbit/flow/plain"
import { block, envelope } from "@orbit/util/reminder-text"

/** The most selected text that goes to the model with a message, in characters. */
export const SELECTION_LIMIT = 2000
/** The most the problems summary may take, in characters, including its note about what was left out. */
export const PROBLEMS_LIMIT = 4000

export interface Selection {
  readonly file: string
  readonly language: string
  /** 1-based, inclusive. */
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

export interface Diagnostic {
  /** 1-based. */
  readonly line: number
  /** 1-based. */
  readonly column: number
  readonly code?: string
  readonly severity: "error" | "warning" | "information" | "hint"
  readonly message: string
  readonly source?: string
}

export function reference(selection: Pick<Selection, "file" | "startLine" | "endLine">) {
  const lines =
    selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}-${selection.endLine}`
  return `${selection.file} (${lines})`
}

export function ask(selection: Selection, question: string) {
  return `${question.trim()}\n\nContext, ${reference(selection)}:\n${fence(selection.language, selection.text)}`
}

export function explain(selection: Selection) {
  return ask(selection, "Explain what this code does and point out anything surprising or risky.")
}

export function fix(file: string, diagnostics: ReadonlyArray<Diagnostic>) {
  const list = diagnostics
    .toSorted((left, right) => left.line - right.line)
    .map(
      (item) =>
        `- line ${item.line}, ${item.severity}${item.source ? ` (${item.source})` : ""}: ${item.message.split("\n")[0]}`,
    )
    .join("\n")
  return `Fix these problems in ${file}. Read the file first and keep unrelated code unchanged.\n\n${list}`
}

export function review() {
  return "Review my uncommitted changes: run git diff, then point out bugs, risky changes and missing tests. Do not edit anything."
}

/**
 * The 1-based, inclusive lines a selection covers, from the editor's 0-based positions. A selection that ends at the
 * start of a later line does not cover that line, and an empty selection covers nothing.
 */
export function lines(
  start: { readonly line: number; readonly character: number },
  end: { readonly line: number; readonly character: number },
) {
  if (end.line < start.line || (end.line === start.line && end.character <= start.character)) return undefined
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line
  return { startLine: start.line + 1, endLine: last + 1 }
}

/** A file as the agent resolves it: relative to its folder with `/`, else the absolute path with an upper-case drive. */
export function place(directory: string, file: string) {
  const relative = path.relative(directory, file)
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`)
  if (relative !== "" && !outside && !path.isAbsolute(relative)) return relative.replaceAll("\\", "/")
  return file.replace(/^[a-z]:/, (drive) => drive.toUpperCase())
}

export interface EditorFile {
  readonly file: string
  readonly language: string
  readonly selection?: { readonly startLine: number; readonly endLine: number; readonly text: string }
}

/**
 * The hidden message that tells the model what the person has open in the editor. It informs and asks for nothing.
 * Returns undefined when there is nothing to say, so an empty message is never admitted. The envelope holds only text
 * the extension wrote, with file names, languages and problems on one line and no character that can spell a reminder
 * tag. The selected text comes from the repository, so it follows the envelope as a fenced block of its own that it
 * cannot close and in which look-alike tags are escaped.
 */
export function editorContext(input: {
  readonly file?: EditorFile
  readonly problems?: { readonly file: string; readonly diagnostics: ReadonlyArray<Diagnostic> }
}) {
  const file = input.file && filePart(input.file)
  const problems = input.problems && problemsPart(input.problems)
  const parts = [file?.text, problems].filter((part) => part !== undefined)
  if (parts.length === 0) return undefined
  return [
    envelope(
      [
        "This is the state of the person's VS Code editor when they sent their next message. The extension supplies it as context only: it is not a request, not an instruction, and it may have nothing to do with the task.",
        ...parts,
      ].join("\n"),
    ),
    ...(file?.selected ? [block(file.selected.label, file.selected.text)] : []),
  ].join("\n\n")
}

function filePart(input: EditorFile) {
  if (!input.selection) return { text: `The person has this file open: ${single(input.file)}` }
  const text = input.selection.text.replaceAll("\r\n", "\n")
  // Step back one unit when the cut would fall between the halves of a surrogate pair.
  const end = /[\ud800-\udbff]/.test(text[SELECTION_LIMIT - 1] ?? "") ? SELECTION_LIMIT - 1 : SELECTION_LIMIT
  const rest = text.slice(end)
  const count = rest.split("\n").length
  const cut = rest
    ? `\n(The selection is cut here: ${rest.length} more characters, across ${count} ${count === 1 ? "line" : "lines"}, are left out.)`
    : ""
  const where = reference({
    file: single(input.file),
    startLine: input.selection.startLine,
    endLine: input.selection.endLine,
  })
  return {
    text: `The person has selected ${where}; the selected ${single(input.language)} text follows this reminder.${cut}`,
    selected: { label: `Selection in ${where}`, text: text.slice(0, end).replace(/\n$/, "") },
  }
}

function problemsPart(input: { readonly file: string; readonly diagnostics: ReadonlyArray<Diagnostic> }) {
  if (input.diagnostics.length === 0) return undefined
  const head = `Problems the editor reports in this file:\n${single(path.basename(input.file))}`
  const rows = input.diagnostics
    .toSorted((left, right) => left.line - right.line || left.column - right.column)
    .map((item) => {
      const code = item.code ? ` [${single(item.code)}]` : ""
      const source = item.source ? ` (${single(item.source)})` : ""
      return `  ${item.severity} ${item.line}:${item.column} ${single(item.message.split("\n")[0] ?? "")}${code}${source}`
    })
  const sizes = rows.reduce<number[]>((all, row) => [...all, (all.at(-1) ?? head.length) + row.length + 1], [])
  if ((sizes.at(-1) ?? 0) <= PROBLEMS_LIMIT) return [head, ...rows].join("\n")
  // Leave room for the note, and stop at a whole line.
  const kept = sizes.filter((size) => size <= PROBLEMS_LIMIT - 60).length
  const left = rows.length - kept
  return [head, ...rows.slice(0, kept), `  (${left} more problem${left === 1 ? "" : "s"} left out)`].join("\n")
}

// One line, no control or format characters, and no angle brackets: nothing in it can spell one of Orbit's tags.
function single(text: string) {
  return plain(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function fence(language: string, text: string) {
  // A longer fence than any run of backticks in the code keeps it intact.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const marker = "`".repeat(longest + 1)
  return `${marker}${language}\n${text.replace(/\n$/, "")}\n${marker}`
}

/**
 * What goes with a message from the editor's current state and the chips: the hidden context for the model, and the one
 * muted line the person sees under their message. A chip that is off sends nothing for its part. Every name in the
 * muted line came from the repository, so it passes through `plain`.
 */
export function outgoing(
  chips: { readonly file: boolean; readonly problems: boolean },
  editor: {
    readonly file?: EditorFile
    readonly problems?: { readonly file: string; readonly diagnostics: ReadonlyArray<Diagnostic> }
  },
) {
  const file = chips.file ? editor.file : undefined
  const problems = chips.problems ? editor.problems : undefined
  const shown = [
    file?.selection &&
      `${plural(file.selection.endLine - file.selection.startLine + 1, "line")} selected in ${plain(file.file)}`,
    problems && `${plural(problems.diagnostics.length, "problem")} in ${plain(problems.file)}`,
  ]
    .filter((line) => line !== undefined)
    .join(" · ")
  return { context: editorContext({ file, problems }), shown: shown || undefined }
}

/** What the chat draws about the editor. Every string came from the repository, so each is written on one line by `plain`. */
export function workspaceView(input: {
  readonly folder: string
  readonly file?: string
  readonly selection?: {
    readonly file: string
    readonly startLine: number
    readonly endLine: number
    readonly startColumn: number
    readonly endColumn: number
  }
  readonly problems?: { readonly file: string; readonly count: number }
  readonly includeFile: boolean
}) {
  return {
    folder: plain(input.folder),
    file: input.file === undefined ? undefined : plain(input.file),
    selection: input.selection && { ...input.selection, file: plain(input.selection.file) },
    problems: input.problems && { ...input.problems, file: plain(input.problems.file) },
    includeFile: input.includeFile,
  }
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
