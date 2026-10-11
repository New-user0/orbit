export * as Pdf from "./pdf.js"

import { Effect, Schema } from "effect"

/** What one read may return of a PDF, and the length above which a whole read must name pages. */
export const MAX_PAGES_PER_CALL = 20
export const MAX_WHOLE_PAGES = 10

export class Error extends Schema.TaggedError<Error>()("Pdf.Error", {
  resource: Schema.String,
  reason: Schema.Literals(["encrypted", "corrupt", "unavailable"]),
}) {
  // Written here on purpose: the library's own text can echo bytes from the file.
  override get message() {
    if (this.reason === "encrypted")
      return `Cannot read ${this.resource}: the PDF is encrypted, and Read opens only PDFs without a password.`
    if (this.reason === "corrupt") return `Cannot read ${this.resource}: the file is not a well-formed PDF.`
    return `Cannot read ${this.resource}: PDF support is missing from this build.`
  }
}

/**
 * The strict spellings of a page range: `N`, `N-M` and the open `N-`, 1-based, with surrounding whitespace allowed.
 * `last` is Infinity for `N-`. Anything else, including a number with trailing text, is undefined.
 */
export const parseRange = (text: string) => {
  const match = /^(\d+)(?:(-)(\d*))?$/.exec(text.trim())
  if (!match) return
  const first = Number(match[1])
  const last = match[2] === undefined ? first : match[3] === "" ? Infinity : Number(match[3])
  if (!Number.isSafeInteger(first) || first < 1 || last < first) return
  // Only the open `N-` may be Infinity; a written number must be exact, or arithmetic on it is not.
  if (last !== Infinity && !Number.isSafeInteger(last)) return
  return { first, last }
}

export const pageCount = Effect.fn("Pdf.pageCount")(function* (bytes: Uint8Array, resource: string) {
  return (yield* load(bytes, resource)).pages
})

/** Copies pages `first` to `last` (1-based, inclusive, already within the document) into a new PDF. */
export const extract = Effect.fn("Pdf.extract")(function* (
  bytes: Uint8Array,
  resource: string,
  first: number,
  last: number,
) {
  const loaded = yield* load(bytes, resource)
  return yield* Effect.tryPromise({
    try: async () => {
      // No producer or date stamp: the library's name would reach the model and the bytes would differ per run.
      const target = await loaded.PDFDocument.create({ updateMetadata: false })
      const pages = await target.copyPages(
        loaded.document,
        Array.from({ length: last - first + 1 }, (_, index) => first - 1 + index),
      )
      pages.forEach((page) => target.addPage(page))
      return await target.save()
    },
    catch: () => new Error({ resource, reason: "corrupt" }),
  })
})

const load = Effect.fnUntraced(function* (bytes: Uint8Array, resource: string) {
  // The library is heavy and rarely needed, so it loads on first use. A failed import is a build defect, reported as an error.
  const { PDFDocument, PDFName, PDFPageTree, PDFDict } = yield* Effect.tryPromise({
    try: () => import("pdf-lib"),
    catch: () => new Error({ resource, reason: "unavailable" }),
  }).pipe(Effect.tapError(() => Effect.logError("PDF library failed to load")))
  const document = yield* Effect.tryPromise({
    // Encryption detection stays on: the library cannot decrypt, and copying encrypted streams yields a broken file.
    // An invalid object anywhere in the file, even an unreferenced one, makes the file unreadable: a PDF the library
    // only half understands is refused instead of passed to a provider that may reject it for the whole session.
    try: () => PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true }),
    // The library's error classes compile to a prototype chain that `instanceof` cannot see, so its fixed wording
    // identifies encryption. Only the reason is kept; its text never reaches the model.
    catch: (cause) =>
      new Error({
        resource,
        reason: cause instanceof globalThis.Error && cause.message.includes("is encrypted") ? "encrypted" : "corrupt",
      }),
  })
  // The walk is a guard only; the count comes from the library so that it counts what the library can cut. It runs before the library's recursive one can: that one visits a node once per time it is
  // listed, so a few KB of nodes that each list the same child twice make it visit 2^depth leaves and block the server.
  const pages = yield* Effect.try({
    try: () => {
      const visited = new Set<unknown>()
      const pending: unknown[] = [document.catalog.get(PDFName.of("Pages"))]
      while (pending.length > 0) {
        const entry = pending.pop()
        if (visited.has(entry)) throw new globalThis.Error("page tree node reached twice")
        visited.add(entry)
        const node = document.context.lookup(entry as never)
        if (node instanceof PDFPageTree) pending.push(...node.Kids().asArray())
        else if (!(node instanceof PDFDict)) throw new globalThis.Error("page tree entry is not a dictionary")
      }
      return document.getPageCount()
    },
    catch: () => new Error({ resource, reason: "corrupt" }),
  })
  return { PDFDocument, document, pages }
})
