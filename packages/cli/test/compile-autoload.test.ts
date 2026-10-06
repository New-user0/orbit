import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { autoload } from "../script/autoload"

// The compiled binary starts in whatever folder it is run in, which can be a repository that is not trusted yet. A
// `tsconfig.json` whose `paths` map every import to a file of the repository would make an import inside the binary run
// that file before any trust check, so the binary is built not to read it. It does read `package.json` files, because
// module resolution needs them to find the entry that a package names with `main` or `exports`. These tests compile a
// small program with the autoload options of the real build, start it in a folder that holds both kinds of file and
// look for the marker that each file leaves when it runs. The program only imports the names it is given, which the
// compiler cannot resolve ahead of time, so they are resolved by the binary at the moment it runs, as an import that
// was left external is.
const entry = `for (const name of process.argv.slice(2)) await import(name).catch(() => undefined)\n`
// Each compiled program is a copy of the Bun runtime, so each gets a folder of its own that is removed at the end.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-autoload-"))
let compiled = 0

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// The binary is started in the repository, so that is where every file leaves its marker.
const marker = (name: string) => `await Bun.write(\`\${process.cwd()}/${name}.marker\`, "ran")\nexport default {}\n`

async function startedInRepository(options: Bun.CompileBuildOptions) {
  const directory = path.join(root, String(compiled++))
  await Bun.write(path.join(directory, "entry.ts"), entry)
  const built = await Bun.build({
    entrypoints: [path.join(directory, "entry.ts")],
    compile: { ...options, outfile: path.join(directory, "binary") },
  })
  expect(built.success).toBe(true)

  // The tsconfig.json maps every name to one file, and the package.json maps one `#name` to another.
  const repository = path.join(directory, "repository")
  await Bun.write(
    path.join(repository, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "*": ["./by-tsconfig.ts"] } } }),
  )
  await Bun.write(
    path.join(repository, "package.json"),
    JSON.stringify({ name: "repository", imports: { "#by-package": "./by-package.ts" } }),
  )
  for (const via of ["tsconfig", "package"]) await Bun.write(path.join(repository, `by-${via}.ts`), marker(via))

  // A workflow of the repository imports from its node_modules: a package whose entry the package.json names with
  // `main`, one whose entry it names with `exports`, and one that is only an index.js.
  const packages = path.join(repository, "node_modules")
  await Bun.write(
    path.join(packages, "by-main", "package.json"),
    JSON.stringify({ name: "by-main", main: "lib/entry.js" }),
  )
  await Bun.write(path.join(packages, "by-main", "lib", "entry.js"), marker("main"))
  await Bun.write(
    path.join(packages, "by-exports", "package.json"),
    JSON.stringify({ name: "by-exports", exports: { ".": "./dist/entry.js" } }),
  )
  await Bun.write(path.join(packages, "by-exports", "dist", "entry.js"), marker("exports"))
  await Bun.write(path.join(packages, "by-index", "index.js"), marker("index"))
  const workflows = await Promise.all(
    ["main", "exports", "index"].map(async (via) => {
      const workflow = path.join(repository, `uses-${via}.ts`)
      await Bun.write(workflow, `import "by-${via}"\n`)
      return workflow
    }),
  )

  const child = Bun.spawn([built.outputs[0].path, "some-package", "#by-package", ...workflows], {
    cwd: repository,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  expect(await child.exited).toBe(0)
  const ran = (via: string) => Bun.file(path.join(repository, `${via}.marker`)).exists()
  return {
    tsconfig: await ran("tsconfig"),
    package: await ran("package"),
    main: await ran("main"),
    exports: await ran("exports"),
    index: await ran("index"),
  }
}

test("the build reads the package.json files that resolution needs and nothing else from the folder", () => {
  expect(autoload).toEqual({
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: true,
  })
})

test("a binary built with the autoload options resolves packages through package.json and not through tsconfig.json", async () => {
  expect(await startedInRepository(autoload)).toEqual({
    // The demonstrated attack: a tsconfig.json whose `paths` map every import to a file of the repository.
    tsconfig: false,
    // The `imports` of the package.json redirect a `#name` import inside the binary to a file of the repository. That is
    // why the binary must not import a `#name` at runtime, and it imports none: the bundler resolves them when it builds.
    package: true,
    // The packages that a workflow imports from the node_modules of the repository resolve, however they name their entry.
    main: true,
    exports: true,
    index: true,
  })
}, 60_000)

// Without these the test above could pass because the folder never had a way to run its files at all, or because the
// packages resolve whatever the options are.
test("the same folder runs its tsconfig.json file when the binary is built to read it", async () => {
  expect(await startedInRepository({ ...autoload, autoloadTsconfig: true })).toMatchObject({ tsconfig: true })
}, 60_000)

test("a binary built not to read package.json files finds no entry that a package names and no #name import", async () => {
  expect(await startedInRepository({ ...autoload, autoloadPackageJson: false })).toEqual({
    tsconfig: false,
    package: false,
    main: false,
    exports: false,
    index: true,
  })
}, 60_000)
