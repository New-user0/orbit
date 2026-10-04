import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStatusLine, firstLine } from "../../src/util/status-line"

test("the status line keeps the first line of output without colors", () => {
  expect(firstLine("\u001b[32mmain\u001b[0m ✓\nsecond line\n")).toBe("main ✓")
  expect(firstLine("\n")).toBeUndefined()
})

test.skipIf(process.platform === "win32")("the status line command reads the session from stdin", async () => {
  const line = await new Promise<string | undefined>((resolve) =>
    createRoot((dispose) => {
      const value = createStatusLine({
        command: () => `cat | sed -E 's/.*"session_id":"([^"]+)".*/session \\1/'`,
        interval: () => 60_000,
        payload: () => ({ session_id: "ses_42" }),
      })
      const poll = setInterval(() => {
        if (!value()) return
        clearInterval(poll)
        resolve(value())
        dispose()
      }, 20)
    }),
  )
  expect(line).toBe("session ses_42")
})
