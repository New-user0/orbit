import { Effect } from "effect"
import { Pdf } from "@orbit/core/tool/pdf"

// The program that pdf-compiled.test.ts compiles into a binary and starts in a folder of its own. Arguments: a PDF, then
// the first and last page to cut from it. It prints one line of JSON with the page count of the source and of the cut.
const [file, first, last] = process.argv.slice(2)
const source = new Uint8Array(await Bun.file(file).arrayBuffer())
const program = Effect.gen(function* () {
  const total = yield* Pdf.pageCount(source, "source.pdf")
  const cut = yield* Pdf.extract(source, "source.pdf", Number(first), Number(last))
  return { total, cut: yield* Pdf.pageCount(cut, "cut.pdf") }
})
console.log(JSON.stringify(await Effect.runPromise(program)))
