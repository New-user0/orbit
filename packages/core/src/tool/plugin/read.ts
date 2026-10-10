export * as ReadTool from "./read.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { basename, dirname, join } from "path"
import { ToolFailure } from "@orbit/ai"
import { CompatInstructions } from "@orbit/compat/instructions"
import { Effect, Schema } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { SessionInstructions } from "../../session/instructions.js"
import { FileLedger } from "../../file-ledger.js"
import { FileMutation } from "../../file-mutation.js"
import { Notebook } from "../notebook.js"
import { AbsolutePath, PositiveInt } from "../../schema.js"
import { ReadToolFileSystem } from "../read-filesystem.js"
import { Environment } from "../../environment/index.js"

export const name = "Read"
const LocationInput = Schema.Struct({
  file_path: Schema.String.annotate({ description: "File or directory to read" }),
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
  }),
})
export const Input = LocationInput
const Output = Schema.Union([ReadToolFileSystem.FileContent, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])

export const Plugin = {
  id: "orbit.tool.read",
  effect: Effect.fn("ReadTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const reader = yield* ReadToolFileSystem.Service
    const access = yield* FileAccess.Service
    const sessionInstructions = yield* SessionInstructions.Service
    const ledger = yield* FileLedger.Service
    const environment = yield* Environment.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false },
          traits: { readOnly: true, concurrencySafe: true, interruptBehavior: "cancel", maxResultChars: Infinity },
          description:
            "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. A read returns at most 2000 lines or about 25000 tokens of rendered text, and a truncated one ends with the offset to continue from. Prefer one larger read over many small slices, and use Grep to find specific content in large files. Device paths such as /dev/zero or NUL are refused.",
          input: Input,
          output: Output,
          execute: (input, context) => {
            return Effect.gen(function* () {
              // A notebook is paged by its rendered cells, so its raw JSON is read whole: the offset of a page is a line
              // of the rendering, which the JSON may not have.
              const read = (target: FileAccess.Target, paged = !Notebook.isNotebook(target.absolute)) =>
                reader.read(target.absolute, target.resource, paged ? { offset: input.offset, limit: input.limit } : {})

              const requested = yield* access.authorizeRead(input.file_path, context)
              const result = yield* read(requested).pipe(
                Effect.map((content) => ({ content, target: requested, path: input.file_path })),
                Effect.catchIf(
                  (error) => error instanceof Environment.NotFound,
                  () =>
                    Effect.gen(function* () {
                      const alternate = yield* alternatePath(requested.absolute).pipe(
                        Effect.orElseSucceed(() => undefined),
                      )
                      if (!alternate) return yield* missing(input.file_path, requested.absolute)
                      const target = yield* access.authorizeRead(alternate, context, { siblingOf: requested })
                      const content = yield* read(target).pipe(
                        Effect.catchIf(
                          (error) => error instanceof Environment.NotFound,
                          () => missing(input.file_path, requested.absolute),
                        ),
                      )
                      if (content.type === "list-page") return yield* missing(input.file_path, requested.absolute)
                      return {
                        content,
                        target,
                        path: join(dirname(input.file_path), basename(alternate)),
                      }
                    }),
                ),
              )
              // After a successful read, discover nearby instruction files walking up to the Location
              // root exclusive and inject them as durable synthetic instructions. For a
              // directory listing the walk starts at the directory itself (so its own AGENTS.md
              // is discovered); for a file it starts at the file's dirname. External reads are
              // skipped, and discovery failures never fail the read.
              yield* Effect.gen(function* () {
                if (result.target.externalDirectory !== undefined) return
                const resolved = yield* fs.resolve(result.target.absolute)
                const root = yield* fs.resolve(location.directory)
                // The Location and its ancestors are already supplied by initial instructions,
                // even when an upward walk from elsewhere in the project cannot reach root.
                const discovered = yield* fs.up({
                  targets: [...CompatInstructions.filenames(yield* config.compatEnabled())],
                  start: result.content.type === "list-page" ? resolved : dirname(resolved),
                  stop: root,
                  type: "file",
                })
                const candidates = (yield* Effect.forEach(discovered, fs.resolve))
                  .filter((file, index, all) => all.findIndex((other) => dirname(other) === dirname(file)) === index)
                  .filter((file) => !FSUtil.contains(dirname(file), root) && file !== resolved)
                if (candidates.length === 0) return
                yield* sessionInstructions.load({ sessionID: context.sessionID, paths: candidates })
              }).pipe(
                Effect.catch(() => Effect.void),
                Effect.catchDefect(() => Effect.void),
              )
              if (
                result.content.type === "file" &&
                result.content.encoding === "base64" &&
                !ReadToolFileSystem.MEDIA_MIMES.has(result.content.mime)
              )
                return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource: result.target.resource }))
              // A folder named like a notebook was read whole above; page it as any folder.
              if (result.content.type === "list-page" && Notebook.isNotebook(result.target.absolute))
                return { output: yield* read(result.target, true), path: result.path }
              if (result.content.type !== "list-page") yield* ledger.record(context.sessionID, result.target.absolute)
              if (result.content.type !== "list-page" && Notebook.isNotebook(result.target.absolute)) {
                const notebook = yield* readNotebook(result.target.absolute, input.offset, input.limit)
                if (notebook) return { output: notebook, path: result.path }
                // Not a notebook after all: read it as the text it is, from the offset asked for.
                return { output: yield* read(result.target, true), path: result.path }
              }
              return { output: result.content, path: result.path }
            }).pipe(
              Effect.map((result) => ({
                output: result.output,
                content: toModelContent(result.path, input.offset, result.output),
                metadata: { truncated: result.output.type === "file" ? false : result.output.truncated },
              })),
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const message =
                  error instanceof FileAccess.DeviceError ||
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof ReadToolFileSystem.OffsetOutOfRangeError ||
                  error instanceof ReadToolFileSystem.PathKindError
                    ? error.message
                    : `Unable to read ${input.file_path}`
                return new ToolFailure({ message, error })
              }),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    // Notebooks read as their cells and outputs rather than raw JSON, paged by rendered line.
    const readNotebook = Effect.fn("ReadTool.readNotebook")(function* (
      absolute: string,
      offset: number | undefined,
      limit: number | undefined,
    ) {
      const notebook = Notebook.parse((yield* FileMutation.readText(environment.files, absolute)).text)
      if (!notebook) return
      const lines = Notebook.render(notebook).split("\n")
      const start = offset || 1
      if (start > lines.length && start !== 1)
        return yield* new ReadToolFileSystem.OffsetOutOfRangeError({ offset: start, lines: lines.length })
      const count = Math.min(limit || ReadToolFileSystem.MAX_READ_LINES, ReadToolFileSystem.MAX_READ_LINES)
      // The same budget as a text file: lines are clamped, and the page ends before the line that would pass it.
      const page: string[] = []
      let size = 0
      for (const line of lines.slice(start - 1, start - 1 + count)) {
        const text = ReadToolFileSystem.clampLine(line)
        const length = ReadToolFileSystem.renderedLength(start + page.length, text)
        if (page.length > 0 && !ReadToolFileSystem.withinBudget(size + length)) break
        page.push(text)
        size += length
      }
      const next = start + page.length
      return new ReadToolFileSystem.TextPage({
        type: "text-page",
        content: page.join("\n"),
        mime: "application/x-ipynb+json",
        offset: PositiveInt.make(start),
        truncated: next <= lines.length,
        ...(next <= lines.length ? { next: PositiveInt.make(next) } : {}),
      })
    })

    const alternatePath = Effect.fn("ReadTool.alternatePath")(function* (absolute: string) {
      const canonical = (name: string) =>
        name
          .normalize("NFC")
          .replace(/[\u00a0\u202f]/g, " ")
          .replace(/[\u2018\u2019]/g, "'")
      const base = canonical(basename(absolute))
      const matches = (yield* reader.list(AbsolutePath.make(dirname(absolute)))).filter(
        (entry) => entry.type === "file" && canonical(entry.name) === base,
      )
      if (matches.length !== 1) return
      return join(dirname(absolute), matches[0].name)
    })

    const missing = Effect.fn("ReadTool.missing")(function* (input: string, absolute: string) {
      const base = basename(input).toLowerCase()
      const suggestions = yield* fs.readDirectory(dirname(absolute)).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => {
              const candidate = entry.toLowerCase()
              return candidate.includes(base) || base.includes(candidate)
            })
            .map((entry) => join(dirname(input), entry))
            .slice(0, 3),
        ),
        Effect.orElseSucceed(() => [] as string[]),
      )
      const message =
        suggestions.length === 0
          ? `File not found: ${input}`
          : `File not found: ${input}\n\nDid you mean one of these?\n${suggestions.join("\n")}`
      return yield* new ToolFailure({ message })
    })
  }),
}

export const toModelContent = (path: string, offset: number | undefined, output: typeof Output.Type) => {
  if (output.type === "file" && output.encoding === "base64")
    return [
      { type: "text", text: output.mime === "application/pdf" ? "PDF read successfully" : "Image read successfully" },
      {
        type: "file",
        uri: `data:${output.mime};base64,${output.content}`,
        mime: output.mime,
        name: path,
      },
    ] as const

  if (output.type === "list-page") {
    const start = offset || 1
    const content = [
      output.entries.length === 0
        ? `Read directory ${path}, 0 entries`
        : `Read directory ${path}, entries ${start}-${start + output.entries.length - 1}`,
    ]
    output.entries.forEach((entry) => content.push(entry.path))
    if (output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    return content.join("\n")
  }

  const start = output.type === "text-page" ? output.offset : 1
  // Pages already join selected lines; a trailing newline represents a selected blank line.
  const text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content
  const lines = output.content === "" ? [] : text.split("\n")
  const content = [
    lines.length === 0 ? `Read file ${path}, 0 lines` : `Read file ${path}, lines ${start}-${start + lines.length - 1}`,
  ]
  lines.forEach((line, index) => content.push(`${start + index}: ${line}`))
  if (output.type === "text-page" && output.truncated && output.next !== undefined)
    content.push(
      `[Output truncated: one read returns at most ${ReadToolFileSystem.MAX_READ_LINES} lines or about ${ReadToolFileSystem.MAX_READ_TOKENS} tokens. Continue reading with offset: ${output.next}, or use Grep to find specific content.]`,
    )
  return content.join("\n")
}
