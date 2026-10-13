import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Environment } from "@orbit/core/environment/index"
import { AbsolutePath } from "@orbit/core/schema"
import { FileLedger } from "@orbit/core/file-ledger"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { Token } from "@orbit/core/util/token"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNodePlatform } from "@orbit/util/effect/app-node-platform"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { testEffect } from "./lib/effect"
import { makePdf } from "./lib/pdf"
import { frame, gif, jfif, jpeg, png, webpLossless } from "./lib/image-bytes"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem])))
const fixture = Effect.gen(function* () {
  const files = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const directory = yield* files.makeTempDirectoryScoped()
  return { environment: Environment.makeFiles(Environment.makeLocalDriver(spawner)), files, directory }
})
const absolute = (value: string) => AbsolutePath.make(value)
const readContent = (...args: Parameters<typeof ReadToolFileSystem.read>) =>
  ReadToolFileSystem.read(...args).pipe(Effect.map((result) => result.content))
// The estimate of the text a page becomes in the model's message, with its `N: ` prefixes.
const renderedTokens = (content: string, first: number) =>
  Token.estimate(
    content
      .split("\n")
      .map((line, index) => `${first + index}: ${line}`)
      .join("\n"),
  )

describe("ReadTool text serialization", () => {
  const cases = [
    {
      name: "preserves a selected trailing blank line before continuation",
      content: "alpha\n\nomega\n",
      page: { offset: 1, limit: 2 },
      output: { type: "text-page", content: "alpha\n", offset: 1, truncated: true, next: 3 },
      model:
        "Read file lines.txt, lines 1-2\n1: alpha\n2: \n[Output truncated: one read returns at most 2000 lines or about 25000 tokens. Continue reading with offset: 3, or use Grep to find specific content.]",
    },
    {
      name: "preserves multiple selected trailing blank lines at a noninitial offset",
      content: "before\nalpha\n\n\nomega\n",
      page: { offset: 2, limit: 3 },
      output: { type: "text-page", content: "alpha\n\n", offset: 2, truncated: true, next: 5 },
      model:
        "Read file lines.txt, lines 2-4\n2: alpha\n3: \n4: \n[Output truncated: one read returns at most 2000 lines or about 25000 tokens. Continue reading with offset: 5, or use Grep to find specific content.]",
    },
    {
      name: "preserves a selected trailing blank line at EOF",
      content: "alpha\n\n",
      page: { limit: 2 },
      output: { type: "text-page", content: "alpha\n", offset: 1, truncated: false },
      model: "Read file lines.txt, lines 1-2\n1: alpha\n2: ",
    },
    {
      name: "preserves internal blank lines in a page",
      content: "alpha\n\nomega\n",
      page: { limit: 3 },
      output: { type: "text-page", content: "alpha\n\nomega", offset: 1, truncated: false },
      model: "Read file lines.txt, lines 1-3\n1: alpha\n2: \n3: omega",
    },
    {
      name: "preserves continuation for a nonblank page",
      content: "alpha\n\nomega\n",
      page: { limit: 1 },
      output: { type: "text-page", content: "alpha", offset: 1, truncated: true, next: 2 },
      model:
        "Read file lines.txt, lines 1-1\n1: alpha\n[Output truncated: one read returns at most 2000 lines or about 25000 tokens. Continue reading with offset: 2, or use Grep to find specific content.]",
    },
    {
      name: "strips only the terminal file newline in a whole-file read",
      content: "alpha\n\n",
      page: {},
      output: { type: "file", content: "alpha\n\n", encoding: "utf8" },
      model: "Read file lines.txt, lines 1-2\n1: alpha\n2: ",
    },
    {
      name: "does not add a line for a whole-file terminal newline",
      content: "alpha\n",
      page: {},
      output: { type: "file", content: "alpha\n", encoding: "utf8" },
      model: "Read file lines.txt, lines 1-1\n1: alpha",
    },
    {
      name: "preserves a whole-file read without a terminal newline",
      content: "alpha",
      page: {},
      output: { type: "file", content: "alpha", encoding: "utf8" },
      model: "Read file lines.txt, lines 1-1\n1: alpha",
    },
    {
      name: "preserves empty whole-file output",
      content: "",
      page: {},
      output: { type: "file", content: "", encoding: "utf8" },
      model: "Read file lines.txt, 0 lines",
    },
    {
      name: "preserves empty-file page output",
      content: "",
      page: { limit: 2 },
      output: { type: "text-page", content: "", offset: 1, truncated: false },
      model: "Read file lines.txt, 0 lines",
    },
  ]

  cases.forEach((input) => {
    it.live(input.name, () =>
      Effect.gen(function* () {
        const current = yield* fixture
        const file = absolute(path.join(current.directory, "lines.txt"))
        yield* current.files.writeFileString(file, input.content)

        const result = yield* readContent(current.environment, file, "lines.txt", input.page)

        expect(result).toMatchObject(input.output)
        expect(ReadTool.toModelContent("lines.txt", undefined, result)).toBe(input.model)
      }),
    )
  })
})

describe("ReadToolFileSystem", () => {
  it.effect("preserves the environment not-found error", () =>
    Effect.gen(function* () {
      const { environment, directory } = yield* fixture
      const file = path.join(directory, "missing.txt")

      const error = yield* readContent(environment, absolute(file), "missing.txt").pipe(Effect.flip)

      expect(error).toBeInstanceOf(Environment.NotFound)
    }),
  )

  it.effect("returns a listing when read reports a directory", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      yield* files.makeDirectory(path.join(directory, "folder"))
      yield* files.writeFileString(path.join(directory, "file.txt"), "hello")

      const result = yield* readContent(environment, absolute(directory), "folder")

      expect(result).toMatchObject({
        type: "list-page",
        entries: [
          { path: `folder${path.sep}`, type: "directory" },
          { path: "file.txt", type: "file" },
        ],
      })
    }),
  )

  it.effect("reads malformed UTF-8 lossily and still rejects null-byte binary content", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const binary = path.join(directory, "archive.dat")
      const malformed = path.join(directory, "malformed.txt")
      yield* files.writeFile(binary, Uint8Array.of(0, 1, 2, 3))
      yield* files.writeFile(malformed, Uint8Array.of(0x68, 0x69, 0x80))

      const binaryError = yield* readContent(environment, absolute(binary), "archive.dat").pipe(Effect.flip)
      const malformedResult = yield* readContent(environment, absolute(malformed), "malformed.txt")

      expect(binaryError).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
      expect(binaryError.message).toBe("Cannot read binary file: archive.dat")
      expect(malformedResult).toMatchObject({ type: "file", content: "hi\uFFFD", encoding: "utf8" })
    }),
  )

  it.effect("reports the header size of a PNG, GIF, JPEG and WebP and none for a PDF, text or a zero width", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const cases = [
        { file: "a.png", bytes: png(30, 20), size: { width: 30, height: 20 } },
        { file: "a.gif", bytes: gif(40, 25), size: { width: 40, height: 25 } },
        { file: "a.jpg", bytes: jpeg(jfif(), frame(0xc0, 50, 35)), size: { width: 50, height: 35 } },
        { file: "a.webp", bytes: webpLossless(60, 45), size: { width: 60, height: 45 } },
        { file: "zero.png", bytes: png(0, 20), size: undefined },
      ]
      for (const item of cases) {
        yield* files.writeFile(path.join(directory, item.file), item.bytes)
        const result = yield* readContent(environment, absolute(path.join(directory, item.file)), item.file)
        if (result.type !== "file") throw new Error("expected a file")
        if (result.encoding !== "base64") throw new Error("expected base64")
        if (item.size) expect(result).toMatchObject({ dimensions: item.size })
        else expect(result).not.toHaveProperty("dimensions")
      }

      const pdf = path.join(directory, "doc.pdf")
      yield* files.writeFile(pdf, yield* Effect.promise(() => makePdf(12)))
      const whole = path.join(directory, "whole.pdf")
      yield* files.writeFile(whole, yield* Effect.promise(() => makePdf(1)))
      const text = path.join(directory, "note.txt")
      yield* files.writeFileString(text, "plain")
      const results = [
        yield* readContent(environment, absolute(pdf), "doc.pdf", { pages: { first: 1, last: 2 } }),
        yield* readContent(environment, absolute(whole), "whole.pdf"),
        yield* readContent(environment, absolute(text), "note.txt"),
      ]
      for (const result of results) expect(result).not.toHaveProperty("dimensions")
    }),
  )

  it.effect("reads text despite a binary-associated extension", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "notes.docx")
      yield* files.writeFileString(file, "plain text")

      const result = yield* readContent(environment, absolute(file), "notes.docx")

      expect(result).toMatchObject({ type: "file", content: "plain text", encoding: "utf8" })
    }),
  )

  it.effect("lists unresolved symlinks, including broken and escaping links", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const { environment, files, directory } = yield* fixture
      const outside = yield* files.makeTempDirectoryScoped()
      yield* files.makeDirectory(path.join(directory, "folder"))
      yield* files.writeFileString(path.join(directory, "file.txt"), "hello")
      yield* Effect.promise(() => fs.symlink(path.join(outside, "target.txt"), path.join(directory, "escape")))
      yield* Effect.promise(() => fs.symlink(path.join(directory, "missing.txt"), path.join(directory, "broken")))

      const result = yield* readContent(environment, absolute(directory), "folder")

      expect(result.type).toBe("list-page")
      if (result.type !== "list-page") return
      expect(result.entries.map((entry) => ({ ...entry, path: String(entry.path) }))).toEqual([
        { path: `folder${path.sep}`, type: "directory" },
        { path: "broken", type: "symlink" },
        { path: "escape", type: "symlink" },
        { path: "file.txt", type: "file" },
      ])
    }),
  )

  it.effect("reads a symlinked directory as a listing", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const { environment, files, directory } = yield* fixture
      const target = path.join(directory, "target")
      const link = path.join(directory, "link")
      yield* files.makeDirectory(target)
      yield* files.writeFileString(path.join(target, "file.txt"), "hello")
      yield* Effect.promise(() => fs.symlink(target, link))

      const result = yield* readContent(environment, absolute(link), "link")

      expect(result).toMatchObject({
        type: "list-page",
        entries: [{ path: "file.txt", type: "file" }],
      })
    }),
  )

  it.effect("reports out-of-range pagination as a typed error", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "short.txt")
      yield* files.writeFileString(file, "one\n")

      const error = yield* readContent(environment, absolute(file), "short.txt", { offset: 2 }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.OffsetOutOfRangeError)
      expect(error.message).toBe("Offset 2 is out of range for this file (1 line)")
    }),
  )

  it.effect("pages text with one-based offsets", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "lines.txt")
      yield* files.writeFileString(file, "one\r\ntwo\nthree")

      const result = yield* readContent(environment, absolute(file), "lines.txt", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({ type: "text-page", content: "two", offset: 2, truncated: true, next: 3 })
    }),
  )

  it.effect("truncates long lines", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "long.txt")
      yield* files.writeFileString(file, "a".repeat(2_001))

      const result = yield* readContent(environment, absolute(file), "long.txt", { limit: 1 })

      expect(result).toMatchObject({
        type: "text-page",
        content: `${"a".repeat(2_000)}... (line truncated to 2000 chars)`,
        truncated: false,
      })
    }),
  )

  it.effect("enforces line and byte budgets with continuation offsets", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const linesFile = path.join(directory, "many-lines.txt")
      const bytesFile = path.join(directory, "many-bytes.txt")
      yield* files.writeFileString(linesFile, Array.from({ length: 2_001 }, (_, index) => String(index)).join("\n"))
      yield* files.writeFileString(bytesFile, Array.from({ length: 200 }, () => "a".repeat(2_000)).join("\n"))
      const ranges: Array<{ readonly offset: number; readonly length: number } | undefined> = []
      const tracked = {
        ...environment,
        read: (path: string, range?: { readonly offset: number; readonly length: number }) =>
          Effect.sync(() => ranges.push(range)).pipe(Effect.andThen(environment.read(path, range))),
      }

      const lines = yield* readContent(environment, absolute(linesFile), "many-lines.txt", { limit: 2_000 })
      const bytes = yield* readContent(tracked, absolute(bytesFile), "many-bytes.txt", {})

      expect(lines).toMatchObject({ type: "text-page", truncated: true, next: 2_001 })
      expect(lines.type === "text-page" ? lines.content.split("\n") : []).toHaveLength(2_000)
      expect(bytes).toMatchObject({ type: "text-page", truncated: true, next: 50 })
      expect(bytes.type === "text-page" ? renderedTokens(bytes.content, 1) : Infinity).toBeLessThanOrEqual(
        ReadToolFileSystem.MAX_READ_TOKENS,
      )
      expect(ranges).toEqual([{ offset: 0, length: 256 * 1024 }])
    }),
  )

  it.effect("returns a file of 80-character lines whole when its rendered text fits the budget", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "wide.txt")
      // About 90 KB, which the former 50 KB cap paged.
      yield* files.writeFileString(file, Array.from({ length: 1_100 }, () => "w".repeat(80)).join("\n"))

      const result = yield* readContent(environment, absolute(file), "wide.txt")

      expect(result.type).toBe("file")
      expect(result.type === "file" ? result.content.split("\n") : []).toHaveLength(1_100)
    }),
  )

  it.effect("pages a file of more than 2,000 lines even when it fits the token budget", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "tiny.txt")
      // About 5 KB: far under the budget, over the line limit.
      yield* files.writeFileString(file, Array.from({ length: 2_500 }, () => "x").join("\n"))

      const result = yield* readContent(environment, absolute(file), "tiny.txt")

      expect(result).toMatchObject({ type: "text-page", offset: 1, truncated: true, next: 2_001 })
    }),
  )

  it.effect("pages a 95 KB file of short lines at 2,000 lines", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "short.txt")
      yield* files.writeFileString(
        file,
        Array.from({ length: 9_500 }, (_, index) => String(index).padStart(9, "0")).join("\n"),
      )

      const result = yield* readContent(environment, absolute(file), "short.txt")

      expect(result).toMatchObject({ type: "text-page", offset: 1, truncated: true, next: 2_001 })
      expect(result.type === "text-page" ? result.content.split("\n") : []).toHaveLength(2_000)
    }),
  )

  it.effect("pages a file whose rendered text passes the budget even under the line limit", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "dense.txt")
      // 1,300 lines of 80 characters render to about 29,000 tokens: fewer than 2,000 lines, over the budget.
      yield* files.writeFileString(file, Array.from({ length: 1_300 }, () => "d".repeat(80)).join("\n"))

      const result = yield* readContent(environment, absolute(file), "dense.txt")

      expect(result).toMatchObject({ type: "text-page", offset: 1, truncated: true })
      if (result.type !== "text-page" || result.next === undefined) throw new Error("expected a truncated page")
      expect(result.next).toBeLessThan(1_300)
      expect(renderedTokens(result.content, 1)).toBeLessThanOrEqual(ReadToolFileSystem.MAX_READ_TOKENS)
      expect(result.content.split("\n")).toHaveLength(result.next - 1)
    }),
  )

  it.effect("pages a 300 KB file with every rendered page under the budget and chained next offsets", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "big.txt")
      // Longer than the 256 KB first chunk, so pages after the first start in the middle of the file.
      yield* files.writeFileString(
        file,
        Array.from({ length: 3_000 }, (_, index) => `${index}${"x".repeat(97)}`).join("\n"),
      )

      const seen: string[] = []
      let offset: number | undefined
      for (let guard = 0; guard < 20; guard++) {
        const page: ReadToolFileSystem.PageInput = offset === undefined ? {} : { offset }
        const result = yield* readContent(environment, absolute(file), "big.txt", page)
        if (result.type !== "text-page") throw new Error("expected a page")
        expect(result.offset).toBe(offset ?? 1)
        expect(renderedTokens(result.content, result.offset)).toBeLessThanOrEqual(ReadToolFileSystem.MAX_READ_TOKENS)
        const lines = result.content.split("\n")
        seen.push(...lines)
        if (result.next === undefined) break
        expect(result.next).toBe(result.offset + lines.length)
        offset = result.next
      }

      expect(seen).toHaveLength(3_000)
      expect(seen[2_999]).toStartWith("2999")
    }),
  )

  it.effect("sorts and pages directory entries", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      yield* files.makeDirectory(path.join(directory, "z"))
      yield* files.makeDirectory(path.join(directory, "a"))
      yield* files.writeFileString(path.join(directory, "b.txt"), "")

      const result = yield* readContent(environment, absolute(directory), "folder", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({
        type: "list-page",
        entries: [{ path: `z${path.sep}`, type: "directory" }],
        truncated: true,
        next: 3,
      })
    }),
  )

  it.effect("stops checking for null bytes after the requested page", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "nul.txt")
      yield* files.writeFile(file, Uint8Array.from([...new TextEncoder().encode("one\n"), 0]))

      const result = yield* readContent(environment, absolute(file), "nul.txt", { limit: 1 })

      expect(result).toMatchObject({ type: "text-page", content: "one", truncated: true, next: 2 })
    }),
  )

  it.effect("checks skipped lines for null bytes", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "nul-prefix.txt")
      yield* files.writeFile(file, Uint8Array.from([...new TextEncoder().encode("one"), 0, 10, 116, 119, 111, 10]))

      const error = yield* readContent(environment, absolute(file), "nul-prefix.txt", {
        offset: 2,
        limit: 1,
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
    }),
  )

  it.effect("reads page two after fetching more than the first 256KB range", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "large.txt")
      yield* files.writeFileString(file, `${"a".repeat(300 * 1024)}\nsecond\n`)

      const result = yield* readContent(environment, absolute(file), "large.txt", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({ type: "text-page", content: "second", offset: 2, truncated: false })
    }),
  )

  it.effect("reads after a newline at the first chunk boundary", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "boundary.txt")
      yield* files.writeFileString(file, `${"a".repeat(256 * 1024 - 1)}\nsecond\n`)

      const result = yield* readContent(environment, absolute(file), "boundary.txt", {
        offset: 2,
        limit: 1,
      })

      expect(result).toMatchObject({ type: "text-page", content: "second", offset: 2, truncated: false })
    }),
  )

  it.effect("preserves the media ingestion limit message", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "oversized.png")
      yield* files.writeFile(file, Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
      yield* files.truncate(file, ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES + 1)

      const error = yield* readContent(environment, absolute(file), "oversized.png").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(error.message).toBe(
        `Media exceeds ${ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES} byte ingestion limit: oversized.png`,
      )
    }),
  )

  it.effect("reads PDFs as bounded media", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const file = path.join(directory, "document.pdf")
      const bytes = yield* Effect.promise(() => makePdf(2))
      yield* files.writeFile(file, bytes)

      const result = yield* readContent(environment, absolute(file), "document.pdf")

      expect(result).toMatchObject({
        type: "file",
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
        mime: "application/pdf",
      })
    }),
  )

  it.effect("reports what a read saw: the mtime always, the digest only when it held every byte", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      const small = path.join(directory, "small.txt")
      const pdf = path.join(directory, "document.pdf")
      const large = path.join(directory, "large.txt")
      yield* files.writeFileString(small, "one\ntwo\n")
      const pdfBytes = yield* Effect.promise(() => makePdf(1))
      yield* files.writeFile(pdf, pdfBytes)
      // Longer than the first chunk, so paging reads it piece by piece and never holds all of it at once.
      yield* files.writeFileString(large, "line\n".repeat(80_000))
      const digest = (text: string) => FileLedger.digest(new TextEncoder().encode(text))

      const whole = yield* ReadToolFileSystem.read(environment, absolute(small), "small.txt")
      const paged = yield* ReadToolFileSystem.read(environment, absolute(small), "small.txt", { offset: 2 })
      const media = yield* ReadToolFileSystem.read(environment, absolute(pdf), "document.pdf")
      const big = yield* ReadToolFileSystem.read(environment, absolute(large), "large.txt", { limit: 5 })
      const folder = yield* ReadToolFileSystem.read(environment, absolute(directory), "folder")

      expect(whole.seen?.digest).toBe(digest("one\ntwo\n"))
      expect(whole.seen?.mtimeMs).toBeGreaterThan(0)
      expect(paged.seen?.digest).toBe(digest("one\ntwo\n"))
      expect(media.seen?.digest).toBe(FileLedger.digest(pdfBytes))
      expect(big.seen?.mtimeMs).toBeGreaterThan(0)
      expect(big.seen).not.toHaveProperty("digest")
      expect(folder.seen).toBeUndefined()
    }),
  )
})

describe("ReadTool directory budget", () => {
  // The model text of a page, as the tool renders it: the header, one line per entry and the continuation note.
  const rendered = (resource: string, offset: number, page: ReadToolFileSystem.ListPage) => {
    const text = ReadTool.toModelContent(resource, offset, page)
    if (typeof text !== "string") throw new Error("expected text")
    return text
  }

  for (const [label, nameLength, pages] of [
    ["short names", 20, 1],
    ["long names", 120, undefined],
  ] as const)
    it.effect(`pages a folder of 2,000 entries with ${label} within the token budget, reaching each entry once`, () =>
      Effect.gen(function* () {
        const { environment, files, directory } = yield* fixture
        const names = Array.from({ length: 2_000 }, (_, index) => String(index).padStart(4, "0").padEnd(nameLength, "n"))
        yield* Effect.forEach(names, (name) => files.writeFileString(path.join(directory, name), ""), {
          concurrency: 32,
          discard: true,
        })

        const seen: string[] = []
        let offset = 1
        let count = 0
        for (let guard = 0; guard < 100; guard++) {
          const page = yield* readContent(environment, absolute(directory), directory, { offset })
          if (page.type !== "list-page") throw new Error("expected a list page")
          count++
          expect(Token.estimate(rendered(directory, offset, page))).toBeLessThanOrEqual(ReadToolFileSystem.MAX_READ_TOKENS)
          seen.push(...page.entries.map((entry) => entry.path))
          if (page.next === undefined) break
          expect(page.truncated).toBe(true)
          expect(page.next).toBe(offset + page.entries.length)
          offset = page.next
        }
        expect(seen).toEqual(names)
        if (pages !== undefined) expect(count).toBe(pages)
        else expect(count).toBeGreaterThan(1)
      }),
      60_000,
    )

  it.effect("keeps one entry on a page even when the heading alone passes the budget", () =>
    Effect.gen(function* () {
      const { environment, files, directory } = yield* fixture
      yield* Effect.forEach(["a", "b", "c"], (name) => files.writeFileString(path.join(directory, name), ""))
      // The heading names the path, so a path this long leaves no room for a second entry.
      const page = yield* readContent(environment, absolute(directory), "x".repeat(100_000), { offset: 1 })
      expect(page).toMatchObject({ type: "list-page", entries: [{ path: "a" }], truncated: true, next: 2 })
    }),
  )
})

describe("ReadTool a file with very long lines", () => {
  const script = path.join(import.meta.dir, "fixture", "read-long-line.ts")
  // A child process with a deadline: a quadratic loop blocks the event loop, so the test runner's own timeout never fires.
  const readInChild = (file: string, offset?: number, limit?: number) =>
    Effect.promise(async () => {
      const child = Bun.spawn([process.execPath, script, file, String(offset ?? "-"), String(limit ?? "-")], {
        cwd: path.resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 25_000,
        killSignal: "SIGKILL",
      })
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      await child.exited
      if (child.signalCode) throw new Error(`the read did not finish within its deadline (${child.signalCode}): ${err}`)
      return JSON.parse(out.trim().split("\n").at(-1) ?? "") as {
        outcome: { type?: string; content?: string; length?: number; next?: number; error?: string }
        ms: number
        maxRssMb: number
      }
    })

  const mib = 1024 * 1024
  const line = (size: number, fill = 97) => Buffer.alloc(size, fill)
  const rows = [
    {
      name: "one line of 64 MiB with no line break",
      bytes: () => line(64 * mib),
      page: [] as const,
      expected: { type: "text-page", length: 2_000 + `... (line truncated to 2000 chars)`.length },
    },
    {
      name: "a 64 MiB first line, read from the line after it",
      bytes: () => Buffer.concat([line(64 * mib), Buffer.from("\nsecond\nthird\n")]),
      page: [2, 1] as const,
      expected: { type: "text-page", length: "second".length, next: 3 },
    },
    {
      name: "a NUL inside the part of a 64 MiB line that is not kept",
      bytes: () => Buffer.concat([line(2 * mib), Buffer.of(0), line(62 * mib)]),
      page: [] as const,
      expected: { error: "ReadTool.BinaryFileError" },
    },
  ]
  for (const row of rows)
    it.effect(`reads ${row.name} in bounded time and memory`, () =>
      Effect.gen(function* () {
        const { files, directory } = yield* fixture
        const file = path.join(directory, "long-line.txt")
        yield* files.writeFile(file, row.bytes())

        const result = yield* readInChild(file, row.page[0], row.page[1])

        expect(result.outcome).toMatchObject(row.expected)
        // Unfixed, 64 MiB took 30 s and 1 GiB; kept lines are bounded now.
        expect(result.maxRssMb).toBeLessThan(450)
      }),
      60_000,
    )
})
