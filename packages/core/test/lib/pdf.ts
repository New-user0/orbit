import { PDFDocument } from "pdf-lib"

/** Page `n` (1-based) is `100 + n` points wide, so a test can tell which source page landed where. */
export const pageWidth = (page: number) => 100 + page

/**
 * A PDF of `pages` pages. `padding` adds an unreferenced stream of that many bytes, which makes the file large
 * without making any page larger: a copy of some pages leaves it behind.
 */
export const makePdf = async (pages: number, padding = 0) => {
  const document = await PDFDocument.create({ updateMetadata: false })
  Array.from({ length: pages }, (_, index) => document.addPage([pageWidth(index + 1), 200]))
  if (padding > 0) document.context.register(document.context.stream(new Uint8Array(padding)))
  return new Uint8Array(await document.save())
}

/** Page widths of a PDF, in order. */
export const widths = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes, { updateMetadata: false })).getPages().map((page) => page.getWidth())

/** A well-formed one-page PDF whose trailer names an encryption dictionary. */
export const encryptedPdf = () => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    "<< /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>",
  ]
  let text = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const offset = text.length
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  text += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(text)
}
