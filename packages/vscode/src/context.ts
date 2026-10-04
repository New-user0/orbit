// Prompts built from editor state. Paths are workspace-relative so the agent resolves them in its own directory.

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

function fence(language: string, text: string) {
  // A longer fence than any run of backticks in the code keeps it intact.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const marker = "`".repeat(longest + 1)
  return `${marker}${language}\n${text.replace(/\n$/, "")}\n${marker}`
}
