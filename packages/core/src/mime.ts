export * as Mime from "./mime.js"

export function detect(bytes: Uint8Array) {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  if (
    startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70]) &&
    (startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x66]) || startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x73]))
  )
    return "image/avif"
  return isText(bytes) ? "text/plain" : "application/octet-stream"
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function isText(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true })
  } catch {
    return false
  }
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0)
  return controls / bytes.length <= 0.3
}

/**
 * Reads the pixel size an image declares in its header, without decoding pixels. `mime` is the type `detect` found:
 * a type this does not handle, a truncated header and a size the format calls invalid all answer `undefined`. It never
 * throws and never allocates from a number in the header, so a hostile file costs only itself.
 */
export function dimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const size = sizeOf(bytes, mime)
  return size && size.width > 0 && size.height > 0 ? size : undefined
}

function sizeOf(bytes: Uint8Array, mime: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number, value: string) =>
    [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if (mime === "image/png") {
    if (bytes.length < 24 || !text(12, "IHDR")) return undefined
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return width > 0x7fffffff || height > 0x7fffffff ? undefined : { width, height }
  }
  if (mime === "image/gif") {
    if (bytes.length < 10 || !(text(0, "GIF87a") || text(0, "GIF89a"))) return undefined
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  if (mime === "image/webp") return webp(bytes, view, text)
  if (mime === "image/jpeg") return jpeg(bytes, view)
  if (mime === "image/bmp") {
    if (bytes.length < 18 || !text(0, "BM")) return undefined
    const header = view.getUint32(14, true)
    if (header === 12)
      return bytes.length < 22 ? undefined : { width: view.getUint16(18, true), height: view.getUint16(20, true) }
    if (![40, 52, 56, 64, 108, 124].includes(header) || bytes.length < 26) return undefined
    const width = view.getInt32(18, true)
    // A negative height only says the rows are stored top-down.
    return width <= 0 ? undefined : { width, height: Math.abs(view.getInt32(22, true)) }
  }
  return undefined
}

function webp(bytes: Uint8Array, view: DataView, text: (offset: number, value: string) => boolean) {
  if (bytes.length < 25 || !text(0, "RIFF") || !text(8, "WEBP")) return undefined
  if (text(12, "VP8 ")) {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return undefined
    // The top two bits of each field are scaling hints, not size.
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  }
  if (text(12, "VP8L")) {
    if (bytes[20] !== 0x2f) return undefined
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (text(12, "VP8X")) {
    if (bytes.length < 30) return undefined
    const field = (offset: number) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)) + 1
    return { width: field(24), height: field(27) }
  }
  return undefined
}

// Walks the segments instead of searching for a frame marker: an EXIF block often embeds a thumbnail with its own frame.
function jpeg(bytes: Uint8Array, view: DataView) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
  let offset = 2
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    // Any number of 0xFF fill bytes may come before the marker code.
    while (bytes[offset + 1] === 0xff) offset++
    const code = bytes[offset + 1]
    if (code === undefined) return undefined
    if (code === 0xd8 || code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      offset += 2
      continue
    }
    if (code === 0xd9 || code === 0xda) return undefined
    if (offset + 4 > bytes.length) return undefined
    const length = view.getUint16(offset + 2)
    if (length < 2) return undefined
    if (code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc) {
      if (offset + 9 > bytes.length) return undefined
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    }
    offset += 2 + length
  }
  return undefined
}
