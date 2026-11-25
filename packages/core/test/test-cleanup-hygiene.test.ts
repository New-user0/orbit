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
      if (file.includes("node_modules")) continue
      const text = await Bun.file(path.join(root, file)).text()
      text.split("\n").forEach((line, index) => {
        // A removal's options, not another option of the same name (an MCP transport's reconnection has one).
        if (/\brm(Sync)?\(.*\bmaxRetries\s*:/.test(line)) offenders.push(`${file.replaceAll("\\", "/")}:${index + 1}`)
      })
    }
  }
  expect(offenders).toEqual([])
})
