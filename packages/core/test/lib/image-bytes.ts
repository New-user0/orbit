// Image headers built byte by byte, so a test reads the layout from the format specifications and not from the parser.
const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff]
const u32be = (value: number) => [...u16be(value >>> 16), ...u16be(value & 0xffff)]
const u32le = (value: number) => [...u16le(value & 0xffff), ...u16le(value >>> 16)]
const ascii = (value: string) => [...value].map((char) => char.charCodeAt(0))

export const png = (width: number, height: number, firstChunk = "IHDR") =>
  Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii(firstChunk),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
  ])

export const gif = (width: number, height: number, version = "GIF89a") =>
  Uint8Array.from([...ascii(version), ...u16le(width), ...u16le(height), 0, 0, 0])

const riff = (chunk: string, payload: number[]) =>
  Uint8Array.from([...ascii("RIFF"), ...u32le(4 + 8 + payload.length), ...ascii("WEBP"), ...ascii(chunk), ...u32le(payload.length), ...payload])

/** The two high bits of each field are scaling hints; pass them in `widthField` or `heightField` to set them. */
export const webpLossy = (widthField: number, heightField: number, startCode = [0x9d, 0x01, 0x2a]) =>
  riff("VP8 ", [0, 0, 0, ...startCode, ...u16le(widthField), ...u16le(heightField), 0, 0, 0, 0])

export const webpLossless = (width: number, height: number, signature = 0x2f) =>
  riff("VP8L", [signature, ...u32le(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)), 0, 0, 0, 0])

export const webpExtended = (width: number, height: number) =>
  riff("VP8X", [0, 0, 0, 0, ...u32le(width - 1).slice(0, 3), ...u32le(height - 1).slice(0, 3), 0, 0, 0, 0])

export const webpUnknown = () => riff("ABCD", Array.from({ length: 16 }, () => 0))

export const segment = (code: number, payload: number[]) => [0xff, code, ...u16be(payload.length + 2), ...payload]

/** A start-of-frame segment: precision, height, width, then no components. */
export const frame = (code: number, width: number, height: number) =>
  segment(code, [8, ...u16be(height), ...u16be(width), 0])

export const jpeg = (...parts: number[][]) => Uint8Array.from([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9])

export const jfif = () => segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0])

export const bmp = (header: 12 | 40 | 124, width: number, height: number) => {
  const dib =
    header === 12
      ? [...u32le(12), ...u16le(width), ...u16le(height), 1, 0, 24, 0]
      : [...u32le(header), ...u32le(width >>> 0), ...u32le(height >>> 0), 1, 0, 24, 0]
  return Uint8Array.from([...ascii("BM"), ...u32le(14 + header), 0, 0, 0, 0, ...u32le(14 + header), ...dib, ...Array.from({ length: header - dib.length }, () => 0)])
}
