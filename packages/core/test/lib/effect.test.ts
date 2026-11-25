import { expect, test } from "bun:test"
import path from "node:path"

// A row that Bun's time limit ends is reported as failed, but Bun cannot stop the Effect behind it. When that Effect went
// on, it recorded into what the next row then read, and the next row failed with an assertion that looked like a
// regression of its own (FU-M4-235, a ShellTool permission question). The harness now stops it before the next row
// starts. The rows run in their own `bun test`, because the first of them fails on purpose.
test("a row that passes its time limit stops before the next row runs", async () => {
  const child = Bun.spawn([process.execPath, "test", "./" + path.join("test", "lib", "effect-timeout-child.ts")], {
    cwd: path.join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  })
  const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  const report = output + errors
  // Bun names only the rows that fail: the first, for its time limit, and not the second.
  expect(report).toContain("(fail) a row that passes its time limit")
  expect(report).toContain("this test timed out after 100ms")
  expect(report).not.toContain("(fail) the next row reads only what it recorded")
  expect(report).toContain("\n 1 pass\n 1 fail\n")
  expect(report).not.toContain("Unhandled error")
}, 60_000)
