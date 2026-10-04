export * as Notebook from "./notebook.js"

import { Option, Schema } from "effect"

/**
 * Jupyter notebooks (nbformat 4) as the read and notebook_edit tools see them. Parsing keeps the whole JSON document so
 * metadata and fields this module does not know about survive an edit unchanged.
 */

const Source = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const Cell = Schema.Struct({
  cell_type: Schema.String,
  id: Schema.optionalKey(Schema.String),
  source: Source,
  outputs: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})
const Shape = Schema.Struct({
  cells: Schema.Array(Cell),
  nbformat: Schema.optionalKey(Schema.Number),
  nbformat_minor: Schema.optionalKey(Schema.Number),
})
export type Cell = typeof Cell.Type
export type Document = typeof Shape.Type & Record<string, unknown>

const Output = Schema.Struct({
  output_type: Schema.String,
  name: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Source),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  ename: Schema.optionalKey(Schema.String),
  evalue: Schema.optionalKey(Schema.String),
})

const isShape = Schema.is(Shape)
const decodeOutput = Schema.decodeUnknownOption(Output)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const isNotebook = (path: string) => path.toLowerCase().endsWith(".ipynb")

export function parse(text: string): Document | undefined {
  const json = Option.getOrUndefined(decodeJson(text))
  if (!isShape(json)) return undefined
  return json as Document
}

/** Renders cells as tagged blocks with their source and text outputs. Binary outputs are named, not inlined. */
export function render(notebook: Document) {
  return notebook.cells
    .map((cell, index) => {
      const id = cell.id ? ` id="${cell.id}"` : ""
      const outputs = (cell.outputs ?? []).flatMap((output) => renderOutput(output))
      return [
        `<cell index="${index}"${id} type="${cell.cell_type}">`,
        join(cell.source),
        ...(outputs.length > 0 ? ["<outputs>", ...outputs, "</outputs>"] : []),
        "</cell>",
      ].join("\n")
    })
    .join("\n\n")
}

function renderOutput(value: unknown) {
  const output = Option.getOrUndefined(decodeOutput(value))
  if (!output) return []
  if (output.output_type === "stream" && output.text !== undefined) return [join(output.text).replace(/\n$/, "")]
  if (output.output_type === "error") return [`${output.ename ?? "Error"}: ${output.evalue ?? ""}`]
  const data = output.data ?? {}
  const text = data["text/plain"]
  const media = Object.keys(data).filter((mime) => mime !== "text/plain")
  return [
    ...(typeof text === "string" || Array.isArray(text) ? [join(text as string | string[]).replace(/\n$/, "")] : []),
    ...media.map((mime) => `[${mime} output omitted]`),
  ]
}

export type Edit =
  | { readonly mode: "replace"; readonly index: number; readonly source: string; readonly cellType?: string }
  | { readonly mode: "insert"; readonly index: number; readonly source: string; readonly cellType: string }
  | { readonly mode: "delete"; readonly index: number }

/** Applies one edit and returns the new document. `insert` places the new cell at `index`. */
export function apply(notebook: Document, edit: Edit): Document {
  const cells = [...notebook.cells]
  if (edit.mode === "delete") cells.splice(edit.index, 1)
  if (edit.mode === "insert") cells.splice(edit.index, 0, create(notebook, edit.cellType, edit.source))
  if (edit.mode === "replace") {
    const current = cells[edit.index]!
    const type = edit.cellType ?? current.cell_type
    // Changed code no longer matches its old outputs, and a cell that changes type takes the new type's shape.
    cells[edit.index] =
      type === current.cell_type
        ? {
            ...current,
            source: lines(edit.source),
            ...(type === "code" ? { outputs: [], execution_count: null } : {}),
          }
        : { ...create(notebook, type, edit.source), ...(current.id ? { id: current.id } : {}) }
  }
  return { ...notebook, cells }
}

function create(notebook: Document, type: string, source: string): Cell {
  // Cell ids exist from nbformat 4.5; older notebooks must not gain them.
  const ids = (notebook.nbformat ?? 4) > 4 || (notebook.nbformat_minor ?? 0) >= 5
  return {
    cell_type: type,
    ...(ids ? { id: crypto.randomUUID().replaceAll("-", "").slice(0, 8) } : {}),
    metadata: {},
    source: lines(source),
    ...(type === "code" ? { execution_count: null, outputs: [] } : {}),
  } as Cell
}

/** Serializes with the indentation and trailing newline the file already used, so diffs stay small. */
export function serialize(notebook: Document, original: string) {
  const indent = /^\{\r?\n([ \t]+)"/.exec(original)?.[1] ?? " "
  return `${JSON.stringify(notebook, null, indent)}${original.endsWith("\n") ? "\n" : ""}`
}

const join = (source: string | readonly string[]) => (typeof source === "string" ? source : source.join(""))
const lines = (source: string) => (source === "" ? [] : source.split(/(?<=\n)/))
