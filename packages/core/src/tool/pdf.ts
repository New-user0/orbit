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
    if (this.reason === "encrypted") return `PDF is password-protected; provide an unprotected copy: ${this.resource}`
    if (this.reason === "corrupt") return `PDF is corrupted or invalid: ${this.resource}`
    return `PDF support is unavailable in this build: ${this.resource}`
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
  return { first, last }
}

export const pageCount = Effect.fn("Pdf.pageCount")(function* (bytes: Uint8Array, resource: string) {
  const loaded = yield* load(bytes, resource)
  // A document with a damaged page tree still loads; counting its pages is what fails.
  return yield* Effect.try({
    try: () => loaded.document.getPageCount(),
    catch: () => new Error({ resource, reason: "corrupt" }),
  })
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
  const { PDFDocument } = yield* Effect.tryPromise({
    try: () => import("pdf-lib"),
    catch: () => new Error({ resource, reason: "unavailable" }),
  }).pipe(Effect.tapError(() => Effect.logError("PDF library failed to load")))
  const document = yield* Effect.tryPromise({
    // Encryption detection stays on: the library cannot decrypt, and copying encrypted streams yields a broken file.
    try: () => PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true }),
    // The library's error classes compile to a prototype chain that `instanceof` cannot see, so its fixed wording
    // identifies encryption. Only the reason is kept; its text never reaches the model.
    catch: (cause) =>
      new Error({
        resource,
        reason: cause instanceof globalThis.Error && cause.message.includes("is encrypted") ? "encrypted" : "corrupt",
      }),
  })
  return { PDFDocument, document }
})
