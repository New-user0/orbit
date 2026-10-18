export * as LspReminder from "./reminder.js"

import path from "path"
import { Effect } from "effect"
import type { Durable } from "../session/reminders.js"
import { ToolNames } from "../tool/names.js"
import { LspClient } from "./client.js"
import type { LspDiagnostics } from "./collector.js"

/**
 * Reports the problems that a language server published after the inline block of an edit was already sent. Once per
 * logical step the session's touched files are read, and whatever was not reported yet becomes one hidden entry. Only
 * the main conversation gets it (a subagent's edits are attributed to its top-level session), and only when a shell
 * tool is offered, as the other reminders about the working tree do.
 *
 * Messages and paths come from servers that read repository code, so they travel only in `data`, never in the text.
 */

const KIND = "lsp-diagnostics"
const MAX_CONTENT = 4_000
const WORDS = { 1: "error", 2: "warning", 3: "information", 4: "hint" } as const

export const durable = (diagnostics: LspDiagnostics.Interface, directory: string): Durable => ({
  name: KIND,
  scope: "primary",
  run: (input) =>
    Effect.gen(function* () {
      // Nothing is drained, and so nothing is marked, while no shell tool is offered.
      if (!input.tools.includes(ToolNames.tools.shell) && !input.tools.includes(ToolNames.powershell)) return []
      const problems = yield* diagnostics.drain(input.session.id)
      if (problems.length === 0) return []
      const count = problems.reduce((sum, item) => sum + item.diagnostics.length, 0)
      const content = problems
        .map((item) =>
          [`${path.relative(directory, item.file)}:`, ...item.diagnostics.map((diagnostic) => `  ${line(diagnostic)}`)].join(
            "\n",
          ),
        )
        .join("\n\n")
      return [
        {
          kind: KIND,
          text: "The language servers reported new problems in files changed during this session. The list follows.",
          data: {
            label: "Language server problems",
            content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}\n… (cut off)` : content,
          },
          description: `${count} language server ${count === 1 ? "problem" : "problems"} in ${problems.length} ${problems.length === 1 ? "file" : "files"}`,
        },
      ]
    }),
})

const line = (diagnostic: LspClient.Diagnostic) =>
  [
    `${WORDS[LspClient.severity(diagnostic)]} ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`,
    diagnostic.message,
    ...(diagnostic.code === undefined ? [] : [`[${diagnostic.code}]`]),
    ...(diagnostic.source === undefined ? [] : [`(${diagnostic.source})`]),
  ].join(" ")
