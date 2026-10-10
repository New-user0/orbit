export * as NotebookEditTool from "./notebook-edit.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { FileDiff } from "@orbit/schema/file-diff"
import { Effect, Schema } from "effect"
import { Environment } from "../../environment/index.js"
import { FileAccess } from "../../file-access.js"
import { FileLedger } from "../../file-ledger.js"
import { FileMutation } from "../../file-mutation.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { NonNegativeInt } from "../../schema.js"
import { Notebook } from "../notebook.js"
import { fileDiff } from "./file-diff.js"

export const name = "NotebookEdit"

export const Input = Schema.Struct({
  notebook_path: Schema.String.annotate({ description: "Jupyter notebook (.ipynb) to edit" }),
  mode: Schema.Literals(["replace", "insert", "delete"]).annotate({
    description:
      '"replace" changes a cell\'s source, "insert" adds a new cell before the given position (or at the end), and "delete" removes a cell.',
  }),
  cellId: Schema.optionalKey(Schema.String).annotate({
    description: "Id of the cell to change, as shown by the Read tool. Use this or `index`.",
  }),
  index: Schema.optionalKey(NonNegativeInt).annotate({
    description: "0-based position of the cell, as shown by the Read tool. Use this or `cellId`.",
  }),
  source: Schema.optionalKey(Schema.String).annotate({
    description: 'New cell source. Required for "replace" and "insert".',
  }),
  cellType: Schema.optionalKey(Schema.Literals(["code", "markdown", "raw"])).annotate({
    description: 'Cell type. Required for "insert"; for "replace" it changes the cell\'s type.',
  }),
})

export const Output = Schema.Struct({ files: Schema.Array(FileDiff.Info), cells: NonNegativeInt })

export const Plugin = {
  id: "orbit.tool.notebook-edit",
  effect: Effect.fn("NotebookEditTool.Plugin")(function* (ctx: Context) {
    const access = yield* FileAccess.Service
    const environment = yield* Environment.Service
    const fileMutation = yield* FileMutation.Service
    const ledger = yield* FileLedger.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false, permission: "Edit" },
          traits: { readOnly: false, concurrencySafe: false },
          description:
            "Replace, insert, or delete a cell in a Jupyter notebook (.ipynb). Read the notebook first to see cell ids and positions. Editing a code cell clears its outputs.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (!Notebook.isNotebook(input.notebook_path))
                return yield* new ToolFailure({ message: `${input.notebook_path} is not a Jupyter notebook (.ipynb).` })
              const target = yield* access.resolve({ path: input.notebook_path, kind: "file" })
              yield* access.authorizeExternal([target], context)
              yield* ledger.assertFresh(context.sessionID, target.absolute, input.notebook_path)
              const original = yield* FileMutation.readText(environment.files, target.absolute).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `File not found: ${input.notebook_path}` })),
                ),
              )
              const notebook = Notebook.parse(original.text)
              if (!notebook)
                return yield* new ToolFailure({ message: `${input.notebook_path} is not a valid notebook.` })
              const edit = yield* resolveEdit(input, notebook)
              const next = Notebook.apply(notebook, edit)
              const after = Notebook.serialize(next, original.text)
              const preview = fileDiff(target.resource, original.text, after)
              yield* permission.assert({
                action: "Edit",
                resources: [target.resource],
                save: ["*"],
                // `paths` and each file's `place` are where the edit lands as resolved here, absolute, for a client to show.
                metadata: { paths: [target.place], files: [{ ...preview, place: target.place }] },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool" as const, messageID: context.messageID, id: context.id },
              })
              // Notebooks skip the formatter: reformatting JSON would rewrite every line of the file.
              const result = yield* fileMutation.write({ target, content: after })
              yield* ledger.record(context.sessionID, target.absolute)
              return {
                files: [fileDiff(result.resource, original.text, after)],
                cells: NonNegativeInt.make(next.cells.length),
              }
            }).pipe(
              fileMutation.withLock([FileAccess.resolvePath(location.directory, input.notebook_path)]),
              Effect.map((output) => ({
                output,
                content: `Edited ${output.files[0]?.file} (${input.mode}; ${output.cells} cells)`,
                metadata: { files: output.files },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to edit ${input.notebook_path}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

const resolveEdit = Effect.fnUntraced(function* (input: typeof Input.Type, notebook: Notebook.Document) {
  const count = notebook.cells.length
  const byId = input.cellId === undefined ? undefined : notebook.cells.findIndex((cell) => cell.id === input.cellId)
  if (byId === -1) return yield* new ToolFailure({ message: `No cell has id ${input.cellId}.` })
  const index = byId ?? input.index
  if (input.mode === "insert") {
    if (input.source === undefined || input.cellType === undefined)
      return yield* new ToolFailure({ message: 'Inserting a cell needs both "source" and "cellType".' })
    const position = index ?? count
    if (position > count)
      return yield* new ToolFailure({ message: `Cell position ${position} is past the end (${count} cells).` })
    return { mode: "insert", index: position, source: input.source, cellType: input.cellType } as const
  }
  if (index === undefined) return yield* new ToolFailure({ message: 'Give the cell with "cellId" or "index".' })
  if (index >= count) return yield* new ToolFailure({ message: `There is no cell ${index} (${count} cells).` })
  if (input.mode === "delete") return { mode: "delete", index } as const
  if (input.source === undefined) return yield* new ToolFailure({ message: 'Replacing a cell needs "source".' })
  return { mode: "replace", index, source: input.source, cellType: input.cellType } as const
})
