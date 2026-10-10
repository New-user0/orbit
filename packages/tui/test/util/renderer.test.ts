import { expect, test } from "bun:test"
import { MarkdownRenderable, SyntaxStyle, TextRenderable, type CliRenderer } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { bodyText, destroyRenderer, outputText, terminalTitle } from "../../src/util/renderer"

// A set-title sequence, one that erases the line, a C1 control sequence introducer and a right-to-left override: what
// a model, a tool or a stored prompt can put into a message body.
const hostile = "a\u001b]0;x\u0007 b\u001b[2K c\u009b d\u202e e"
const written = "a\\x1b]0;x\\x07 b\\x1b[2K c\\x9b d\\u{202e} e"

const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: "#ffffff" },
  "markup.heading": { fg: "#ffffff" },
  "markup.heading.1": { fg: "#ffffff" },
  "markup.list": { fg: "#ffffff" },
})

async function frame(draw: (renderer: CliRenderer) => void, ready = " d") {
  const setup = await createTestRenderer({ width: 60, height: 8, remote: true, useThread: false })
  try {
    draw(setup.renderer)
    setup.renderer.start()
    await setup.waitForFrame((drawn) => drawn.includes(ready))
    return setup.captureCharFrame()
  } finally {
    setup.renderer.destroy()
  }
}

const blocks = {
  text: (renderer: CliRenderer, content: string) => renderer.root.add(new TextRenderable(renderer, { content })),
  markdown: (renderer: CliRenderer, content: string) =>
    renderer.root.add(new MarkdownRenderable(renderer, { content, syntaxStyle, streaming: false, internalBlockMode: "top-level" })),
}

test.each(["text", "markdown"] as const)("draws the control characters of a body written out in a %s block", async (kind) => {
  const drawn = await frame((renderer) => blocks[kind](renderer, bodyText(hostile)))
  expect(drawn).toContain(written)

  // The control run: the same body drawn as it came carries the raw characters to the frame, so the check above can fail.
  const raw = await frame((renderer) => blocks[kind](renderer, hostile), "b")
  expect(raw).toContain("\u001b")
  expect(raw).not.toContain("\\x1b")
})

test("turns a lone carriage return in program output into a line break and writes out the other controls", () => {
  expect(outputText("Receiving 33%\rReceiving 66%\r\ndone\u001b[2K")).toBe("Receiving 33%\nReceiving 66%\ndone\\x1b[2K")
})

test("writes out each control, keeps line breaks and tabs, and leaves a lone carriage return visible", () => {
  expect(bodyText("a\tb\nc\r\nd")).toBe("a\tb\nc\nd")
  expect(bodyText("a\rb")).toBe("a\\x0db")
  expect(bodyText("\u007f\u0085\u009d")).toBe("\\x7f\\x85\\x9d")
  expect(bodyText("\u202a\u202e\u2066\u2069\u200f")).toBe("\\u{202a}\\u{202e}\\u{2066}\\u{2069}\\u{200f}")
})

test("draws ordinary Unicode, emoji and wide characters unchanged, and markdown still renders", async () => {
  const ordinary = "Grüße, 世界 😀 👨‍👩‍👧 ✔️ café\n\t- **bold** `code`"
  expect(bodyText(ordinary)).toBe(ordinary)

  const text = "Grüße 世界 😀 café"
  expect(await frame((renderer) => blocks.text(renderer, bodyText(text)), "café")).toContain(text)

  const markdown = await frame(
    (renderer) => blocks.markdown(renderer, bodyText("Plain words\n\n- one\n- two\n\n```ts\nconst x = 1\n```")),
    "const x = 1",
  )
  // The list becomes bullet rows and the fence is drawn without its backticks.
  expect(markdown.split("\n").filter((row) => row.startsWith("-"))).toHaveLength(2)
  expect(markdown).toContain("const x = 1")
  expect(markdown).not.toContain("```")
})

test("builds the title of the terminal window from a session title and cuts a long one", () => {
  expect(terminalTitle("Fix the build")).toBe("Orbit · Fix the build")
  expect(terminalTitle("x".repeat(40))).toBe(`Orbit · ${"x".repeat(40)}`)
  expect(terminalTitle("x".repeat(41))).toBe(`Orbit · ${"x".repeat(37)}…`)
  expect(terminalTitle("Fix the build", "working")).toBe("Orbit · Fix the build · working")
  expect(terminalTitle("Fix the build", "needs input")).toBe("Orbit · Fix the build · needs input")
  expect(terminalTitle(undefined, "working")).toBe("Orbit · working")
  expect(terminalTitle(undefined)).toBe("Orbit")
})

test("leaves the characters that act on a terminal out of the title of its window", () => {
  // The renderer writes the title into a set-title sequence as it is: a BEL in it ends the sequence early, and what
  // follows is a sequence of its own. A title can come from a model, or from a workflow that an older release ran.
  const title = terminalTitle("work\u0007\u001b]0;pwned\u0007\u001b[2K\u009b\u{202e}done")

  expect(title).toBe("Orbit · work]0;pwned[2Kdone")
  expect(terminalTitle("a\r\nb\tc")).toBe("Orbit · abc")
})

test("clears the terminal title before destroying the renderer", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: false,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:", "destroy"])
})

test("still clears the title after renderer destruction", () => {
  const calls: string[] = []
  destroyRenderer({
    isDestroyed: true,
    setTerminalTitle(title) {
      calls.push(`title:${title}`)
    },
    destroy() {
      calls.push("destroy")
    },
  })
  expect(calls).toEqual(["title:"])
})
