import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findHashImport, verifyArtifact } from "../script/verify-artifact"

// Every spelling of a `#name` import in the source, each built by the real bundler with the name left external, as the
// release build does, minified and not.
const sources = {
  require: `const m = require("#ext"); console.log(m)`,
  "require in a template": "console.log(require(`#ext`))",
  "require.resolve": `console.log(require.resolve("#ext"))`,
  "side-effect import": `import "#ext"`,
  "dynamic import": `console.log(await import("#ext"))`,
  "default import": `import x from "#ext"; console.log(x)`,
  "namespace import": `import * as x from "#ext"; console.log(x)`,
}
const clean = [
  `import("./chunk.js")`,
  `import("node:fs")`,
  `require("fs")`,
  `import x from"pkg"`,
  `const label = "#heading"`,
  `text.replace("#", "")`,
  `document.querySelector("#app")`,
  `$("#id")`,
]

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-verify-artifact-"))
afterAll(() => fs.rm(root, { recursive: true, force: true }))
const bundle = async (source: string, minify: boolean) => {
  const entry = path.join(root, `entry-${Bun.hash(source)}.ts`)
  await Bun.write(entry, source)
  const built = await Bun.build({ entrypoints: [entry], target: "bun", minify, external: ["#ext"] })
  expect(built.success).toBe(true)
  return built.outputs[0].text()
}

test.each(Object.entries(sources).flatMap(([name, source]) => [true, false].map((minify) => [name, minify, source] as const)))(
  "finds a # import in bundler output: %s (minified: %p)",
  async (_name, minify, source) => {
    expect(findHashImport(await bundle(source, minify))).toBeDefined()
  },
)

test.each(clean)("leaves ordinary code alone: %s", (text) => {
  expect(findHashImport(`var a = 1;${text};var b = 2`)).toBeUndefined()
})

test("fails an artifact that carries a # import, wherever it falls in the file", async () => {
  const file = path.join(root, "bundle.js")
  await Bun.write(file, `${"x".repeat(2_000_000)};import("#internal/thing")${"y".repeat(10)}`)
  await expect(verifyArtifact(file)).rejects.toThrow("#internal/thing")

  await Bun.write(file, `${"x".repeat(2_000_000)};import("./chunk.js")`)
  await expect(verifyArtifact(file)).resolves.toBeUndefined()
})

test("finds the alias binding of an earlier read", async () => {
  const file = path.join(root, "split.js")
  await Bun.write(file, `var o=import.meta.require;${"x".repeat(3_000_000)};o("#ext");`)
  await expect(verifyArtifact(file)).rejects.toThrow("#ext")
})
