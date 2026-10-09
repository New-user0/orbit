import { expect, test } from "bun:test"
import path from "node:path"

// Two files in the shape the Patch tool joins into one request's `diff`: each starts with `Index:` and `===`.
const file = (name: string, before: string, after: string) =>
  `Index: ${name}\n${"=".repeat(67)}\n--- ${name}\n+++ ${name}\n@@ -1,1 +1,1 @@\n-${before}\n+${after}\n`
const joined = [file("a.txt", "one", "uno"), file("b.txt", "two", "dos")].map((item) => item + "\n").join("")

// The split runs in its own process with a deadline: a loop that never advances blocks the event loop, so the test
// runner's own timeout could not end it.
test("a patch that joins several files splits into hunks without spinning", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { splitPatchHunks } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/util/diff.ts"))})
console.log(JSON.stringify(splitPatchHunks(${JSON.stringify(joined)}).map((hunk) => hunk.header)))`,
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
  )
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(JSON.parse(output)).toEqual(["@@ -1,1 +1,1 @@", "@@ -1,1 +1,1 @@"])
})
