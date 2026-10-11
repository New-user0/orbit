export * as ReadToolFileSystem from "./read-filesystem.js"

import path from "path"
import { pathToFileURL } from "url"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { lookup } from "mime-types"
import { Environment } from "../environment/index.js"
import { FileLedger } from "../file-ledger.js"
import type { Files } from "../environment/index.js"
import { FileSystem } from "../filesystem.js"
import { Mime } from "../mime.js"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath } from "../schema.js"
import { Token } from "../util/token.js"
import { Pdf } from "./pdf.js"

export const MAX_READ_LINES = 2_000
/** What one read may render for the model, estimated as `Token.estimate` does, line numbers included. */
export const MAX_READ_TOKENS = 25_000
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
/** A PDF is read whole to count and cut its pages, so its source stays below the process driver's 64 MiB read cap. */
export const MAX_PDF_SOURCE_BYTES = 32 * 1024 * 1024
const FIRST_CHUNK = 256 * 1024
const MAX_LINE_LENGTH = 2_000
const TREE_BASE = 6
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

/** The characters a line takes in the model text: its `N: ` prefix, the line and the newline after it. */
export const renderedLength = (line: number, text: string) => String(line).length + 3 + text.length
export const withinBudget = (characters: number) => Token.estimateLength(characters) <= MAX_READ_TOKENS
export const MEDIA_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])

export class BinaryFileError extends Schema.TaggedError<BinaryFileError>()("ReadTool.BinaryFileError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Cannot read binary file: ${this.resource}`
  }
}

export class MediaIngestLimitError extends Schema.TaggedError<MediaIngestLimitError>()(
  "ReadTool.MediaIngestLimitError",
  {
    resource: Schema.String,
    maximumBytes: Schema.Number,
    advice: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return `Media exceeds ${this.maximumBytes} byte ingestion limit: ${this.resource}${this.advice === undefined ? "" : `. ${this.advice}`}`
  }
}

export class PdfPagesRequiredError extends Schema.TaggedError<PdfPagesRequiredError>()(
  "ReadTool.PdfPagesRequiredError",
  { resource: Schema.String, pages: Schema.Number },
) {
  override get message() {
    return `${this.resource} runs to ${this.pages} pages, and Read opens a PDF whole only up to ${Pdf.MAX_WHOLE_PAGES}. Call Read again with a pages range (for instance "1-8"); a single call covers at most ${Pdf.MAX_PAGES_PER_CALL} pages.`
  }
}

export class PdfPageRangeError extends Schema.TaggedError<PdfPageRangeError>()("ReadTool.PdfPageRangeError", {
  resource: Schema.String,
  first: Schema.Number,
  total: Schema.Number,
}) {
  override get message() {
    return `Page ${this.first} is past the end of this PDF, which has ${this.total} ${this.total === 1 ? "page" : "pages"}: ${this.resource}`
  }
}

export class PdfSourceError extends Schema.TaggedError<PdfSourceError>()("ReadTool.PdfSourceError", {
  resource: Schema.String,
}) {
  override get message() {
    return `The PDF could not be read in full: ${this.resource}`
  }
}

export class OffsetOutOfRangeError extends Schema.TaggedError<OffsetOutOfRangeError>()(
  "ReadTool.OffsetOutOfRangeError",
  { offset: Schema.Number, lines: Schema.Number },
) {
  override get message() {
    return `Offset ${this.offset} is out of range for this file (${this.lines} ${this.lines === 1 ? "line" : "lines"})`
  }
}

export class PathKindError extends Schema.TaggedError<PathKindError>()("ReadTool.PathKindError", {
  resource: Schema.String,
  expected: Schema.Literals(["a file", "a file or directory"]),
}) {
  override get message() {
    return `Path is not ${this.expected}: ${this.resource}`
  }
}

export type ReadError =
  | Environment.NotFound
  | Environment.Failed
  | BinaryFileError
  | MediaIngestLimitError
  | PdfPagesRequiredError
  | PdfPageRangeError
  | PdfSourceError
  | Pdf.Error
  | OffsetOutOfRangeError
  | PathKindError

export const PageInput = Schema.Struct({
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(NonNegativeInt),
  // Applies to PDFs only and is parsed by the caller; other files ignore it.
  pages: Schema.optionalKey(Schema.Struct({ first: PositiveInt, last: PositiveInt })),
})
export type PageInput = typeof PageInput.Type

export const FileContent = Schema.Struct({
  type: Schema.Literal("file"),
  ...FileSystem.Content.fields,
  /** For a PDF read by range: the pages returned and how many the source has. */
  pages: Schema.optionalKey(Schema.Struct({ first: PositiveInt, last: PositiveInt, total: PositiveInt })),
  /** For an image: the pixel size its header declares. Absent when the header gives none. */
  dimensions: Schema.optionalKey(Schema.Struct({ width: PositiveInt, height: PositiveInt })),
}).annotate({ identifier: "ReadTool.FileContent" })
export type FileContent = typeof FileContent.Type

export class TextPage extends Schema.Class<TextPage>("ReadTool.TextPage")({
  type: Schema.Literal("text-page"),
  content: Schema.String,
  mime: Schema.String,
  offset: PositiveInt,
  truncated: Schema.Boolean,
  next: Schema.optionalKey(PositiveInt),
}) {}

export interface ListEntry extends Schema.Schema.Type<typeof ListEntry> {}
export const ListEntry = Schema.Struct({
  path: RelativePath,
  type: Schema.Literals(["file", "directory", "symlink"]),
}).annotate({ identifier: "ReadTool.ListEntry" })

export class ListPage extends Schema.Class<ListPage>("ReadTool.ListPage")({
  type: Schema.Literal("list-page"),
  entries: Schema.Array(ListEntry),
  truncated: Schema.Boolean,
  next: Schema.optionalKey(PositiveInt),
}) {}

/** What a read returned, and what it saw of the file (nothing for a directory) for the FileLedger. */
export interface ReadResult {
  readonly content: FileContent | TextPage | ListPage
  readonly seen?: FileLedger.Seen
}

export interface Interface {
  readonly list: (path: AbsolutePath) => ReturnType<Files["list"]>
  readonly read: (path: AbsolutePath, resource: string, page?: PageInput) => Effect.Effect<ReadResult, ReadError>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ReadToolFileSystem") {}

const mimeType = (value: string) => lookup(value) || "application/octet-stream"

export const read = Effect.fn("ReadTool.read")(function* (
  files: Files,
  input: AbsolutePath,
  resource: string,
  page: PageInput = {},
) {
  const first = yield* files.read(input, { offset: 0, length: FIRST_CHUNK }).pipe(
    Effect.catchTag("Environment.WrongKind", (error) => {
      if (error.actual !== "directory")
        return Effect.fail(new PathKindError({ resource, expected: "a file or directory" }))
      return files.list(input).pipe(
        Effect.map((entries) => list(entries, page)),
        Effect.catchTag("Environment.WrongKind", () =>
          Effect.fail(new PathKindError({ resource, expected: "a file or directory" })),
        ),
      )
    }),
  )
  if (first instanceof ListPage) return { content: first } satisfies ReadResult

  const media = Mime.detect(first.bytes)
  if (media === "application/pdf") return yield* readPdf(files, first.info.size, input, resource, page)
  if (MEDIA_MIMES.has(media)) {
    if (first.info.size > MAX_MEDIA_INGEST_BYTES)
      return yield* new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES })
    const whole = yield* readFile(files, input, resource)
    const dimensions = Mime.dimensions(whole.bytes, media)
    return {
      content: {
        type: "file" as const,
        uri: pathToFileURL(input).href,
        name: path.basename(input),
        content: Buffer.from(whole.bytes).toString("base64"),
        encoding: "base64" as const,
        mime: media,
        ...(dimensions ? { dimensions } : {}),
      },
      seen: { mtimeMs: whole.info.mtimeMs, digest: FileLedger.digest(whole.bytes) },
    } satisfies ReadResult
  }

  const content = yield* readText(files, first, input, resource, page)
  // The digest covers the raw bytes and exists only when the first chunk held the whole file: hashing more would mean
  // reading the rest of a large file on every paged read.
  return {
    content,
    seen: {
      mtimeMs: first.info.mtimeMs,
      ...(first.bytes.length >= first.info.size ? { digest: FileLedger.digest(first.bytes) } : {}),
    },
  } satisfies ReadResult
})

// A PDF is read whole to count its pages (the count decides whether a whole read is allowed) and to cut a range from it.
const readPdf = Effect.fn("ReadTool.readPdf")(function* (
  files: Files,
  size: number,
  input: AbsolutePath,
  resource: string,
  page: PageInput,
) {
  if (size > MAX_PDF_SOURCE_BYTES)
    return yield* new MediaIngestLimitError({ resource, maximumBytes: MAX_PDF_SOURCE_BYTES })
  const whole = yield* readFile(files, input, resource).pipe(
    Effect.catchTag("Environment.Failed", () => Effect.fail(new PdfSourceError({ resource }))),
  )
  const total = yield* Pdf.pageCount(whole.bytes, resource)
  const seen = { mtimeMs: whole.info.mtimeMs, digest: FileLedger.digest(whole.bytes) }
  const result = (bytes: Uint8Array, pages?: { first: number; last: number }) =>
    ({
      content: {
        type: "file" as const,
        uri: pathToFileURL(input).href,
        name: path.basename(input),
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64" as const,
        mime: "application/pdf",
        ...(pages ? { pages: { first: pages.first, last: pages.last, total } } : {}),
      },
      seen,
    }) satisfies ReadResult

  if (page.pages === undefined) {
    if (total > Pdf.MAX_WHOLE_PAGES) return yield* new PdfPagesRequiredError({ resource, pages: total })
    if (whole.bytes.length > MAX_MEDIA_INGEST_BYTES)
      return yield* new MediaIngestLimitError({
        resource,
        maximumBytes: MAX_MEDIA_INGEST_BYTES,
        advice: "Read part of it with the pages argument",
      })
    return result(whole.bytes)
  }
  if (page.pages.first > total) return yield* new PdfPageRangeError({ resource, first: page.pages.first, total })
  const last = Math.min(page.pages.last, total)
  const bytes = yield* Pdf.extract(whole.bytes, resource, page.pages.first, last)
  if (bytes.length > MAX_MEDIA_INGEST_BYTES)
    return yield* new MediaIngestLimitError({
      resource,
      maximumBytes: MAX_MEDIA_INGEST_BYTES,
      advice: "Ask for fewer pages",
    })
  return result(bytes, { first: page.pages.first, last })
})

const readText = Effect.fn("ReadTool.readText")(function* (
  files: Files,
  first: Effect.Success<ReturnType<Files["read"]>>,
  input: AbsolutePath,
  resource: string,
  page: PageInput,
) {
  // The whole file comes back only when the first chunk holds it, it is no longer than a page, and its rendered text
  // fits the budget; anything else pages from the first line, with the next offset to continue from.
  const whole =
    page.offset === undefined && page.limit === undefined && first.bytes.length >= first.info.size
      ? wholeFile(first.bytes)
      : undefined
  if (whole !== undefined) {
    if (first.bytes.includes(0)) return yield* new BinaryFileError({ resource })
    return {
      type: "file" as const,
      uri: pathToFileURL(input).href,
      name: path.basename(input),
      content: whole,
      encoding: "utf8" as const,
      mime: mimeType(input),
    }
  }

  if (first.bytes.length >= first.info.size) {
    const result = textPage(first.bytes, true, page)
    if (result === undefined) return yield* Effect.die("Read page did not settle for a complete first chunk")
    return yield* makeTextPage(
      input,
      resource,
      result,
      first.bytes.subarray(0, result.consumed).includes(0),
      lineCount(textLeaf(first.bytes).summary.lines, first.bytes.at(-1)),
    )
  }

  const offset = page.offset || 1
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  const leaves = [textLeaf(first.bytes)]
  let bytes = first.bytes.length
  let lines = leaves[0].summary.lines
  let ended = false
  while (true) {
    const eof = ended || bytes >= first.info.size
    if (lines >= offset - 1 || eof) {
      const tree = textTree(leaves)
      const start = textOffset(tree, offset - 1)
      let position = 0
      const selected = Buffer.concat(
        leaves.flatMap((leaf) => {
          const leafStart = position
          position += leaf.summary.bytes
          if (position <= start) return []
          return [leaf.bytes.subarray(Math.max(0, start - leafStart))]
        }),
      )
      const result = textPage(selected, eof, { limit }, offset)
      if (result !== undefined) {
        const translated = {
          ...result,
          offset,
          ...(result.next === undefined ? { next: undefined } : { next: offset + result.next - 1 }),
        }
        const consumed = start + result.consumed
        let checked = 0
        const binary = leaves.some((leaf) => {
          const length = Math.min(leaf.summary.bytes, consumed - checked)
          checked += leaf.summary.bytes
          return length > 0 && leaf.bytes.subarray(0, length).includes(0)
        })
        return yield* makeTextPage(input, resource, translated, binary, lineCount(lines, leaves.at(-1)?.bytes.at(-1)))
      }
    }

    const next = yield* readFile(files, input, resource, { offset: bytes, length: FIRST_CHUNK })
    if (next.bytes.length === 0) {
      ended = true
      continue
    }
    const leaf = textLeaf(next.bytes)
    leaves.push(leaf)
    bytes += leaf.summary.bytes
    lines += leaf.summary.lines
  }
})

// The clamped text of a file that fits one read, or undefined when it needs paging.
const wholeFile = (bytes: Uint8Array) => {
  const lines = new TextDecoder().decode(bytes).split("\n")
  const count = lines.at(-1) === "" ? lines.length - 1 : lines.length
  if (count > MAX_READ_LINES) return
  const clamped = lines.map(clampLine)
  const characters = clamped.slice(0, count).reduce((total, line, index) => total + renderedLength(index + 1, line), 0)
  return withinBudget(characters) ? clamped.join("\n") : undefined
}

const readFile = (
  files: Files,
  input: AbsolutePath,
  resource: string,
  range?: { readonly offset: number; readonly length: number },
) =>
  files
    .read(input, range)
    .pipe(
      Effect.catchTag("Environment.WrongKind", () => Effect.fail(new PathKindError({ resource, expected: "a file" }))),
    )

const makeTextPage = Effect.fnUntraced(function* (
  input: AbsolutePath,
  resource: string,
  result: NonNullable<ReturnType<typeof textPage>>,
  binary: boolean,
  lines: number,
) {
  if (binary) return yield* new BinaryFileError({ resource })
  if (result.entries.length === 0 && result.offset !== 1)
    return yield* new OffsetOutOfRangeError({ offset: result.offset, lines })
  return new TextPage({
    type: "text-page",
    content: result.entries.join("\n"),
    mime: mimeType(input),
    offset: result.offset,
    truncated: result.next !== undefined,
    ...(result.next === undefined ? {} : { next: result.next }),
  })
})

const list = (items: ReadonlyArray<Environment.DirEntry>, page: PageInput) => {
  const offset = page.offset || 1
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  const visible = items
    .flatMap((item) =>
      item.type === "other"
        ? []
        : [
            ListEntry.make({
              path: RelativePath.make(item.name + (item.type === "directory" ? path.sep : "")),
              type: item.type,
            }),
          ],
    )
    .sort((a, b) =>
      a.type === "directory"
        ? b.type === "directory"
          ? a.path.localeCompare(b.path)
          : -1
        : b.type === "directory"
          ? 1
          : a.path.localeCompare(b.path),
    )
  const selected = visible.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + selected.length < visible.length
  return new ListPage({
    type: "list-page",
    entries: selected,
    truncated,
    ...(truncated ? { next: offset + selected.length } : {}),
  })
}

// `origin` is the file's number for the line that `offset` selects, when `bytes` start later than the file does.
const textPage = (bytes: Uint8Array, eof: boolean, page: PageInput, origin = page.offset || 1) => {
  const offset = page.offset || 1
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  const decoded = new TextDecoder().decode(bytes)
  const split = decoded.split("\n")
  const complete = eof ? (split.at(-1) === "" ? split.slice(0, -1) : split) : split.slice(0, -1)
  const available = complete.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))

  const entries: string[] = []
  let size = 0
  let next: number | undefined
  for (const [index, value] of available.slice(offset - 1).entries()) {
    const line = offset + index
    if (entries.length >= limit) {
      next = line
      break
    }
    const text = clampLine(value)
    const lineSize = renderedLength(origin + index, text)
    // A page always holds a line, so one long line never stops a read from moving on.
    if (entries.length > 0 && !withinBudget(size + lineSize)) {
      next = line
      break
    }
    entries.push(text)
    size += lineSize
  }
  if (next === undefined && entries.length >= limit && (!eof || offset - 1 + entries.length < available.length))
    next = offset + entries.length
  if (!eof && next === undefined) return

  const consumedLines = next === undefined ? available.length : next - 1
  const consumed = consumedLines === 0 ? 0 : (nthNewline(bytes, consumedLines) ?? bytes.length)
  return { entries, offset, next, consumed }
}

export const clampLine = (line: string) =>
  line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line

// A trailing newline ends the last line instead of starting an empty one.
const lineCount = (newlines: number, last: number | undefined) => newlines + (last === undefined || last === 10 ? 0 : 1)

type TextSummary = { readonly bytes: number; readonly lines: number }
// Request-local augmented rope. Subtree byte and newline weights locate a line
// like an order-statistic query without repeatedly decoding the accumulated text.
// https://doi.org/10.1002/spe.4380251203
type TextNode =
  | { readonly type: "leaf"; readonly bytes: Uint8Array; readonly summary: TextSummary }
  | { readonly type: "branch"; readonly children: ReadonlyArray<TextNode>; readonly summary: TextSummary }

const textLeaf = (bytes: Uint8Array): Extract<TextNode, { readonly type: "leaf" }> => {
  let lines = 0
  for (const byte of bytes) if (byte === 10) lines++
  return { type: "leaf", bytes, summary: { bytes: bytes.length, lines } }
}

const textTree = (nodes: ReadonlyArray<TextNode>): TextNode => {
  if (nodes.length === 1) return nodes[0]
  return textTree(
    Array.from({ length: Math.ceil(nodes.length / (TREE_BASE * 2)) }, (_, index) => {
      const children = nodes.slice(index * TREE_BASE * 2, (index + 1) * TREE_BASE * 2)
      return {
        type: "branch" as const,
        children,
        summary: {
          bytes: children.reduce((total, child) => total + child.summary.bytes, 0),
          lines: children.reduce((total, child) => total + child.summary.lines, 0),
        },
      }
    }),
  )
}

const textOffset = (tree: TextNode, newline: number) => {
  if (newline === 0) return 0
  let node = tree
  let remaining = newline
  let offset = 0
  while (node.type === "branch") {
    const child = node.children.find((candidate) => {
      if (remaining <= candidate.summary.lines) return true
      remaining -= candidate.summary.lines
      offset += candidate.summary.bytes
      return false
    })
    if (!child) return tree.summary.bytes
    node = child
  }
  const end = nthNewline(node.bytes, remaining)
  return end === undefined ? tree.summary.bytes : offset + end
}

const nthNewline = (bytes: Uint8Array, count: number) => {
  let found = 0
  for (const [index, byte] of bytes.entries()) {
    if (byte !== 10) continue
    found++
    if (found === count) return index + 1
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    return Service.of({
      list: environment.files.list,
      read: (path, resource, page) => read(environment.files, path, resource, page),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node] })
