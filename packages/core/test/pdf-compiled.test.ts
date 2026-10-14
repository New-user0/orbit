import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { autoload } from "../../cli/script/autoload"
import { makePdf } from "./lib/pdf"

// The PDF library loads with a dynamic import, which a compiled binary must bundle: a name the bundle leaves open is
// looked up in the folder the binary starts in, and that folder can be a repository that is not trusted yet. These tests
// compile fixture/pdf-pages.ts, start the binary in a folder that holds a marker-writing `pdf-lib`, and cut pages through it.
setDefaultTimeout(120_000)

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-pdf-compiled-"))
const repository = path.join(root, "repository")
const entry = path.join(import.meta.dir, "fixture", "pdf-pages.ts")
let binary = ""
const decoys = ["pdf-lib", "pako", "tslib", "@pdf-lib/standard-fonts", "@pdf-lib/upng"]

beforeAll(async () => {
  await Promise.all([
    // A decoy for the library and for every package it brought into the lockfile, each writing its own marker.
    ...decoys.map((name) =>
      Bun.write(
        path.join(repository, "node_modules", name, "index.js"),
        `require("fs").writeFileSync(process.cwd() + "/decoy-${name.replace("/", "-")}.marker", "ran")\nmodule.exports = {}\n`,
      ),
    ),
    Bun.write(path.join(repository, "document.pdf"), await makePdf(6)),
  ])
  const built = await Bun.build({ entrypoints: [entry], compile: { ...autoload, outfile: path.join(root, "pdf-pages") } })
  expect(built.success).toBe(true)
  binary = built.outputs[0].path
})

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

test("cuts pages through the compiled binary and never loads the library from the folder it started in", async () => {
  const child = Bun.spawn([binary, "document.pdf", "2", "4"], {
    cwd: repository,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).toEqual({ total: 6, cut: 3 })
  const planted = await Promise.all(
    decoys.map((name) => Bun.file(path.join(repository, `decoy-${name.replace("/", "-")}.marker`)).exists()),
  )
  expect(planted).toEqual(decoys.map(() => false))
})

test("the bundle leaves nothing for the runtime to resolve", async () => {
  const built = await Bun.build({ entrypoints: [entry], target: "bun", minify: false })
  expect(built.success).toBe(true)
  const text = (await Promise.all(built.outputs.map((output) => output.text()))).join("\n")

  // The library is inside the bundle, so these would only appear as imports the bundler could not follow.
  expect(text).not.toMatch(/\bimport\(\s*["']pdf-lib["']\s*\)/)
  expect(text).not.toMatch(/\brequire\(\s*["'](?:canvas|@napi-rs\/canvas)["']\s*\)/)
  expect(text).not.toContain("__require(")
  expect(text).not.toContain("new Function")
  expect(text).not.toContain("eval(")
  expect(text).not.toContain("dlopen")
  expect(text).not.toContain("createRequire")
  expect(text).not.toContain("import.meta.resolve")
  expect(text).not.toMatch(/new Worker\(/)
})
