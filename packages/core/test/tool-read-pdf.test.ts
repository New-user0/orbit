import { describe, expect, test } from "bun:test"
import path from "path"
import { Environment } from "@orbit/core/environment/index"
import { AbsolutePath, PositiveInt } from "@orbit/core/schema"
import { Pdf } from "@orbit/core/tool/pdf"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNodePlatform } from "@orbit/util/effect/app-node-platform"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib"
import { testEffect } from "./lib/effect"
import fs from "node:fs/promises"
import os from "node:os"
import { encryptedPdf, heavyPagePdf, makePdf, pageTreePdf, pageWidth, rawPdf, strayInvalidObjectPdf, widths } from "./lib/pdf"

const fixtureFile = (name: string) => path.join(import.meta.dir, "fixture", name)

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem])))
const fixture = Effect.gen(function* () {
  const files = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const directory = yield* files.makeTempDirectoryScoped()
  const environment = Environment.makeFiles(Environment.makeLocalDriver(spawner))
  const put = (name: string, bytes: Uint8Array | string) =>
    (typeof bytes === "string" ? files.writeFileString(path.join(directory, name), bytes) : files.writeFile(path.join(directory, name), bytes)).pipe(
      Effect.as(AbsolutePath.make(path.join(directory, name))),
    )
  const read = (name: string, page: ReadToolFileSystem.PageInput = {}) =>
    ReadToolFileSystem.read(environment, AbsolutePath.make(path.join(directory, name)), name, page).pipe(
      Effect.map((result) => result.content),
    )
  return { environment, put, read }
})
const decode = (content: ReadToolFileSystem.ReadResult["content"]) =>
  content.type === "file" ? new Uint8Array(Buffer.from(content.content, "base64")) : new Uint8Array()
const range = (first: number, last = first) => ({ pages: { first: PositiveInt.make(first), last: PositiveInt.make(last) } })
const MiB = 1024 * 1024

describe("Pdf.parseRange", () => {
  const cases: ReadonlyArray<readonly [string, { first: number; last: number } | undefined]> = [
    ["3", { first: 3, last: 3 }],
    ["1-5", { first: 1, last: 5 }],
    [" 3-7 ", { first: 3, last: 7 }],
    ["5-5", { first: 5, last: 5 }],
    ["4-", { first: 4, last: Infinity }],
    ["20-20", { first: 20, last: 20 }],
    ["9007199254740991-9007199254740993", undefined],
    ["9007199254740991-", { first: 9007199254740991, last: Infinity }],
    ["", undefined],
    ["   ", undefined],
    ["0", undefined],
    ["0-3", undefined],
    ["-5", undefined],
    ["5-3", undefined],
    ["3abc", undefined],
    ["1.5", undefined],
    ["1-5x", undefined],
    ["1 - 5", undefined],
    ["abc", undefined],
    ["1-2-3", undefined],
    ["99999999999999999999", undefined],
  ]
  test.each(cases)("%j", (text, expected) => {
    expect(Pdf.parseRange(text)).toEqual(expected)
  })
})

describe("ReadTool PDFs", () => {
  it.effect("returns a short PDF whole, byte for byte, with or without a range inside the threshold", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      const bytes = yield* Effect.promise(() => makePdf(5))
      yield* put("five.pdf", bytes)

      const whole = yield* read("five.pdf")
      expect(whole).toMatchObject({ type: "file", mime: "application/pdf", encoding: "base64" })
      expect(whole).not.toHaveProperty("pages")
      expect(decode(whole)).toEqual(bytes)

      const two = yield* read("five.pdf", range(2))
      expect(yield* Effect.promise(() => widths(decode(two)))).toEqual([pageWidth(2)])
    }),
  )

  it.effect("reads exactly 10 pages whole and refuses 11 and 15, naming the count", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("ten.pdf", yield* Effect.promise(() => makePdf(10)))
      yield* put("eleven.pdf", yield* Effect.promise(() => makePdf(11)))
      yield* put("fifteen.pdf", yield* Effect.promise(() => makePdf(15)))

      expect(yield* read("ten.pdf")).toMatchObject({ mime: "application/pdf" })
      const eleven = yield* read("eleven.pdf").pipe(Effect.flip)
      expect(eleven).toBeInstanceOf(ReadToolFileSystem.PdfPagesRequiredError)
      expect(eleven).toMatchObject({ pages: 11, resource: "eleven.pdf" })
      expect(eleven.message).toContain("runs to 11 pages")
      expect((yield* read("fifteen.pdf").pipe(Effect.flip)).message).toContain("runs to 15 pages")
    }),
  )

  it.effect("cuts the requested pages out of the source, in order", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("fifteen.pdf", yield* Effect.promise(() => makePdf(15)))

      const cases = [
        { page: range(3, 7), widths: [3, 4, 5, 6, 7], reported: { first: 3, last: 7, total: 15 } },
        { page: range(5), widths: [5], reported: { first: 5, last: 5, total: 15 } },
        // The last page is clamped to the document, and the report says so.
        { page: range(12, 20), widths: [12, 13, 14, 15], reported: { first: 12, last: 15, total: 15 } },
        { page: range(15, 15), widths: [15], reported: { first: 15, last: 15, total: 15 } },
      ]
      for (const item of cases) {
        const content = yield* read("fifteen.pdf", item.page)
        expect(content).toMatchObject({ mime: "application/pdf", pages: item.reported })
        expect(yield* Effect.promise(() => widths(decode(content)))).toEqual(item.widths.map(pageWidth))
      }
    }),
  )

  it.effect("fails with the first page and the total when the start is past the end", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("fifteen.pdf", yield* Effect.promise(() => makePdf(15)))

      for (const first of [16, 40]) {
        const error = yield* read("fifteen.pdf", range(first, first + 4)).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ReadToolFileSystem.PdfPageRangeError)
        expect(error).toMatchObject({ first, total: 15 })
        expect(error.message).toContain(`Page ${first}`)
        expect(error.message).toContain("15 pages")
      }
    }),
  )

  it.effect("checks the page count before the 20 MiB send cap, and lets a range reach a large short PDF", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("many.pdf", yield* Effect.promise(() => makePdf(15, 21 * MiB)))
      yield* put("few.pdf", yield* Effect.promise(() => makePdf(5, 21 * MiB)))

      expect(yield* read("many.pdf").pipe(Effect.flip)).toBeInstanceOf(ReadToolFileSystem.PdfPagesRequiredError)
      const large = yield* read("few.pdf").pipe(Effect.flip)
      expect(large).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(large).toMatchObject({ maximumBytes: ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES })
      expect(large.message).toContain("pages argument")

      const part = yield* read("few.pdf", range(1))
      expect(decode(part).length).toBeLessThan(MiB)
      expect(yield* Effect.promise(() => widths(decode(part)))).toEqual([pageWidth(1)])
    }),
  )

  it.effect("refuses a cut above 20 MiB even when its source is under the source cap", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("heavy.pdf", yield* Effect.promise(() => heavyPagePdf(21 * MiB)))

      const error = yield* read("heavy.pdf", range(1)).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(error).toMatchObject({ maximumBytes: ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES })
      expect(error.message).toContain("fewer pages")
    }),
  )

  it.effect("refuses a source above 32 MiB before reading it whole", () =>
    Effect.gen(function* () {
      const { environment, put } = yield* fixture
      const file = yield* put("huge.pdf", yield* Effect.promise(() => makePdf(1, 33 * MiB)))
      let wholeReads = 0
      const watched = {
        ...environment,
        read: (...args: Parameters<typeof environment.read>) => {
          if (args[1] === undefined) wholeReads++
          return environment.read(...args)
        },
      } as typeof environment

      const error = yield* ReadToolFileSystem.read(watched, file, "huge.pdf", range(1)).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(error).toMatchObject({ maximumBytes: ReadToolFileSystem.MAX_PDF_SOURCE_BYTES })
      expect(wholeReads).toBe(0)
    }),
  )

  it.effect("maps a failed whole read to a readable PDF error", () =>
    Effect.gen(function* () {
      const { environment, put } = yield* fixture
      const file = yield* put("grew.pdf", yield* Effect.promise(() => makePdf(2)))
      const failing = {
        ...environment,
        read: (...args: Parameters<typeof environment.read>) =>
          args[1] === undefined
            ? Effect.fail(new Environment.Failed({ path: file, cause: "output exceeded the cap" }))
            : environment.read(...args),
      } as typeof environment

      const error = yield* ReadToolFileSystem.read(failing, file, "grew.pdf").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.PdfSourceError)
      expect(error.message).toBe("The PDF could not be read in full: grew.pdf")
    }),
  )

  it.effect("fails closed on a corrupt PDF with and without a range, without echoing the file", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("broken.pdf", "%PDF-1.7\nSECRET-TOKEN this is not a document")

      for (const page of [{}, range(1)]) {
        const error = yield* read("broken.pdf", page).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Pdf.Error)
        expect(error).toMatchObject({ reason: "corrupt" })
        expect(error.message).toBe("Cannot read broken.pdf: the file is not a well-formed PDF.")
      }
    }),
  )

  it.effect("refuses an encrypted PDF with and without a range", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("locked.pdf", encryptedPdf())

      for (const page of [{}, range(1)]) {
        const error = yield* read("locked.pdf", page).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Pdf.Error)
        expect(error).toMatchObject({ reason: "encrypted" })
        expect(error.message).toContain("is encrypted")
      }
    }),
  )

  it.effect("ignores a range on files that are not PDFs, and detects PDFs by content", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      yield* put("notes.txt", "one\ntwo\nthree\n")
      yield* put("fake.pdf", "just text\n")
      yield* put("real.bin", yield* Effect.promise(() => makePdf(2)))

      expect(yield* read("notes.txt", range(2))).toEqual(yield* read("notes.txt"))
      expect(yield* read("fake.pdf", range(1))).toMatchObject({ encoding: "utf8", content: "just text\n" })
      expect(yield* read("real.bin")).toMatchObject({ mime: "application/pdf", encoding: "base64" })
    }),
  )

  it.effect("ignores offset and limit for a PDF", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      const bytes = yield* Effect.promise(() => makePdf(3))
      yield* put("three.pdf", bytes)

      expect(decode((yield* read("three.pdf", { offset: 2, limit: 1 })))).toEqual(bytes)
    }),
  )
})

describe("PDF content is never evaluated", () => {
  // A script action and a font-program-shaped stream that would write a marker file if anything evaluated them. The
  // control runs the same script through `new Function`, which shows that the marker mechanism works here.
  it.effect("writes no marker when a hostile PDF is read whole or by range", () =>
    Effect.gen(function* () {
      const { put, read } = yield* fixture
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const marker = path.join(directory, "marker.txt")
      const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, "evaluated")`
      const bytes = yield* Effect.promise(async () => {
        const document = await PDFDocument.create({ updateMetadata: false })
        document.addPage([100, 100])
        const action = document.context.obj({ S: "JavaScript", JS: PDFHexString.fromText(script) })
        const reference = document.context.register(action)
        document.catalog.set(PDFName.of("OpenAction"), reference)
        const [page] = document.getPages()
        page.node.set(
          PDFName.of("AA"),
          document.context.obj({ O: document.context.obj({ S: "JavaScript", JS: PDFString.of(script) }) }),
        )
        document.context.register(document.context.stream(script, { Type: "FontFile3", Subtype: "Type1C" }))
        return new Uint8Array(await document.save())
      })
      yield* put("hostile.pdf", bytes)

      const whole = yield* read("hostile.pdf")
      const part = yield* read("hostile.pdf", range(1))

      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      // The copied page carries no script from the source.
      const copy = yield* Effect.promise(() => PDFDocument.load(decode(part)))
      expect(copy.catalog.get(PDFName.of("OpenAction"))).toBeUndefined()
      expect(Buffer.from(decode(part)).includes("JavaScript")).toBe(false)
      expect(decode(whole)).toEqual(bytes)

      new Function("require", script)(require)
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(true)
    }),
  )
})

describe("Pdf.extract", () => {
  test("stamps no producer or date, and gives the same bytes every run", async () => {
    const source = await makePdf(4)
    const first = await Effect.runPromise(Pdf.extract(source, "a.pdf", 2, 3))
    const second = await Effect.runPromise(Pdf.extract(source, "a.pdf", 2, 3))

    expect(first).toEqual(second)
    // The info dictionary sits in a compressed object stream, so the bytes cannot show it: ask the document.
    const cut = await PDFDocument.load(first, { updateMetadata: false })
    expect([cut.getProducer(), cut.getCreator(), cut.getCreationDate(), cut.getModificationDate()]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe("a PDF is refused when a few bytes would make the parser stall", () => {
  const probe = fixtureFile("pdf-count.ts")
  const run = async (bytes: Uint8Array, ...range: number[]) => {
    const file = path.join(os.tmpdir(), `orbit-pdf-probe-${crypto.randomUUID()}.pdf`)
    await Bun.write(file, bytes)
    const child = Bun.spawn([process.execPath, probe, file, ...range.map(String)], { stdout: "pipe", stderr: "pipe" })
    // The deadline is the point: a parser that walks 2^depth nodes never answers.
    const timer = setTimeout(() => child.kill(), 20_000)
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    clearTimeout(timer)
    await fs.rm(file, { force: true })
    return { code, result: code === 0 ? JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") : undefined }
  }

  test("a page tree that lists a child twice at every level, read whole and by range", async () => {
    const shared = pageTreePdf(40, true)
    expect(shared.length).toBeLessThan(10_000)

    expect(await run(shared)).toEqual({ code: 0, result: { refused: "corrupt" } })
    expect(await run(shared, 1, 2)).toEqual({ code: 0, result: { refused: "corrupt" } })
  }, 60_000)

  test("a page tree that lists itself as a child", async () => {
    const loop = rawPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [2 0 R] /Count 1 >>",
    ])
    expect(await run(loop)).toEqual({ code: 0, result: { refused: "corrupt" } })
  })

  test("control: a deep tree that lists every node once is read, whole and by range", async () => {
    const nested = pageTreePdf(40, false)

    expect(await run(nested)).toEqual({ code: 0, result: { total: 40 } })
    expect(await run(nested, 2, 4)).toEqual({ code: 0, result: { total: 40, cut: 3 } })
  }, 60_000)

  test("a page tree entry that is missing or not a dictionary", async () => {
    for (const kids of ["[9 0 R]", "[42]", "[]"]) {
      const bad = rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids ${kids} /Count 1 >>`])
      const { result } = await run(bad)
      // An empty tree is a PDF with no pages; the others are damaged.
      expect(result).toEqual(kids === "[]" ? { total: 0 } : { refused: "corrupt" })
    }
  })

  test("a root that is not a page tree is refused instead of counted as one page", async () => {
    const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>"
    const untypedRoot = rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Kids [3 0 R 4 0 R] /Count 2 >>", page, page])
    expect(await run(untypedRoot)).toEqual({ code: 0, result: { refused: "corrupt" } })
    expect(await run(untypedRoot, 1, 1)).toEqual({ code: 0, result: { refused: "corrupt" } })

    const pageRoot = rawPdf(["<< /Type /Catalog /Pages 2 0 R >>", page])
    expect(await run(pageRoot)).toEqual({ code: 0, result: { refused: "corrupt" } })
  })

  test("an untyped kid is not counted as a page", async () => {
    const tree = rawPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>",
      "<< /Parent 2 0 R >>",
    ])
    expect(await run(tree)).toEqual({ code: 0, result: { total: 1 } })
  })
})

describe("what the strict parse refuses", () => {
  // Pinned on purpose: the parse fails closed, so one invalid object makes the whole file unreadable.
  test("a PDF with one invalid object, even an unreferenced one", async () => {
    const error = await Effect.runPromise(Pdf.pageCount(strayInvalidObjectPdf(), "stray.pdf").pipe(Effect.flip))
    expect(error).toMatchObject({ reason: "corrupt" })
    expect((await PDFDocument.load(strayInvalidObjectPdf(), { throwOnInvalidObject: false })).getPageCount()).toBe(1)
  })
})
