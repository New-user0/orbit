import { PDFDocument, PDFName } from "pdf-lib"

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

/** A hand-written PDF from object bodies, numbered from 1 in order; object 1 must be the catalog. */
export const rawPdf = (objects: string[], trailer = "") => {
  let text = "%PDF-1.4\n"
  const offsets = objects.map((object, index) => {
    const offset = text.length
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  text += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(text)
}

/** A well-formed one-page PDF whose trailer names an encryption dictionary. */
export const encryptedPdf = () =>
  rawPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
      "<< /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>",
    ],
    "/Encrypt 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]",
  )

/** A one-page PDF plus an object after the pages that is not a valid object and that nothing refers to. */
export const strayInvalidObjectPdf = () =>
  rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    "<< /Unclosed [ ( >>",
  ])

/**
 * A page tree `depth` levels deep. With `shared`, every level lists the next level twice, so a walk that visits a node
 * once per listing reaches 2^depth leaves; without it each level lists the next level and one page of its own.
 */
export const pageTreePdf = (depth: number, shared: boolean) => {
  // Objects: 1 catalog, then one Pages node per level, then one page per level (the last one closes the chain).
  const node = (level: number) => 2 + level
  const leaf = (level: number) => 2 + depth + level
  return rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    ...Array.from({ length: depth }, (_, level) => {
      const last = level + 1 === depth
      const next = last ? `${leaf(level)} 0 R` : `${node(level + 1)} 0 R`
      const kids = shared ? [next, next] : last ? [next] : [next, `${leaf(level)} 0 R`]
      return `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`
    }),
    ...Array.from(
      { length: depth },
      (_, level) => `<< /Type /Page /Parent ${node(level)} 0 R /MediaBox [0 0 ${101 + level} 200] >>`,
    ),
  ])
}

/** A one-page PDF whose page content is a stream of `bytes` bytes. */
export const heavyPagePdf = async (bytes: number) => {
  const document = await PDFDocument.create({ updateMetadata: false })
  const page = document.addPage([100, 100])
  page.node.set(PDFName.of("Contents"), document.context.register(document.context.stream(new Uint8Array(bytes))))
  return new Uint8Array(await document.save())
}
