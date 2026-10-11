import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Mime } from "@orbit/core/mime"
import { bmp, frame, gif, jfif, jpeg, png, segment, webpExtended, webpLossless, webpLossy, webpUnknown } from "./lib/image-bytes"

const exif = (thumbnail: Uint8Array) => segment(0xe1, [...Array.from("Exif").map((c) => c.charCodeAt(0)), 0, 0, ...thumbnail])

// Each case: the bytes, the type `Mime.detect` would find, the size, and how many bytes the header needs.
const valid = [
  { name: "PNG 1x1", bytes: png(1, 1), mime: "image/png", size: { width: 1, height: 1 }, need: 24 },
  { name: "PNG 3000x17", bytes: png(3_000, 17), mime: "image/png", size: { width: 3_000, height: 17 }, need: 24 },
  { name: "GIF89a", bytes: gif(640, 480), mime: "image/gif", size: { width: 640, height: 480 }, need: 10 },
  { name: "GIF87a", bytes: gif(640, 480, "GIF87a"), mime: "image/gif", size: { width: 640, height: 480 }, need: 10 },
  {
    name: "WebP lossy with both scaling bits set",
    bytes: webpLossy(0xc123, 0x4456),
    mime: "image/webp",
    size: { width: 0x123, height: 0x456 },
    need: 30,
  },
  { name: "WebP lossless 1x1", bytes: webpLossless(1, 1), mime: "image/webp", size: { width: 1, height: 1 }, need: 25 },
  {
    name: "WebP lossless 16384x16384",
    bytes: webpLossless(16_384, 16_384),
    mime: "image/webp",
    size: { width: 16_384, height: 16_384 },
    need: 25,
  },
  { name: "WebP extended", bytes: webpExtended(5_000, 3), mime: "image/webp", size: { width: 5_000, height: 3 }, need: 30 },
  {
    name: "JPEG with a thumbnail inside the EXIF segment",
    bytes: jpeg(jfif(), exif(jpeg(frame(0xc0, 160, 120))), frame(0xc0, 4_000, 3_000)),
    mime: "image/jpeg",
    size: { width: 4_000, height: 3_000 },
    need: 0,
  },
  {
    name: "progressive JPEG",
    bytes: jpeg(jfif(), frame(0xc2, 800, 600)),
    mime: "image/jpeg",
    size: { width: 800, height: 600 },
    need: 0,
  },
  {
    name: "JPEG with fill bytes before the marker",
    bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xff, ...frame(0xc0, 33, 22).slice(1)]),
    mime: "image/jpeg",
    size: { width: 33, height: 22 },
    need: 0,
  },
  {
    name: "JPEG with a Huffman table before the frame",
    bytes: jpeg(segment(0xc4, [0x01, 0x00, 0x09, 0x00, 0x07]), frame(0xc0, 70, 50)),
    mime: "image/jpeg",
    size: { width: 70, height: 50 },
    need: 0,
  },
  {
    name: "BMP with a 40-byte header stored top-down",
    bytes: bmp(40, 20, -10),
    mime: "image/bmp",
    size: { width: 20, height: 10 },
    need: 26,
  },
  { name: "BMP with a 12-byte core header", bytes: bmp(12, 21, 11), mime: "image/bmp", size: { width: 21, height: 11 }, need: 22 },
  { name: "BMP with a 124-byte header", bytes: bmp(124, 30, 12), mime: "image/bmp", size: { width: 30, height: 12 }, need: 26 },
]

describe("Mime.dimensions", () => {
  test.each(valid)("reads $name", ({ bytes, mime, size }) => {
    expect(Mime.dimensions(bytes, mime)).toEqual(size)
  })

  test.each(valid.filter((item) => item.need > 0))("answers undefined for $name cut short, at every length", (item) => {
    for (let length = 0; length < item.need; length++) expect(Mime.dimensions(item.bytes.slice(0, length), item.mime)).toBeUndefined()
  })

  test("a JPEG cut short at every length never throws", () => {
    const bytes = jpeg(jfif(), exif(jpeg(frame(0xc0, 160, 120))), frame(0xc0, 4_000, 3_000))
    // The frame segment is the ten bytes before the end-of-image marker.
    for (let length = 0; length < bytes.length - 3; length++) expect(Mime.dimensions(bytes.slice(0, length), "image/jpeg")).toBeUndefined()
  })

  test.each([
    { name: "PNG whose first chunk is not IHDR", bytes: png(1, 1, "IDAT"), mime: "image/png" },
    { name: "PNG of width 0", bytes: png(0, 5), mime: "image/png" },
    { name: "PNG larger than the specification allows", bytes: png(0x80000000, 5), mime: "image/png" },
    { name: "GIF of height 0", bytes: gif(5, 0), mime: "image/gif" },
    { name: "WebP lossy without its start code", bytes: webpLossy(5, 5, [0, 0, 0]), mime: "image/webp" },
    { name: "WebP lossless with a wrong signature", bytes: webpLossless(5, 5, 0x30), mime: "image/webp" },
    { name: "WebP with an unknown first chunk", bytes: webpUnknown(), mime: "image/webp" },
    { name: "JPEG that reaches the scan before a frame", bytes: jpeg(jfif(), segment(0xda, [0, 0])), mime: "image/jpeg" },
    { name: "JPEG whose frame height is 0", bytes: jpeg(frame(0xc0, 10, 0)), mime: "image/jpeg" },
    { name: "JPEG with a frame of type C8", bytes: jpeg(frame(0xc8, 10, 10)), mime: "image/jpeg" },
    { name: "JPEG with a byte that is no marker", bytes: Uint8Array.from([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78]), mime: "image/jpeg" },
    { name: "BMP with an unknown header size", bytes: bmp(40, 5, 5).with(14, 41), mime: "image/bmp" },
    { name: "text that starts with BM", bytes: new TextEncoder().encode("BMW is a car maker, not an image"), mime: "image/bmp" },
    { name: "AVIF", bytes: png(1, 1), mime: "image/avif" },
    { name: "PDF", bytes: png(1, 1), mime: "application/pdf" },
    { name: "plain text", bytes: png(1, 1), mime: "text/plain" },
  ])("answers undefined for $name", ({ bytes, mime }) => {
    expect(Mime.dimensions(bytes, mime)).toBeUndefined()
  })

  test("agrees with the resizer's decoded size for PNG, JPEG, GIF and WebP", async () => {
    const photon = await import("@silvia-odwyer/photon-node")
    const sizes = [
      [1, 1],
      [7, 3],
      [64, 48],
    ] as const
    for (const [width, height] of sizes) {
      const source = new photon.PhotonImage(Uint8Array.from({ length: width * height * 4 }, () => 200), width, height)
      const encoded = [
        ["image/png", source.get_bytes()],
        ["image/jpeg", source.get_bytes_jpeg(80)],
        ["image/webp", source.get_bytes_webp()],
      ] as const
      source.free()
      for (const [mime, bytes] of encoded) {
        expect(Mime.detect(bytes)).toBe(mime)
        const decoded = photon.PhotonImage.new_from_byteslice(bytes)
        expect(Mime.dimensions(bytes, mime)).toEqual({ width: decoded.get_width(), height: decoded.get_height() })
        decoded.free()
      }
    }
  })
})

describe("Mime.dimensions answers promptly on a JPEG built to stall a walk", () => {
  const probe = path.join(import.meta.dir, "fixture", "mime-dimensions.ts")
  const run = async (bytes: Uint8Array) => {
    const file = path.join(os.tmpdir(), `orbit-mime-probe-${crypto.randomUUID()}.jpg`)
    await Bun.write(file, bytes)
    const child = Bun.spawn([process.execPath, probe, file, "image/jpeg"], { stdout: "pipe", stderr: "pipe" })
    // The deadline is the point: a walk that never advances never answers.
    const timer = setTimeout(() => child.kill(), 10_000)
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    clearTimeout(timer)
    await fs.rm(file, { force: true })
    return { code, result: code === 0 ? JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") : undefined }
  }

  test("a segment whose length is 0 or 1", async () => {
    expect(await run(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0x00, 0x00]))).toEqual({ code: 0, result: null })
    expect(await run(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0x00, 0x00]))).toEqual({ code: 0, result: null })
  }, 30_000)

  test("a long run of fill bytes and one of restart markers", async () => {
    expect(await run(Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 200_000 }, () => 0xff)]))).toEqual({ code: 0, result: null })
    expect(
      await run(Uint8Array.from([0xff, 0xd8, ...Array.from({ length: 100_000 }, () => [0xff, 0xd3]).flat()])),
    ).toEqual({ code: 0, result: null })
  }, 30_000)

  test("control: the same walk reads a valid file", async () => {
    expect(await run(jpeg(jfif(), frame(0xc0, 12, 9)))).toEqual({ code: 0, result: { width: 12, height: 9 } })
  }, 30_000)
})
