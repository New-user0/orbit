import path from "node:path"

// Bound filesystem work per terminal paste; the byte budget also bounds staged data.
const MAX_PASTED_FILEPATHS = 32
export const MAX_LOCAL_ATTACHMENT_BYTES = 20 * 1024 * 1024

export type LocalFiles = Readonly<{
  readBytes(path: string, maxBytes: number): Promise<Uint8Array>
  mime(path: string): Promise<string>
}>

export type LocalAttachment = Readonly<{ type: "binary"; mime: string; content: Uint8Array }>

export function readLocalAttachment(file: string, maxBytes = MAX_LOCAL_ATTACHMENT_BYTES) {
  return readLocalAttachmentWith(
    {
      readBytes: readFileBounded,
      mime: async (value) => mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream",
    },
    file,
    maxBytes,
  )
}

// A paste or a drop is cut into lines, and a line is cut again only where a space is followed by the start of an
// absolute path. One quote may sit between that space and the path, because Windows Terminal wraps each dropped
// path in double quotes. A piece attaches only when it names an absolute png, jpeg, gif or webp file that reads as
// an image. Every other piece (prose, a relative path, an svg, a pdf, a missing or oversized file) is never read and
// stays in `rest` exactly as typed, with the separator that came before it. Returns undefined when nothing attaches,
// so the caller inserts the paste unchanged.
export async function resolvePastedAttachments(text: string, platform: string) {
  // Even indexes hold the pieces, odd indexes the line break or space that came between two of them.
  const parts = text.trim().split(/(\r?\n| (?=['"]?(?:\/|[A-Za-z]:\\)))/)
  const candidates = parts.flatMap((part, index) => {
    const file = index % 2 === 0 ? imagePath(part, platform) : undefined
    return file ? [{ index, file }] : []
  })
  if (candidates.length === 0 || candidates.length > MAX_PASTED_FILEPATHS) return undefined

  const files: ReturnType<typeof toFilePart>[] = []
  const attached = new Set<number>()
  let remaining = MAX_LOCAL_ATTACHMENT_BYTES
  for (const candidate of candidates) {
    const attachment = await readLocalAttachment(candidate.file, remaining)
    if (!attachment) continue
    remaining -= attachment.content.byteLength
    attached.add(candidate.index)
    files.push(toFilePart(candidate.file, attachment))
  }
  if (files.length === 0) return undefined
  const rest = parts
    .flatMap((part, index) => (index % 2 === 0 && !attached.has(index) ? [{ separator: parts[index - 1], part }] : []))
    .map((kept, order) => (order === 0 ? kept.part : kept.separator + kept.part))
    .join("")
  return { files, rest }
}

// The file a piece names when it is an absolute path to one of the attachable image types, read after one pair of
// outer quotes and, outside Windows, its backslash escapes are removed. A file URL counts as the path it names.
function imagePath(piece: string, platform: string) {
  const value = piece.trim()
  const unquoted = /^(['"]).+\1$/.test(value) ? value.slice(1, -1) : value
  const file = decodeFileURL(unquoted, platform) ?? (platform === "win32" ? unquoted : unquoted.replace(/\\(.)/g, "$1"))
  if (!(platform === "win32" ? path.win32 : path.posix).isAbsolute(file)) return undefined
  if (!mimeTypes[path.extname(file).toLowerCase()]) return undefined
  return file
}

function toFilePart(filepath: string, attachment: LocalAttachment) {
  return {
    type: "file" as const,
    uri: `data:${attachment.mime};base64,${Buffer.from(attachment.content).toString("base64")}`,
    filename: path.basename(filepath),
  }
}

// Only these types attach. An SVG or a PDF path stays as typed and is never read.
const mimeTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

async function readFileBounded(file: string, maxBytes: number) {
  const source = Bun.file(file)
  if (!(await source.exists())) throw new Error("Attachment does not exist")
  if (source.size > maxBytes) throw new Error("Attachment exceeds the local file limit")
  const content = Buffer.from(await source.slice(0, maxBytes + 1).arrayBuffer())
  if (content.byteLength > maxBytes) throw new Error("Attachment exceeds the local file limit")
  return content
}

function decodeFileURL(value: string, platform: string): string | undefined {
  if (!value.startsWith("file://")) return undefined
  try {
    const url = new URL(value)
    if (/%2f|%5c/i.test(url.pathname)) return undefined
    const pathname = decodeURIComponent(url.pathname)
    if (platform !== "win32") {
      if (url.hostname && url.hostname !== "localhost") return undefined
      return pathname
    }
    const local = pathname.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\")
    if (url.hostname && url.hostname !== "localhost") return `\\\\${url.hostname}${local}`
    return local
  } catch {
    return undefined
  }
}

export async function readLocalAttachmentWith(
  files: LocalFiles,
  path: string,
  maxBytes = MAX_LOCAL_ATTACHMENT_BYTES,
): Promise<LocalAttachment | undefined> {
  const mime = await files.mime(path).catch(() => undefined)
  if (!mime) return undefined
  if (!mime.startsWith("image/")) return undefined
  const content = await files.readBytes(path, maxBytes).catch(() => undefined)
  if (!content || content.byteLength > maxBytes) return undefined
  return { type: "binary", mime, content }
}
