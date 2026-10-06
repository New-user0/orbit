import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { autoload } from "../script/autoload"

// The compiled binary starts in whatever folder it is run in, which can be a repository that is not trusted yet. A
// `tsconfig.json` whose `paths` map every import to a file of the repository, or a `package.json` whose `imports` map
// one name to a file, would make an import inside the binary run that file before any trust check. These tests compile
// a small program with the autoload options of the real build, start it in such a folder and look for the marker that
// each file leaves when it runs. The program only imports the names it is given, which the compiler cannot resolve
// ahead of time, so they are resolved by the binary at the moment it runs, as an import that was left external is.
const entry = `for (const name of process.argv.slice(2)) await import(name).catch(() => undefined)\n`
// Each compiled program is a copy of the Bun runtime, so each gets a folder of its own that is removed at the end.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-autoload-"))
let compiled = 0

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

async function startedInRepository(options: Bun.CompileBuildOptions) {
  const directory = path.join(root, String(compiled++))
  await Bun.write(path.join(directory, "entry.ts"), entry)
  const built = await Bun.build({
    entrypoints: [path.join(directory, "entry.ts")],
    compile: { ...options, outfile: path.join(directory, "binary") },
  })
  expect(built.success).toBe(true)

  const repository = path.join(directory, "repository")
  await Bun.write(
    path.join(repository, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "*": ["./by-tsconfig.ts"] } } }),
  )
  await Bun.write(
    path.join(repository, "package.json"),
    JSON.stringify({ name: "repository", imports: { "#by-package": "./by-package.ts" } }),
  )
  for (const via of ["tsconfig", "package"])
    await Bun.write(
      path.join(repository, `by-${via}.ts`),
      `await Bun.write(\`\${import.meta.dir}/${via}.marker\`, "ran")\nexport default {}\n`,
    )

  const child = Bun.spawn([built.outputs[0].path, "some-package", "#by-package"], {
    cwd: repository,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  expect(await child.exited).toBe(0)
  return {
    tsconfig: await Bun.file(path.join(repository, "tsconfig.marker")).exists(),
    package: await Bun.file(path.join(repository, "package.marker")).exists(),
  }
}

test("the build loads nothing from the folder the binary starts in", () => {
  expect(Object.keys(autoload).toSorted()).toEqual([
    "autoloadBunfig",
    "autoloadDotenv",
    "autoloadPackageJson",
    "autoloadTsconfig",
  ])
  expect(Object.values(autoload).filter(Boolean)).toEqual([])
})

test("a binary built with the autoload options does not run the files that the tsconfig.json and package.json of its folder point at", async () => {
  expect(await startedInRepository(autoload)).toEqual({ tsconfig: false, package: false })
}, 60_000)

// Without these the test above could pass because the repository never had a way to run its files at all.
test("the same folder runs its files when the binary is built to read its tsconfig.json or its package.json", async () => {
  expect(await startedInRepository({ ...autoload, autoloadTsconfig: true })).toMatchObject({ tsconfig: true })
  expect(await startedInRepository({ ...autoload, autoloadPackageJson: true })).toMatchObject({ package: true })
}, 60_000)
