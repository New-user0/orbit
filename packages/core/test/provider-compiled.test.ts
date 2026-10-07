import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// A binary made by `bun build --compile` has no node_modules of its own, and Bun looks a name that the binary does not
// bundle up in the folder it was started in, whatever the autoload options are. That folder can be a repository that is
// not trusted yet, and `package` in the user's own provider config can name a package that the repository ships in its
// node_modules. These tests compile fixture/load-package.ts, which calls Provider.loadPackage, start the binary in such
// a folder and look for the marker that each package leaves when it runs.
setDefaultTimeout(60_000)

// The autoload options of the release build, in packages/cli/script/autoload.ts.
const autoload = {
  autoloadBunfig: false,
  autoloadDotenv: false,
  autoloadTsconfig: false,
  autoloadPackageJson: true,
} as const
// The binary is a copy of the Bun runtime, so everything lives in a folder that is removed at the end.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-provider-compiled-"))
const repository = path.join(root, "repository")
const cache = path.join(root, "cache")
const empty = path.join(root, "empty")
const elsewhere = path.join(root, "elsewhere", "provider.js")
let binary = ""

const provider = (marker: string) =>
  `await Bun.write(\`\${process.cwd()}/${marker}.marker\`, "ran")\nexport const model = () => ({})\n`

beforeAll(async () => {
  await Promise.all([
    Bun.write(path.join(repository, "node_modules", "acme-native-provider", "index.js"), provider("repository")),
    Bun.write(
      path.join(repository, "node_modules", "@orbit", "ai", "providers", "acme", "index.js"),
      provider("scope"),
    ),
    // An install names its entry in a package.json, which is why the binary is built to read those.
    Bun.write(
      path.join(cache, "node_modules", "acme-native-provider", "package.json"),
      JSON.stringify({ name: "acme-native-provider", main: "dist/index.js" }),
    ),
    Bun.write(path.join(cache, "node_modules", "acme-native-provider", "dist", "index.js"), provider("cache")),
    Bun.write(elsewhere, provider("file")),
    fs.mkdir(path.join(empty, "node_modules", "acme-native-provider"), { recursive: true }),
  ])
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture", "load-package.ts")],
    compile: { ...autoload, outfile: path.join(root, "load-package") },
  })
  expect(built.success).toBe(true)
  binary = built.outputs[0].path
})

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const markers = async () => (await fs.readdir(repository)).filter((name) => name.endsWith(".marker")).toSorted()

async function start(...args: string[]) {
  await Promise.all((await markers()).map((name) => fs.rm(path.join(repository, name))))
  const child = Bun.spawn([binary, ...args], { cwd: repository, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`the binary exited with ${code}: ${stderr}`)
  const result: { loaded: boolean; error?: string; added?: string[] } = JSON.parse(
    stdout.trim().split("\n").at(-1) ?? "",
  )
  return { ...result, ran: await markers() }
}

// Without this the tests below could pass because the folder never had a way to run its files at all.
test("the binary imports a name it does not bundle from the folder it was started in", async () => {
  expect(await start("import", "acme-native-provider")).toEqual({ loaded: true, ran: ["repository.marker"] })
})

test("loads a package that is not built in from npm and never from the folder the binary was started in", async () => {
  expect(await start("load", "acme-native-provider", cache)).toEqual({
    loaded: true,
    added: ["acme-native-provider"],
    ran: ["cache.marker"],
  })
})

test("does not load a package that is not built in without npm, even when the folder holds it", async () => {
  expect(await start("load", "acme-native-provider")).toMatchObject({
    loaded: false,
    error: expect.stringContaining("acme-native-provider is not installed"),
    ran: [],
  })
})

test("does not fall back to the folder when the install does not hold the package", async () => {
  expect(await start("load", "acme-native-provider", empty)).toMatchObject({
    loaded: false,
    error: expect.stringContaining("Cannot find package 'acme-native-provider'"),
    added: ["acme-native-provider"],
    ran: [],
  })
})

test("refuses a name under @orbit/ai/ that is not built in, without asking npm for it", async () => {
  for (const args of [[], [cache]])
    expect(await start("load", "@orbit/ai/providers/acme", ...args)).toMatchObject({
      loaded: false,
      error: expect.stringContaining("@orbit/ai/providers/acme is not built in"),
      added: [],
      ran: [],
    })
})

test("loads the providers that are built in and a file: URL", async () => {
  expect(await start("load", "@orbit/ai/providers/openai")).toEqual({ loaded: true, added: [], ran: [] })
  expect(await start("load", pathToFileURL(elsewhere).href)).toEqual({ loaded: true, added: [], ran: ["file.marker"] })
})
