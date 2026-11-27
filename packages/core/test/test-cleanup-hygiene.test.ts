import { expect, test } from "bun:test"
import path from "node:path"

// Bun's fs.rm ignores `maxRetries` and `retryDelay`: a removal that meets a file another handle still holds fails at
// once (EBUSY on Windows), however many retries it asks for. Tests that remove a folder they ran a program in (a
// compiled binary, a planted decoy, a server with its SQLite database) asked for 20 retries 100 ms apart and got none,
// so their cleanup failed on Windows CI after the tests had passed: the `afterAll` of
// `packages/cli/test/compile-runtime-requires.test.ts` and `packages/core/test/provider-compiled.test.ts`, the
// `afterEach` of `packages/tui/test/util/os-notify.test.ts`, the `tmpdir()` of
// `packages/core/test/effect/cross-spawn-spawner.test.ts` and the ACP fixture (docs/known-failures.md, FU-M1-101).
// A removal that has to wait for a holder goes through the shared helper that tries again until a deadline and names
// what still runs; no file asks Bun for retries that it does not do.
const root = path.resolve(import.meta.dir, "../../..")

test("no test, fixture or script asks fs.rm for retries that Bun ignores", async () => {
  // Bun.Glob does not take a brace list of folders, so each tree is scanned on its own.
  const trees = ["packages/*/test/**/*", "packages/*/script/**/*", "packages/*/src/**/*", "tools/**/*"]
  const offenders: string[] = []
  for (const tree of trees) {
    for await (const file of new Bun.Glob(`${tree}.{ts,tsx,cjs,mjs,js}`).scan({ cwd: root, onlyFiles: true })) {
      // This file holds the scan's own examples.
      if (file.includes("node_modules") || file.endsWith("test-cleanup-hygiene.test.ts")) continue
      const text = await Bun.file(path.join(root, file)).text()
      offenders.push(...retried(text).map((line) => `${file.replaceAll("\\", "/")}:${line}`))
    }
  }
  expect(offenders).toEqual([])
}, 20_000)

// The scan reads a call's whole argument list, so options written over several lines are found too, and an option of
// the same name outside a removal (an MCP transport's reconnection has one) is not.
test("the scan finds maxRetries in a removal's options on one line or several, and nowhere else", () => {
  expect(
    retried(
      [
        `await fs.rm(dir, { recursive: true, maxRetries: 20 })`,
        `await fs.rm(dir, {`,
        `  recursive: true,`,
        `  force: true,`,
        `  maxRetries: 20,`,
        `})`,
        `fs.rmSync(path.join(dir, "x"), { force: true,`,
        `  maxRetries: 3 })`,
        `await fs.rm(dir, { recursive: true, force: true })`,
        `const transport = connect({ reconnection: { maxRetries: 2 } })`,
        `await removeTree(dir)`,
      ].join("\n"),
    ),
  ).toEqual([1, 2, 7])
})

// The line of each `rm(` or `rmSync(` call whose argument list names `maxRetries`. The argument list runs to the
// parenthesis that closes the call; parentheses inside it (a `path.join(...)`) are counted.
function retried(text: string) {
  return [...text.matchAll(/\brm(?:Sync)?\(/g)].flatMap((match) => {
    const start = match.index + match[0].length
    const end = closing(text, start)
    if (!/\bmaxRetries\s*:/.test(text.slice(start, end))) return []
    return [text.slice(0, match.index).split("\n").length]
  })
}

function closing(text: string, start: number) {
  let depth = 1
  for (let index = start; index < text.length; index++) {
    if (text[index] === "(") depth++
    if (text[index] === ")") depth--
    if (depth === 0) return index
  }
  return text.length
}
