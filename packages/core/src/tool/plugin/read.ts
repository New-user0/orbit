export * as ReadTool from "./read.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { basename, dirname, join } from "path"
import { ToolFailure } from "@orbit/ai"
import { Tool } from "../../tool.js"
import { createHash } from "crypto"
import { Effect, Schema } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { InstructionTriggers } from "../../instruction-triggers.js"
import { FileAccess } from "../../file-access.js"
import { FileLedger } from "../../file-ledger.js"
import { FileMutation } from "../../file-mutation.js"
import { Notebook } from "../notebook.js"
import { AbsolutePath, PositiveInt } from "../../schema.js"
import { Pdf } from "../pdf.js"
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
  pages: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[\s\d-]*$/))).annotate({
    description: `Which pages of a PDF to return, counting from 1: one page ("3") or a span ("1-5"), up to ${Pdf.MAX_PAGES_PER_CALL} pages. Needed when the PDF has more than ${Pdf.MAX_WHOLE_PAGES} pages; ignored for other files.`,
  }),
})
export const Input = LocationInput
const Output = Schema.Union([ReadToolFileSystem.FileContent, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])

export const Plugin = {
  id: "orbit.tool.read",
  effect: Effect.fn("ReadTool.Plugin")(function* (ctx: Context) {
    const reader = yield* ReadToolFileSystem.Service
    const access = yield* FileAccess.Service
    const triggers = yield* InstructionTriggers.Service
    const ledger = yield* FileLedger.Service
    const environment = yield* Environment.Service
    const fs = yield* FSUtil.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false },
          traits: { readOnly: true, concurrencySafe: true, interruptBehavior: "cancel", maxResultChars: Infinity },
          description:
            "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Read opens a PDF whole only up to 10 pages; for a longer one, pass pages, and expect at most 20 pages back per call. A read returns at most 2000 lines or about 25000 tokens of rendered text, and a truncated one ends with the offset to continue from. Prefer one larger read over many small slices, and use Grep to find specific content in large files. Device paths such as /dev/zero or NUL are refused.",
          input: Input,
          output: Output,
          execute: (input, context) => {
            return Effect.gen(function* () {
              // Checked first, whatever the file: a bad value never prompts and never touches the disk.
              const pages = yield* parsePages(input.pages)
              // A notebook is paged by its rendered cells, so its raw JSON is read whole: the offset of a page is a line
              // of the rendering, which the JSON may not have.
              const read = (target: FileAccess.Target, paged = !Notebook.isNotebook(target.absolute)) =>
                reader.read(
                  target.absolute,
                  target.resource,
                  // Pages go even with a notebook name: a PDF is told apart by its content, not its extension.
                  { ...(paged ? { offset: input.offset, limit: input.limit } : {}), ...(pages ? { pages } : {}) },
                )

              const requested = yield* access.authorizeRead(input.file_path, context)
              const result = yield* read(requested).pipe(
                Effect.map((read) => ({ ...read, target: requested, path: input.file_path })),
                Effect.catchIf(
                  (error) => error instanceof Environment.NotFound,
                  () =>
                    Effect.gen(function* () {
                      const alternate = yield* alternatePath(requested.absolute).pipe(
                        Effect.orElseSucceed(() => undefined),
                      )
                      if (!alternate) return yield* missing(input.file_path, requested.absolute)
                      const target = yield* access.authorizeRead(alternate, context, { siblingOf: requested })
                      const alternateRead = yield* read(target).pipe(
                        Effect.catchIf(
                          (error) => error instanceof Environment.NotFound,
                          () => missing(input.file_path, requested.absolute),
                        ),
                      )
                      if (alternateRead.content.type === "list-page")
                        return yield* missing(input.file_path, requested.absolute)
                      return {
                        ...alternateRead,
                        target,
                        path: join(dirname(input.file_path), basename(alternate)),
                      }
                    }),
                ),
              )
              if (
                result.content.type === "file" &&
                result.content.encoding === "base64" &&
                !ReadToolFileSystem.MEDIA_MIMES.has(result.content.mime)
              )
                return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource: result.target.resource }))
              // A folder named like a notebook was read whole above; page it as any folder.
              if (result.content.type === "list-page" && Notebook.isNotebook(result.target.absolute))
                return {
                  output: (yield* read(result.target, true)).content,
                  path: result.path,
                  absolute: result.target.absolute,
                  external: result.target.externalDirectory !== undefined,
                }
              if (result.seen) yield* ledger.recordRead(context.sessionID, result.target.absolute, result.seen)
              const absolute = result.target.absolute
              const external = result.target.externalDirectory !== undefined
              if (result.content.type !== "list-page" && Notebook.isNotebook(absolute)) {
                const notebook = yield* readNotebook(absolute, input.offset, input.limit)
                if (notebook) return { output: notebook, path: result.path, absolute, external }
                // Not a notebook after all: read it as the text it is, from the offset asked for.
                return { output: (yield* read(result.target, true)).content, path: result.path, absolute, external }
              }
              return { output: result.content, path: result.path, absolute, external }
            }).pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  const content = toModelContent(result.path, input.offset, result.output)
                  const metadata = {
                    truncated: result.output.type === "file" ? false : result.output.truncated,
                    ...(result.output.type === "file" && result.output.dimensions
                      ? { image: result.output.dimensions }
                      : {}),
                  }
                  // Lists and media are never answered with a stub. Text is, when this range showed the same text before.
                  const repeatable =
                    typeof content === "string" &&
                    (result.output.type === "text-page" ||
                      (result.output.type === "file" && result.output.encoding === "utf8"))
                  const unchanged =
                    repeatable &&
                    (yield* ledger.markRead(
                      context.sessionID,
                      result.absolute,
                      `${input.offset ?? 1}:${input.limit ?? "default"}`,
                      createHash("sha256").update(content).digest("hex"),
                    ))
                  if (!unchanged) {
                    // The read has produced what the model gets, so the instruction files near it are due. An external
                    // read, a PDF and a failed read trigger nothing, and a repeat read answered with the stub brings
                    // nothing new. A failure to load them never fails the read.
                    if (!result.external && !(result.output.type === "file" && result.output.mime === "application/pdf"))
                      yield* triggers.touched({
                        sessionID: context.sessionID,
                        targets: [{ path: result.absolute, listing: result.output.type === "list-page" }],
                      })
                    return { output: result.output, content, metadata }
                  }
                  return {
                    output: result.output,
                    content: unchangedStub(result.path),
                    metadata: { truncated: false, unchanged: true },
                  }
                }),
              ),
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                if (error instanceof FileAccess.DeviceError)
                  return new ToolFailure({ message: error.message, code: Tool.ErrorCode.FileDevice, error })
                const message =
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

const parsePages = (value: string | undefined) => {
  if (value === undefined) return Effect.succeed(undefined)
  const range = Pdf.parseRange(value)
  if (!range)
    return Effect.fail(
      new ToolFailure({
        message: `"${value}" is not a usable pages value. Send one page number ("3") or two joined by a dash ("1-5"), counting from 1.`,
      }),
    )
  // The width comes from the numbers alone, before the PDF's page count is known; an open range is always too wide.
  if (range.last - range.first + 1 > Pdf.MAX_PAGES_PER_CALL)
    return Effect.fail(
      new ToolFailure({
        message: `The pages value "${value}" asks for more than ${Pdf.MAX_PAGES_PER_CALL} pages. One call returns at most ${Pdf.MAX_PAGES_PER_CALL}; ask for a smaller range.`,
      }),
    )
  return Effect.succeed({ first: PositiveInt.make(range.first), last: PositiveInt.make(range.last) })
}

/** The model text for a repeat read of a range whose text is the same as the one the model already holds. */
export const unchangedStub = (path: string) =>
  `Read file ${path}: this range has not changed since you last read it, so rely on the earlier result in this conversation.`

export const toModelContent = (path: string, offset: number | undefined, output: typeof Output.Type) => {
  if (output.type === "file" && output.encoding === "base64")
    return [
      {
        type: "text",
        text:
          output.mime !== "application/pdf"
            ? output.dimensions
              ? `Image read successfully (${output.dimensions.width}×${output.dimensions.height} px, ${output.mime})`
              : `Image read successfully (${output.mime})`
            : output.pages
              ? `Read ${path}, PDF pages ${output.pages.first}-${output.pages.last} of ${output.pages.total}`
              : `Read PDF ${path}`,
      },
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
