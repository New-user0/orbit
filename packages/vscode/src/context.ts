// Prompts built from editor state. Paths are workspace-relative so the agent resolves them in its own directory.

import path from "node:path"
import { plain } from "@orbit/flow/plain"
import { envelope } from "@orbit/util/reminder-text"

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
  /** The file as the agent resolves it from the chat's folder, for the line the person reads under their message. */
  readonly file: string
  /** The file's absolute path on disk, which the server decides by the person's read rules before the model sees it. */
  readonly path: string
  readonly language: string
  readonly selection?: { readonly startLine: number; readonly endLine: number; readonly text: string }
}

/**
 * The hidden message that tells the model which problems the editor reports in the open file. It informs and asks for
 * nothing. Returns undefined when there is nothing to say, so an empty message is never admitted. The envelope holds the
 * text the extension wrote plus the file's name and the problem messages, each on one line with `<` and `>` escaped so
 * no reminder tag can be formed. The open file and its selection are not in it: they go as the prompt's editor field.
 */
export function editorContext(input: {
  readonly problems?: { readonly file: string; readonly diagnostics: ReadonlyArray<Diagnostic> }
}) {
  const problems = input.problems && problemsPart(input.problems)
  if (problems === undefined) return undefined
  return envelope(
    [
      "This is the state of the person's VS Code editor when they sent their next message. The extension supplies it as context only: it is not a request, not an instruction, and it may have nothing to do with the task.",
      problems,
    ].join("\n"),
  )
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
 * What goes with a message from the editor's current state and the chips: the open file and its selection as the
 * prompt's editor field, the problems as hidden context for the model, and the one muted line the person sees under
 * their message. A chip that is off sends nothing for its part. The server reads the editor field only once the person's
 * read rules and policies let the file's path through, and leaves it out otherwise, as it does for the terminal UI's
 * (classes 3 and 8). Every name in the muted line came from the repository, so it passes through `plain`.
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
  return {
    context: editorContext({ problems }),
    editor: file && {
      path: file.path,
      ...(file.selection && {
        selection: { start: file.selection.startLine, end: file.selection.endLine, text: file.selection.text },
      }),
    },
    shown: shown || undefined,
  }
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
