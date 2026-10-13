import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRoot } from "solid-js"
import { createStatusLine, outputLines } from "../../src/util/status-line"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test.each([
  { name: "every non-empty line", output: "one\ntwo\nthree\n", lines: ["one", "two", "three"] },
  { name: "a leading blank line", output: "\n\nfirst\nsecond", lines: ["first", "second"] },
  { name: "blank lines between and CRLF", output: "a\r\n\r\n  b  \r\n", lines: ["a", "b"] },
  { name: "nothing but blanks", output: "\n \n\t\n", lines: [] },
  { name: "colors dropped", output: "\u001b[32mgreen\u001b[0m\nplain", lines: ["green", "plain"] },
  {
    name: "at most ten lines",
    output: Array.from({ length: 30 }, (_, index) => `row${index}`).join("\n"),
    lines: Array.from({ length: 10 }, (_, index) => `row${index}`),
  },
])("outputLines keeps $name", (row) => {
  expect(outputLines(row.output)).toEqual([...row.lines])
})

// The command runs through the real shell. Quotes must reach it as typed: on Windows the usual argument escaping writes a
// double quote as \" and cmd.exe does not read that, so a quoted script path or argument failed to run.
test.skipIf(process.platform !== "win32")("a Windows command with double quotes runs as typed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "status line quote-"))
  try {
    await Bun.write(path.join(dir, "tool.cmd"), "@echo off\r\necho tool got %~1\r\n")
    const rows = [
      { command: 'echo "a b" c', expected: ['"a b" c'] },
      { command: `"${path.join(dir, "tool.cmd")}" "x y"`, expected: ["tool got x y"] },
      { command: `echo one & echo "two"`, expected: ["one", '"two"'] },
    ]
    for (const row of rows) {
      const status = createRoot((dispose) => {
        setTimeout(dispose, 3_000)
        return createStatusLine({ command: () => row.command, interval: () => 60_000, payload: () => ({}) })
      })
      await wait(1_500)
      expect({ command: row.command, lines: status.lines() }).toEqual({ command: row.command, lines: row.expected })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)

// A command still running when the terminal UI goes away lives on in its own session on POSIX: nothing else stops it.
// The host process leaves either through cleanup or through process.exit; the marker is written only by a command that
// was left running. The control never leaves, so it is known to write its marker.
test.skipIf(process.platform === "win32").each(["cleanup", "process.exit", "control"])(
  "a status line command in flight is stopped when the host leaves through %s",
  async (leave) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "status-line-exit-"))
    try {
      const marker = path.join(dir, "late.txt")
      const host = path.join(dir, "host.ts")
      const source = path.join(import.meta.dir, "../../src/util/status-line").replaceAll("\\", "/")
      await Bun.write(
        host,
        `import { createRoot } from "solid-js"
import { createStatusLine } from ${JSON.stringify(source)}
const stop = createRoot((dispose) => {
  createStatusLine({ command: () => "sleep 1.5; echo late > '${marker}'", interval: () => 60_000, payload: () => ({}) })
  return dispose
})
await new Promise((resolve) => setTimeout(resolve, 400))
const leave = ${JSON.stringify(leave)}
if (leave === "cleanup") stop()
if (leave === "process.exit") process.exit(0)
await new Promise((resolve) => setTimeout(resolve, leave === "control" ? 2_500 : 100))
process.exit(0)
`,
      )
      const child = Bun.spawn([process.execPath, host], { cwd: path.join(import.meta.dir, "../.."), stdout: "ignore" })
      await child.exited
      await wait(2_500)
      expect(await Bun.file(marker).exists()).toBe(leave === "control")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  30_000,
)
