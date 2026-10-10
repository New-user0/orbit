export * as LspPlugin from "./plugin.js"

import { define } from "@orbit/plugin/effect/plugin"
import { isRecord } from "@orbit/ai/utils/record"
import { Effect, Schema } from "effect"
import path from "path"
import { FileAccess } from "../file-access.js"
import { Location } from "../location.js"
import type { PluginInternal } from "../plugin/internal.js"
import { WriteTool } from "../tool/plugin/write.js"
import { Lsp } from "./index.js"

/**
 * After a tool changes files, asks their language servers for errors and adds them to the result, so the model sees
 * a broken build right away. Diagnostics also go in the result metadata, keyed by path, for the TUI's edit view.
 */

const EDITING_TOOLS = new Set(["Edit", "Write", "Patch", "NotebookEdit"])
const MAX_PER_FILE = 10
const ERROR = 1

export const Plugin = define({
  id: "orbit.lsp.diagnostics",
  effect: Effect.fn("LspPlugin")(function* (ctx) {
    const lsp = yield* Lsp.Service
    const location = yield* Location.Service

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.status !== "completed" || !EDITING_TOOLS.has(event.tool)) return
        // Write returns no file list. Its output names the path it wrote, which can differ from the spelling in its
        // input (a link that leads into the project), so the server is told that path. A result without Write's output
        // falls back to the input, resolved lexically. The other tools report the files they changed.
        const files =
          event.tool === "Write"
            ? writtenFile(event.input, event.result.output, location.directory)
            : changedFiles(event.result.metadata?.files).map((file) => path.resolve(location.directory, file))
        if (files.length === 0) return
        const found = yield* lsp.diagnostics(files, { save: true })
        const errors = Object.entries(found).flatMap(([file, items]) => {
          const list = items.filter((item) => item.severity === ERROR)
          return list.length === 0 ? [] : [[file, list] as const]
        })
        if (errors.length === 0) return
        const lines = errors.flatMap(([file, items]) => [
          `${path.relative(location.directory, file)}:`,
          ...items
            .slice(0, MAX_PER_FILE)
            .map((item) => `  ${item.range.start.line + 1}:${item.range.start.character + 1} ${item.message}`),
          ...(items.length > MAX_PER_FILE ? [`  … ${items.length - MAX_PER_FILE} more`] : []),
        ])
        // The TUI looks diagnostics up by the path the tool was given, so key them by that as well.
        const input = isRecord(event.input) ? event.input : {}
        const given = input.file_path ?? input.notebook_path ?? input.path
        const diagnostics = Object.fromEntries([
          ...errors,
          ...(typeof given === "string" && errors.length === 1 ? [[given, errors[0]![1]] as const] : []),
        ])
        const content = event.result.content
        event.result = {
          ...event.result,
          content: [
            ...(content === undefined
              ? []
              : typeof content === "string"
                ? [{ type: "text" as const, text: content }]
                : content),
            { type: "text", text: `Language server errors after this change:\n${lines.join("\n")}` },
          ],
          metadata: { ...event.result.metadata, diagnostics },
        }
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)

function writtenFile(input: unknown, output: unknown, directory: string) {
  if (Schema.is(WriteTool.Output)(output)) return [output.target]
  const target = isRecord(input) ? (input.file_path ?? input.path) : undefined
  return typeof target === "string" ? [FileAccess.resolvePath(directory, target)] : []
}

function changedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) =>
    typeof item === "object" &&
    item !== null &&
    "file" in item &&
    typeof item.file === "string" &&
    !("status" in item && item.status === "deleted")
      ? [item.file]
      : [],
  )
}
