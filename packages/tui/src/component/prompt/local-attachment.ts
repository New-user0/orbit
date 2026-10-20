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

// Attaches every png, jpeg, gif or webp path in a paste or drop that reads as an image. Every other path (pdf, svg,
// a missing or oversized file, a relative path) stays as typed text and is never read. Returns undefined when
// nothing attaches, so the caller inserts the paste unchanged.
export async function resolvePastedAttachments(text: string, platform: string) {
  const pastedContent = text.trim()
  const whole = normalizePastedFilepath(pastedContent, platform)
  if (/^(https?):\/\//.test(whole)) return undefined

  const single = await readLocalAttachment(whole)
  if (single) return { files: [toFilePart(whole, single)], rest: "" }

  const files: ReturnType<typeof toFilePart>[] = []
  const rest: string[] = []
  let remaining = MAX_LOCAL_ATTACHMENT_BYTES
  for (const token of parsePastedFilepaths(pastedContent, platform)) {
    const attachment = path.isAbsolute(token) ? await readLocalAttachment(token, remaining) : undefined
    if (!attachment) {
      rest.push(/\s/.test(token) ? `"${token}"` : token)
      continue
    }
    remaining -= attachment.content.byteLength
    files.push(toFilePart(token, attachment))
  }
  if (files.length === 0) return undefined
  return { files, rest: rest.join(" ") }
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

export function normalizePastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  const url = decodeFileURL(raw, platform)
  if (url) return url
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
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

export function parsePastedFilepaths(value: string, platform: string) {
  const result: string[] = []
  let current = ""
  let quote = ""

  function push() {
    if (!current) return
    result.push(decodeFileURL(current, platform) ?? current)
    current = ""
  }

  const input = value.includes("file://")
    ? value
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n")
    : value
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quote) {
      if (character === quote) {
        quote = ""
        continue
      }
      if (character === "\\" && platform !== "win32" && quote === '"' && index + 1 < input.length) {
        current += input[++index]
        continue
      }
      current += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === "\\" && platform !== "win32" && index + 1 < input.length) {
      current += input[++index]
      continue
    }
    if (/\s/.test(character)) {
      push()
      if (result.length > MAX_PASTED_FILEPATHS) return []
      continue
    }
    current += character
  }

  if (quote) return []
  push()
  if (result.length > MAX_PASTED_FILEPATHS) return []
  return result
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
