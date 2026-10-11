import { Effect } from "effect"
import { Pdf } from "@orbit/core/tool/pdf"

// A child process for tests that must run under a deadline. Arguments: a PDF, then optionally the first and last page
// to cut. It prints one line of JSON with the page count and the pages of the cut, or the reason it was refused.
const [file, first, last] = process.argv.slice(2)
const source = new Uint8Array(await Bun.file(file).arrayBuffer())
const program = Effect.gen(function* () {
  const total = yield* Pdf.pageCount(source, "source.pdf")
  if (first === undefined) return { total }
  const cut = yield* Pdf.extract(source, "source.pdf", Number(first), Number(last))
  return { total, cut: yield* Pdf.pageCount(cut, "cut.pdf") }
}).pipe(Effect.catchTag("Pdf.Error", (error) => Effect.succeed({ refused: error.reason })))
console.log(JSON.stringify(await Effect.runPromise(program)))
