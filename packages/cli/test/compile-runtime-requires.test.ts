import { afterAll, expect, test } from "bun:test"
import type { BunPlugin } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { autoload } from "../script/autoload"
import { runtimeRequires, verifyRuntimeRequires } from "../script/runtime-requires"

// Bun resolves a name that a compiled binary does not bundle from the folder the binary starts in, and that folder can
// be a repository that is not trusted yet. The bundler cannot follow every require, so a dependency can leave a name to
// the runtime: js-yaml loads `esprima` through `var _require = require`, Babel hands the browserslist config of the
// folder to browserslist, which loads the package that the config extends and the caniuse-lite file of a feature from
// the same folder, and on Windows the file finder fff looks for its native library in an npm package that the lookup
// finds in the folder. These tests compile a program that does what Orbit does with them: it reads front matter through
// gray-matter, which loads js-yaml, it asks fff where its library is, and it registers the runtime plugin support of
// the terminal UI and then loads a plugin source file, which Babel transforms. The binary starts in a folder that holds
// a marker-writing package for each of those names, and for `ws`, `utf-8-validate` and `bufferutil`, which Orbit never
// takes from the folder.
const entry = (grayMatter: string, fff: string, pluginSupport: string) =>
  [
    `import matter from ${JSON.stringify(grayMatter)}`,
    `import { findBinary } from ${JSON.stringify(fff)}`,
    `import { ensureRuntimePluginSupport } from ${JSON.stringify(pluginSupport)}`,
    `import { pathToFileURL } from "node:url"`,
    ``,
    // gray-matter reads every Markdown file that Orbit reads, and it loads js-yaml when it loads.
    `matter("---\\ntitle: a\\n---\\nbody")`,
    // The server uses the ws that Bun carries. The npm package asks for the other two when it loads, and this one does not.
    `await import("ws")`,
    // fff loads the library that this finds, and the one that is embedded in the binary only when this finds nothing.
    `console.log(JSON.stringify(findBinary()))`,
    // The terminal UI registers this before it loads a plugin: a source file imported after it goes through Babel.
    `ensureRuntimePluginSupport({})`,
    `await import(pathToFileURL(process.argv[2]).href)`,
    ``,
  ].join("\n")
// Core depends on gray-matter and fff and the CLI never imports Core, so they are resolved from there.
const core = path.resolve(import.meta.dir, "../../core")
const grayMatter = Bun.resolveSync("gray-matter", core)
const fff = Bun.resolveSync("@ff-labs/fff-bun", core)
const pluginSupport = Bun.resolveSync("@opentui/solid/runtime-plugin-support/configure", import.meta.dir)
// The npm package that holds the native library of fff, and the file in it. The name depends on the platform and, on
// Linux, on the libc, so a package for each is put in the folder.
const fffPackages = (process.platform === "linux" ? ["-gnu", "-musl"] : [""]).map(
  (libc) => `@ff-labs/fff-bin-${process.platform}-${process.arch}${libc}`,
)
const fffLibrary =
  process.platform === "win32" ? "fff_c.dll" : process.platform === "darwin" ? "libfff_c.dylib" : "libfff_c.so"
// Each compiled program is a copy of the Bun runtime, so each gets a folder of its own that is removed at the end.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-runtime-requires-"))
let compiled = 0

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// The binary is started in the repository, so that is where every package leaves its marker. A package exports an empty
// array, which a browserslist config that extends it and an esprima that nobody calls both accept.
const marker = (name: string) => `require("fs").writeFileSync(process.cwd() + "/${name}.marker", "ran")\nmodule.exports = []\n`

async function startedInRepository(plugins: BunPlugin[]) {
  const directory = path.join(root, String(compiled++))
  await Bun.write(path.join(directory, "entry.ts"), entry(grayMatter, fff, pluginSupport))
  const built = await Bun.build({
    entrypoints: [path.join(directory, "entry.ts")],
    plugins,
    compile: { ...autoload, outfile: path.join(directory, "binary") },
  })
  expect(built.success).toBe(true)

  const repository = path.join(directory, "repository")
  const packages = path.join(repository, "node_modules")
  const plugin = path.join(directory, "home", "plugin.tsx")
  // The browserslist config of a repository: a package to extend, and a feature whose data is a file of caniuse-lite.
  await Bun.write(
    path.join(repository, "package.json"),
    JSON.stringify({ name: "repository", browserslist: ["extends browserslist-config-evil", "supports css-grid"] }),
  )
  await Promise.all([
    ...["esprima", "browserslist-config-evil", "ws", "utf-8-validate", "bufferutil"].map((name) =>
      Bun.write(path.join(packages, name, "index.js"), marker(name)),
    ),
    Bun.write(path.join(packages, "caniuse-lite", "data", "features", "css-grid.js"), marker("caniuse-lite")),
    ...fffPackages.flatMap((name) => [
      Bun.write(path.join(packages, name, "package.json"), JSON.stringify({ name })),
      Bun.write(path.join(packages, name, fffLibrary), "not a native library"),
    ]),
    // The plugin of the user is a source file outside the repository.
    Bun.write(plugin, `export const view = () => <box>{1}</box>\n`),
  ])

  const child = Bun.spawn([built.outputs[0].path, plugin], {
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
  const ran = (await fs.readdir(repository)).filter((name) => name.endsWith(".marker")).toSorted()
  // The library that fff would load, relative to the repository when it is in there.
  const found: string | null = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null")
  return { code, ran, found: found && path.relative(repository, found), stderr }
}

test("a binary built with the runtime-requires plugin runs nothing that the folder it starts in supplies", async () => {
  const replaced = new Set<string>()
  const started = await startedInRepository([runtimeRequires(replaced)])
  // The plugin took effect on the modules of this build, and the program ran to the end.
  expect(() => verifyRuntimeRequires(replaced)).not.toThrow()
  expect(started).toMatchObject({ code: 0, ran: [], found: null })
}, 180_000)

// Without this the test above could pass because the folder never had a way to run its files at all. Only the names
// that a dependency looks up run: ws and utf-8-validate are modules of Bun, and nothing asks for bufferutil.
test("the same folder runs esprima, the package that browserslist extends and a caniuse-lite file when the binary is built without it", async () => {
  const started = await startedInRepository([])
  expect(started.ran).toEqual(["browserslist-config-evil.marker", "caniuse-lite.marker", "esprima.marker"])
  // The lookup of fff starts at the virtual root of the binary, and ends in the folder, only where the path of that root
  // does not say `$bunfs`, which is Windows. Elsewhere it starts next to the binary.
  if (process.platform === "win32")
    expect(started.found).toEqual(path.join("node_modules", fffPackages[0], fffLibrary))
}, 180_000)

test("the build fails when a module that runtime-requires replaces is not in its graph", () => {
  expect(() => verifyRuntimeRequires(new Set(["js-yaml js/function"]))).toThrow(
    "Build graph never loaded what runtime-requires replaces: Babel resolve-targets, fff-bun download",
  )
})
