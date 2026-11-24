// m5-quality, FU-M5-009 (classes 6 and 9): a model's Markdown reaches ACP clients that render it, each text on its own,
// every chunk of a message ID together, or every chunk of one kind appended into one block. Over fuzzed text in random
// pieces, spread over messages and over message and thought kinds, live and on a session/load replay, no image or raw
// tag renders in any of those with Bun's renderer or with `marked`, and text with neither comes back as written but for
// word joiners. The fuzz runs in a child process with a deadline, since a tracker that loops would block the test
// runner's own timeout.
import { expect, test } from "bun:test"
import path from "path"

const SEED = 20261124
const CASES = 20_000
const DEADLINE = 150_000

async function fuzz(renderer: "bun" | "marked") {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "image-fuzz.ts"), `${SEED}`, `${CASES}`, renderer],
    {
      cwd: path.join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "inherit",
    },
  )
  const timer = setTimeout(() => child.kill(), DEADLINE)
  const output = await new Response(child.stdout).text()
  clearTimeout(timer)
  expect(await child.exited).toBe(0)
  return JSON.parse(output) as {
    counts: { cases: number; controls: number }
    failures: { mode: string; parts: unknown }[]
    controls: { input: string }[]
  }
}

test(
  "the model's Markdown: no image or raw tag renders, in any piece, text or client, over fuzzed text, with either renderer",
  async () => {
    const results = await Promise.all([fuzz("bun"), fuzz("marked")])
    for (const result of results) {
      expect(result.counts.cases).toBe(CASES)
      expect(result.counts.controls).toBeGreaterThan(CASES / 2)
      expect(result.failures.map((failure) => ({ mode: failure.mode, parts: failure.parts }))).toEqual([])
      expect(result.controls).toEqual([])
    }
  },
  DEADLINE + 10_000,
)
