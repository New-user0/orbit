export * as LspTool from "./lsp.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { Effect, Schema } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Lsp } from "../../lsp/index.js"
import { PositiveInt } from "../../schema.js"

export const name = "lsp"

export const Input = Schema.Struct({
  action: Schema.Literals(["definition", "references", "hover", "symbols", "diagnostics"]).annotate({
    description:
      '"definition" and "references" find where the symbol at a position is defined or used, "hover" shows its type and docs, "symbols" lists the file\'s symbols, and "diagnostics" lists its errors and warnings.',
  }),
  path: Schema.String.annotate({ description: "File to ask about" }),
  line: Schema.optionalKey(PositiveInt).annotate({ description: "1-based line of the symbol, for position actions" }),
  character: Schema.optionalKey(PositiveInt).annotate({
    description: "1-based column of the symbol, for position actions",
  }),
})

const METHODS = {
  definition: "textDocument/definition",
  references: "textDocument/references",
  hover: "textDocument/hover",
  symbols: "textDocument/documentSymbol",
} as const

export const Plugin = {
  id: "orbit.tool.lsp",
  effect: Effect.fn("LspTool.Plugin")(function* (ctx: Context) {
    const access = yield* FileAccess.Service
    const location = yield* Location.Service
    const lsp = yield* Lsp.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          traits: { readOnly: true, concurrencySafe: true, interruptBehavior: "cancel" },
          description:
            "Ask the project's language server about code: go to a definition, find references, show a symbol's type, list a file's symbols, or list its errors. Only works for languages with a language server installed. Lines and columns are 1-based, as in read output.",
          input: Input,
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* access.authorizeRead(input.path, context)
              const file = target.absolute
              const display = (value: string) => path.relative(location.directory, value) || value
              if (input.action === "diagnostics") {
                const items = (yield* lsp.diagnostics([file]))[file]
                if (items === undefined)
                  return { content: `No language server is available for ${path.basename(file)}.` }
                return {
                  content:
                    items.length === 0
                      ? `No problems in ${input.path}.`
                      : items
                          .map(
                            (item) =>
                              `${input.path}:${item.range.start.line + 1}:${item.range.start.character + 1} ${SEVERITY[item.severity ?? 1] ?? "error"}: ${item.message}`,
                          )
                          .join("\n"),
                }
              }
              const position =
                input.action === "symbols"
                  ? {}
                  : input.line === undefined || input.character === undefined
                    ? yield* new ToolFailure({ message: `"${input.action}" needs a line and character.` })
                    : { position: { line: input.line - 1, character: input.character - 1 } }
              const result = yield* lsp.request(METHODS[input.action], file, {
                ...position,
                ...(input.action === "references" ? { context: { includeDeclaration: true } } : {}),
              })
              return { content: format(input.action, result, display) }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: error.message, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

const SEVERITY: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" }

// Language servers answer with several shapes; render each as short lines the model can act on.
function format(action: keyof typeof METHODS, result: unknown, display: (file: string) => string) {
  if (result === null || result === undefined || (Array.isArray(result) && result.length === 0))
    return `No ${action === "symbols" ? "symbols" : action} found.`
  if (action === "hover") return hoverText(result)
  if (action === "symbols") return symbols(Array.isArray(result) ? result : [], 0).join("\n")
  return (Array.isArray(result) ? result : [result])
    .flatMap((item: unknown) => {
      const place = record(item)
      const uri = string(place?.uri) ?? string(place?.targetUri)
      const range = record(place?.range) ?? record(place?.targetSelectionRange)
      const start = record(range?.start)
      if (!uri || !start) return []
      return [`${display(fileURLToPath(uri))}:${Number(start.line) + 1}:${Number(start.character) + 1}`]
    })
    .join("\n")
}

function hoverText(result: unknown): string {
  const contents = record(result)?.contents
  if (typeof contents === "string") return contents
  if (Array.isArray(contents))
    return contents.map((item) => (typeof item === "string" ? item : hoverText({ contents: item }))).join("\n")
  return string(record(contents)?.value) ?? "No hover information."
}

function symbols(items: unknown[], depth: number): string[] {
  return items.flatMap((item) => {
    const symbol = record(item)
    const range = record(record(symbol?.selectionRange) ?? record(record(symbol?.location)?.range))
    const line = Number(record(range?.start)?.line ?? 0) + 1
    return [
      `${"  ".repeat(depth)}${string(symbol?.name) ?? "?"} (line ${line})`,
      ...symbols(Array.isArray(symbol?.children) ? symbol.children : [], depth + 1),
    ]
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}
