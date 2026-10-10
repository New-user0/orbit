import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { findHashImport, verifyArtifact } from "../script/verify-artifact"

const planted = [
  `import("#internal/thing")`,
  `await import( '#thing' )`,
  `require("#thing")`,
  `import x from"#thing"`,
  `import {a} from "#thing/deep.js"`,
]
const clean = [
  `import("./chunk.js")`,
  `import("node:fs")`,
  `require("fs")`,
  `import x from"pkg"`,
  `const label = "#heading"`,
  `text.replace("#", "")`,
]

test.each(planted)("finds a # import: %s", (text) => {
  expect(findHashImport(`var a = 1;${text};var b = 2`)).toBeDefined()
})

test.each(clean)("leaves ordinary code alone: %s", (text) => {
  expect(findHashImport(text)).toBeUndefined()
})

test("fails an artifact that carries a # import, wherever it falls in the file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-verify-artifact-"))
  try {
    const file = path.join(root, "bundle.js")
    await Bun.write(file, `${"x".repeat(2_000_000)};import("#internal/thing")${"y".repeat(10)}`)
    await expect(verifyArtifact(file)).rejects.toThrow("#internal/thing")

    await Bun.write(file, `${"x".repeat(2_000_000)};import("./chunk.js")`)
    await expect(verifyArtifact(file)).resolves.toBeUndefined()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
