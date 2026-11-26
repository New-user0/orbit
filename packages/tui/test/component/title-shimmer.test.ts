import { expect, test } from "bun:test"
import { BoxRenderable, RGBA, TextAttributes, TextRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { createTestRendererTimed } from "../fixture/render"
import { TitleShimmerRenderable } from "../../src/component/title-shimmer"

test("shimmer fades in from idle and fades out on unchanged completion", async () => {
  const clock = new ManualClock()
  const app = await createTestRendererTimed({ width: 24, height: 1, useThread: false, clock })
  const title = new TitleShimmerRenderable(app.renderer, {
    width: 24,
    height: 1,
    content: "Compiler cleanup",
    fg: "#eeeeee",
    backdrop: RGBA.fromHex("#111111"),
    rename: { title: "Compiler cleanup", pending: false },
  })
  app.renderer.root.add(title)
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    const colors = app.captureSpans()
    clock.advance(2000)
    title.rename = { title: "Compiler cleanup", pending: true }
    await app.renderOnce()
    expect(app.captureSpans()).toEqual(colors)
    clock.advance(120)
    await app.renderOnce()
    const middle = app.captureSpans().lines[0].spans.findLast((span) => span.text.trim())?.fg.r ?? 0
    expect(middle).toBeLessThan(colors.lines[0].spans[0].fg.r)
    clock.advance(120)
    await app.renderOnce()
    expect(app.captureSpans().lines[0].spans.findLast((span) => span.text.trim())?.fg.r ?? 0).toBeLessThan(middle)
    expect(app.captureSpans()).not.toEqual(colors)
    expect(app.captureCharFrame()).toBe(frame)
    title.rename = { title: "Compiler cleanup", pending: false }
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(1)
    clock.advance(240)
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(0)
    expect(app.captureSpans()).toEqual(colors)
    title.enabled = false
    title.rename = { title: "Compiler cleanup", pending: true }
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a feathered wipe keeps the old shimmer moving without dimming the revealed new title", async () => {
  const clock = new ManualClock()
  const app = await createTestRendererTimed({ width: 16, height: 1, useThread: false, clock })
  const title = new TitleShimmerRenderable(app.renderer, {
    width: 16,
    height: 1,
    content: "ABCDEFGHIJKLMNOP",
    fg: "#eeeeee",
    attributes: TextAttributes.ITALIC,
    backdrop: RGBA.fromHex("#111111"),
    rename: { title: "ABCDEFGHIJKLMNOP", pending: true },
  })
  app.renderer.root.add(title)
  try {
    await app.renderOnce()
    clock.advance(600)
    await app.renderOnce()
    const colors = app.captureSpans()
    title.content = "abcdefghijklmnop"
    title.rename = { title: "abcdefghijklmnop", pending: true }
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("ABCDEFGHIJKLMNOP")
    expect(app.captureSpans()).toEqual(colors)
    clock.advance(225)
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("abcdefghIJKLMNOP")
    const spans = app.captureSpans().lines[0].spans
    expect(spans[0].fg.equals(RGBA.fromHex("#eeeeee"))).toBe(true)
    expect(spans.some((span) => span.fg.equals(RGBA.fromHex("#111111")))).toBe(true)
    expect(spans.at(-1)?.fg.toInts()).not.toEqual(colors.lines[0].spans.at(-1)?.fg.toInts())
    expect(spans.every((span) => Boolean(span.attributes & TextAttributes.ITALIC))).toBe(true)
    clock.advance(225)
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("abcdefghijklmnop")
    expect(app.renderer.root.liveCount).toBe(0)

    title.rename = { title: "abcdefghijklmnop", pending: false }
    title.content = "Manual"
    title.rename = { title: "Manual", pending: false }
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("Manual")
    expect(app.renderer.root.liveCount).toBe(0)

    title.rename = { title: "Manual", pending: true }
    await app.renderOnce()
    title.content = "Next"
    title.rename = { title: "Next", pending: false }
    title.enabled = false
    await app.renderOnce()
    expect(app.captureCharFrame().trim()).toBe("Next")
    title.enabled = true
    expect(app.renderer.root.liveCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("native Unicode clipping and shorter replacement leave no split glyphs or old tail", async () => {
  const clock = new ManualClock()
  const app = await createTestRendererTimed({ width: 24, height: 3, useThread: false, clock })
  const content = "A\u65e5B \u{1f680} cafe\u0301"
  const title = new TitleShimmerRenderable(app.renderer, {
    width: 20,
    height: 1,
    content,
    fg: "#eeeeee",
    wrapMode: "none",
    backdrop: RGBA.fromHex("#111111"),
    rename: { title: content, pending: true },
  })
  const plain = new TextRenderable(app.renderer, { width: 20, height: 1, content, wrapMode: "none" })
  const shadedBox = new BoxRenderable(app.renderer, { width: 6, height: 1, marginLeft: 2, overflow: "hidden" })
  const plainBox = new BoxRenderable(app.renderer, { width: 6, height: 1, marginLeft: 2, overflow: "hidden" })
  shadedBox.add(title)
  plainBox.add(plain)
  app.renderer.root.add(shadedBox)
  app.renderer.root.add(plainBox)
  app.renderer.root.add(new TextRenderable(app.renderer, { content: "untouched" }))
  try {
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[0]).toBe(app.captureCharFrame().split("\n")[1])
    title.content = "Short"
    title.rename = { title: "Short", pending: false }
    clock.advance(200)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[0].trim()).toBe("Sh B")
    expect(app.captureCharFrame().split("\n")[2]).toContain("untouched")
    clock.advance(250)
    await app.renderOnce()
    expect(app.captureCharFrame().split("\n")[0].trim()).toBe("Short")
    expect(app.renderer.root.liveCount).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

// The renderer draws a live title again on a timer of its own, whose delay depends on how long the frame before it took
// in real time (OpenTUI's `loop` waits `minTargetFrameTime - floor(frame time)`). The 240 ms fade-out is therefore spread
// over frames whose first boundary moves with the speed of the machine: on a slow runner the first frame fell 10 or 11 ms
// into it and the fade ended at 1e-16, not 0, which left the title live (`liveCount` 1) after the whole fade had passed.
// Every row spends the same 240 ms of the test clock with its first frame at a different point.
test.each([1, 10, 11, 12, 33, 100, 120, 239])(
  "the fade-out ends after 240 ms whatever frame boundary falls %d ms into it",
  async (first) => {
    const clock = new ManualClock()
    const app = await createTestRendererTimed({ width: 24, height: 1, useThread: false, clock })
    const title = new TitleShimmerRenderable(app.renderer, {
      width: 24,
      height: 1,
      content: "Compiler cleanup",
      fg: "#eeeeee",
      backdrop: RGBA.fromHex("#111111"),
      rename: { title: "Compiler cleanup", pending: false },
    })
    app.renderer.root.add(title)
    try {
      await app.renderOnce()
      const colors = app.captureSpans()
      clock.advance(2000)
      title.rename = { title: "Compiler cleanup", pending: true }
      await app.renderOnce()
      clock.advance(120)
      await app.renderOnce()
      clock.advance(120)
      await app.renderOnce()
      title.rename = { title: "Compiler cleanup", pending: false }
      await app.renderOnce()
      expect(app.renderer.root.liveCount).toBe(1)
      clock.advance(first)
      await app.renderOnce()
      clock.advance(240 - first)
      await app.renderOnce()
      expect(app.renderer.root.liveCount).toBe(0)
      expect(app.captureSpans()).toEqual(colors)
    } finally {
      app.renderer.destroy()
    }
  },
)
