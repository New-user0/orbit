import { expect, test } from "bun:test"
import { destroyRenderer, terminalTitle } from "../../src/util/renderer"

test("builds the title of the terminal window from a session title and cuts a long one", () => {
  expect(terminalTitle("Fix the build")).toBe("OC | Fix the build")
  expect(terminalTitle("x".repeat(40))).toBe(`OC | ${"x".repeat(40)}`)
  expect(terminalTitle("x".repeat(41))).toBe(`OC | ${"x".repeat(37)}…`)
})

test("leaves the characters that act on a terminal out of the title of its window", () => {
  // The renderer writes the title into a set-title sequence as it is: a BEL in it ends the sequence early, and what
  // follows is a sequence of its own. A title can come from a model, or from a workflow that an older release ran.
  const title = terminalTitle("work\u0007\u001b]0;pwned\u0007\u001b[2K\u009b\u{202e}done")

  expect(title).toBe("OC | work]0;pwned[2Kdone")
  expect(terminalTitle("a\r\nb\tc")).toBe("OC | abc")
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
