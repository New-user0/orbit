export * as LspTool from "./lsp.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { isRecord } from "@orbit/ai/utils/record"
import { ToolFailure } from "@orbit/ai"
import { Effect, Schema } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Lsp } from "../../lsp/index.js"
import { PositiveInt } from "../../schema.js"

export const name = "LSP"

export const Input = Schema.Struct({
  action: Schema.Literals([
    "definition",
    "references",
    "hover",
    "symbols",
    "diagnostics",
    "implementation",
    "workspace_symbols",
    "prepare_call_hierarchy",
    "incoming_calls",
    "outgoing_calls",
  ]).annotate({
    description:
      '"definition", "implementation" and "references" find where the symbol at a position is defined, implemented or used; "hover" shows its type and docs; "symbols" lists the file\'s symbols; "diagnostics" lists its errors and warnings; "workspace_symbols" searches the whole project for symbols by `query`; "prepare_call_hierarchy" shows the function at a position, "incoming_calls" lists what calls it, and "outgoing_calls" lists what it calls.',
  }),
  path: Schema.String.annotate({
    description: 'File to ask about. For "workspace_symbols" it only chooses which language server answers.',
  }),
  line: Schema.optionalKey(PositiveInt).annotate({ description: "1-based line of the symbol, for position actions" }),
  character: Schema.optionalKey(PositiveInt).annotate({
    description: "1-based column of the symbol, for position actions",
  }),
  query: Schema.optionalKey(Schema.String).annotate({
    description:
      'Text that symbol names are matched against, used only by "workspace_symbols". Some servers return nothing for an empty query.',
  }),
})

type Action = typeof Input.Type.action

const METHODS = {
  definition: "textDocument/definition",
  references: "textDocument/references",
  hover: "textDocument/hover",
  symbols: "textDocument/documentSymbol",
  implementation: "textDocument/implementation",
  prepare_call_hierarchy: "textDocument/prepareCallHierarchy",
} as const

const POSITIONAL = new Set<Action>([
  "definition",
  "references",
  "hover",
  "implementation",
  "prepare_call_hierarchy",
  "incoming_calls",
  "outgoing_calls",
])

// Results in files that git ignores are left out of these.
const FILTERED = new Set<Action>(["definition", "references", "implementation", "workspace_symbols"])

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
          options: { authorizes: true, codemode: false },
          traits: { readOnly: true, concurrencySafe: true, interruptBehavior: "cancel" },
          description:
            "Ask the project's language server about code. Actions: definition, implementation and references (where the symbol at a position is defined, implemented or used), hover (its type and docs), symbols (the file's outline), workspace_symbols (search every symbol in the project by `query`; `path` only chooses the server), prepare_call_hierarchy (the function at a position), incoming_calls (what calls it), outgoing_calls (what it calls; the listed call positions are in the inspected file) and diagnostics (the file's errors and warnings). Call actions take the position of a function's name and use the first item found there. Results in git-ignored files are left out. Only works for languages with a language server installed. Lines and columns are 1-based, as in read output.",
          input: Input,
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* access.authorizeRead(input.path, context)
              const file = target.absolute
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
              const action = input.action
              const position = POSITIONAL.has(action)
                ? input.line === undefined || input.character === undefined
                  ? yield* new ToolFailure({ message: `"${input.action}" needs a line and character.` })
                  : { position: { line: input.line - 1, character: input.character - 1 } }
                : {}

              const result = yield* Effect.gen(function* () {
                if (action === "workspace_symbols")
                  return yield* lsp.send("workspace/symbol", file, { query: input.query ?? "" })
                if (action === "incoming_calls" || action === "outgoing_calls") {
                  const prepared = yield* lsp.request(METHODS.prepare_call_hierarchy, file, position)
                  if (!Array.isArray(prepared) || prepared.length === 0) return NO_CALL_ITEM
                  // The server gets the first item back exactly as it sent it, including any opaque data.
                  return yield* lsp.send(
                    action === "incoming_calls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
                    file,
                    { item: prepared[0] },
                  )
                }
                return yield* lsp.request(METHODS[action], file, {
                  ...position,
                  ...(action === "references" ? { context: { includeDeclaration: true } } : {}),
                })
              })
              if (result === NO_CALL_ITEM)
                return {
                  content: "No call hierarchy item at that position. Point at the name of a function or method.",
                }

              const shown = FILTERED.has(input.action) ? yield* visible(lsp, result) : result
              return {
                content: format(input.action, input.path, shown, (uri) => display(uri, location.directory)),
              }
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
const NO_CALL_ITEM = Symbol("no call hierarchy item")

const KINDS = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
]

type Entry = Record<string, unknown>
type Show = (uri: string | undefined) => string

// Where an answer's entry points, whatever its shape: a Location, a LocationLink or a symbol with a location.
const uriOf = (entry: Entry) =>
  string(entry.uri) ?? string(entry.targetUri) ?? (isRecord(entry.location) ? string(entry.location.uri) : undefined)

function list(result: unknown) {
  if (result === null || result === undefined) return []
  return (Array.isArray(result) ? result : [result]).filter(isRecord)
}

// Servers send anything: a URI of another scheme (a jar, a virtual document) or a malformed file URI has no path here.
function filePath(uri: string) {
  if (!uri.startsWith("file:")) return undefined
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

function visible(lsp: Lsp.Interface, result: unknown) {
  return Effect.gen(function* () {
    const entries = list(result)
    const files = [...new Set(entries.flatMap((entry) => filePath(uriOf(entry) ?? "") ?? []))]
    if (files.length === 0) return entries
    const hidden = yield* lsp.ignored(files)
    return entries.filter((entry) => !hidden.has(filePath(uriOf(entry) ?? "") ?? ""))
  })
}

// A path relative to the Location when that is shorter and stays near it, else absolute. Forward slashes everywhere.
// A URI that is not a readable file is printed as given.
function display(uri: string | undefined, directory: string) {
  if (uri === undefined) return "(unknown location)"
  const absolute = filePath(uri)
  if (absolute === undefined) return uri
  const relative = path.relative(directory, absolute).split(path.sep).join("/")
  const near =
    relative.length > 0 &&
    relative.length < absolute.length &&
    !path.isAbsolute(relative) &&
    !relative.startsWith("../../")
  return near ? relative : absolute.split(path.sep).join("/")
}

function format(action: Exclude<Action, "diagnostics">, file: string, result: unknown, show: Show) {
  switch (action) {
    case "definition":
      return places(
        "Definition",
        "definitions",
        list(result),
        show,
        "No definition found. The position may not be on a symbol, or its source may be outside what the server has indexed.",
      )
    case "implementation":
      return places(
        "Implementation",
        "implementations",
        list(result),
        show,
        "No implementation found. The position may not be on an interface or abstract member, or the implementations may be outside what the server has indexed.",
      )
    case "references":
      return references(list(result), show)
    case "hover":
      return hover(result)
    case "symbols":
      return documentSymbols(file, result, show)
    case "workspace_symbols":
      return workspaceSymbols(list(result), show)
    case "prepare_call_hierarchy":
      return items(list(result), show)
    case "incoming_calls":
      return calls("incoming", list(result), show)
    case "outgoing_calls":
      return calls("outgoing", list(result), show)
  }
}

function position(range: unknown) {
  const start = isRecord(range) && isRecord(range.start) ? range.start : undefined
  if (typeof start?.line !== "number" || typeof start.character !== "number") return undefined
  return { line: start.line + 1, column: start.character + 1 }
}

function place(entry: Entry, show: Show) {
  const uri = uriOf(entry)
  if (uri === undefined) return []
  // A link points at its selection, else at its whole target.
  const start = position(entry.targetUri !== undefined ? (entry.targetSelectionRange ?? entry.targetRange) : entry.range)
  return [{ uri, shown: show(uri), at: start ? `${start.line}:${start.column}` : undefined }]
}

function places(singular: string, plural: string, entries: Entry[], show: Show, empty: string) {
  const found = entries.flatMap((entry) => place(entry, show))
  const text = (item: (typeof found)[number]) => (item.at === undefined ? item.shown : `${item.shown}:${item.at}`)
  if (found.length === 0) return empty
  if (found.length === 1) return `${singular}: ${text(found[0]!)}`
  return [`${found.length} ${plural}:`, ...found.map((item) => `  ${text(item)}`)].join("\n")
}

function references(entries: Entry[], show: Show) {
  const found = entries.flatMap((entry) => place(entry, show))
  if (found.length === 0)
    return "No references found. The position may not be on a symbol, or the server may not have finished indexing."
  if (found.length === 1) return `1 reference:\n  ${found[0]!.shown}${found[0]!.at ? `:${found[0]!.at}` : ""}`
  const files = new Set(found.map((item) => item.uri)).size
  return [
    `${found.length} references in ${files} ${files === 1 ? "file" : "files"}:`,
    ...grouped(
      found,
      (item) => item.uri,
      (item) => item.shown,
      (item) => item.at ?? "(no position)",
    ),
  ].join("\n")
}

// Files in the order the server first named them, each with its entries in the server's order.
function grouped<T>(items: T[], key: (item: T) => string, heading: (item: T) => string, line: (item: T) => string) {
  const groups = new Map<string, { heading: string; lines: string[] }>()
  items.forEach((item) => {
    const group = groups.get(key(item)) ?? { heading: heading(item), lines: [] }
    group.lines.push(line(item))
    groups.set(key(item), group)
  })
  return [...groups.values()].flatMap((group) => ["", `${group.heading}:`, ...group.lines.map((text) => `  ${text}`)])
}

function hover(result: unknown) {
  const text = hoverText(isRecord(result) ? result.contents : undefined)
  if (text === undefined || text === "") return "No hover information. The position may not be on a symbol."
  const start = isRecord(result) ? position(result.range) : undefined
  return start ? `At ${start.line}:${start.column}:\n\n${text}` : text
}

function hoverText(contents: unknown): string | undefined {
  if (typeof contents === "string") return contents
  if (Array.isArray(contents))
    return contents
      .flatMap((item) => hoverText(item) ?? [])
      .filter((text) => text !== "")
      .join("\n\n")
  return isRecord(contents) ? string(contents.value) : undefined
}

// Some servers put a multi-line signature in a name or detail; one entry stays one line.
const one = (value: unknown) => (string(value) ?? "").replace(/\s*[\r\n]+\s*/g, " ")
const kind = (value: unknown) => (typeof value === "number" ? (KINDS[value - 1] ?? "Unknown") : "Unknown")
const lineOf = (value: unknown) => position(value)?.line

function documentSymbols(file: string, result: unknown, show: Show) {
  const entries = list(result)
  if (entries.length === 0) return "No symbols found in this file. The server may not have finished indexing."
  // A server may answer with flat symbols that carry their own locations instead of an outline.
  if (entries[0]!.location !== undefined) return workspaceSymbols(entries, show)
  const lines = (symbols: Entry[], depth: number): string[] =>
    symbols.flatMap((symbol) => {
      const line = lineOf(symbol.range)
      const detail = one(symbol.detail)
      return [
        `${"  ".repeat(depth)}${one(symbol.name) || "?"} (${kind(symbol.kind)})${detail ? ` ${detail}` : ""}${line === undefined ? "" : `, line ${line}`}`,
        ...lines(list(symbol.children), depth + 1),
      ]
    })
  return [`Symbols in ${file}:`, ...lines(entries, 0)].join("\n")
}

function workspaceSymbols(entries: Entry[], show: Show) {
  // An entry without a location is skipped. A location without a range is printed without a line.
  const found = entries.flatMap((entry) => {
    const uri = uriOf(entry)
    return uri === undefined ? [] : [{ entry, uri }]
  })
  if (found.length === 0)
    return "No symbols found. Some servers return nothing for an empty query, or have not finished indexing."
  return [
    `${found.length} ${found.length === 1 ? "symbol" : "symbols"} in the workspace:`,
    ...grouped(
      found,
      (item) => item.uri,
      (item) => show(item.uri),
      (item) => {
        const line = isRecord(item.entry.location) ? lineOf(item.entry.location.range) : undefined
        const container = one(item.entry.containerName)
        return `${one(item.entry.name) || "?"} (${kind(item.entry.kind)})${line === undefined ? "" : `, line ${line}`}${container ? `, in ${container}` : ""}`
      },
    ),
  ].join("\n")
}

function items(entries: Entry[], show: Show) {
  if (entries.length === 0) return "No call hierarchy item at that position."
  const text = (item: Entry) => {
    const line = lineOf(item.range)
    const detail = one(item.detail)
    return `${one(item.name) || "?"} (${kind(item.kind)}) at ${show(string(item.uri))}${line === undefined ? "" : `:${line}`}${detail ? ` [${detail}]` : ""}`
  }
  if (entries.length === 1) return `Function at that position: ${text(entries[0]!)}`
  return [`${entries.length} call hierarchy items:`, ...entries.map((item) => `  ${text(item)}`)].join("\n")
}

function calls(direction: "incoming" | "outgoing", entries: Entry[], show: Show) {
  // An incoming call names its caller in `from`, an outgoing one its callee in `to`. Only entries that name one count.
  const found = entries.flatMap((entry) => {
    const other = entry[direction === "incoming" ? "from" : "to"]
    const uri = isRecord(other) ? string(other.uri) : undefined
    return isRecord(other) && uri !== undefined ? [{ other, uri, ranges: list(entry.fromRanges) }] : []
  })
  if (found.length === 0)
    return `No ${direction} calls found. Nothing may call this function, or the server may not have finished indexing.`
  return [
    `${found.length} ${direction} ${found.length === 1 ? "call" : "calls"}${direction === "outgoing" ? " (call positions are in the inspected file)" : ""}:`,
    ...grouped(
      found,
      (item) => item.uri,
      (item) => show(item.uri),
      (item) => {
        const line = lineOf(item.other.range)
        const sites = item.ranges.flatMap((range) => position(range) ?? [])
        return `${one(item.other.name) || "?"} (${kind(item.other.kind)})${line === undefined ? "" : `, line ${line}`}${
          sites.length === 0
            ? ""
            : `, ${direction === "incoming" ? "calls at" : "called from"} ${sites.map((site) => `${site.line}:${site.column}`).join(", ")}`
        }`
      },
    ),
  ].join("\n")
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}
