#!/usr/bin/env bun

import { $ } from "bun"
import { chmod, mkdir, rm } from "fs/promises"
import path from "path"
import { Script } from "@orbit/script"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { BunPlugin } from "bun"
import pkg from "../package.json"
import { verifyArtifact, verifySimulationGraph } from "./verify-artifact"

const dir = path.resolve(import.meta.dirname, "..")
const binary = "orb"
const outdir = path.resolve(
  dir,
  process.argv.find((arg) => arg.startsWith("--outdir="))?.slice("--outdir=".length) ?? "dist",
)
if (outdir === dir) throw new Error("--outdir must not be the package directory")
process.chdir(dir)

await rm(outdir, { recursive: true, force: true })

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const requestedTarget = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
const skipInstall = process.argv.includes("--skip-install")
const solidPlugin = createSolidTransformPlugin()
const releaseAssets = new Map<string, Promise<Map<string, string>>>()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

const targets =
  requestedTarget !== undefined
    ? allTargets.filter((item) => targetName(item) === requestedTarget)
    : singleFlag
      ? allTargets.filter((item) => {
          if (item.os !== process.platform || item.arch !== process.arch) return false
          if (item.avx2 === false) return baselineFlag
          return item.abi === undefined
        })
      : allTargets
if (!targets.length) throw new Error(`Unknown build target: ${requestedTarget}`)

if (!skipInstall) await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`
for (const item of targets) {
  const simulationInputs = new Set<string>()
  const simulationGraphPlugin: BunPlugin = {
    name: "orbit-simulation-graph",
    setup(build) {
      build.onLoad(
        { filter: /packages[/\\]simulation[/\\]src[/\\](frontend[/\\](simulation|server)|control-server)\.ts$/ },
        (args) => void simulationInputs.add(args.path),
      )
    },
  }
  const parcelWatcherPackage = `@parcel/watcher-${item.os}-${item.arch}${item.os === "linux" ? `-${item.abi ?? "glibc"}` : ""}`
  const parcelWatcherPlugin: BunPlugin = {
    name: "parcel-watcher-binding",
    setup(build) {
      build.onLoad({ filter: /filesystem[/\\]watcher-binding\.ts$/ }, () => ({
        contents: `export default () => require(${JSON.stringify(parcelWatcherPackage)})`,
        loader: "js",
      }))
    },
  }
  const target = targetName(item)
  const name = target.replace(binary, "cli")
  const executablePath = await brandRuntime(item, await compileExecutable(item))
  console.log(`building ${name}`)
  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    tsconfig: "./tsconfig.json",
    plugins: [solidPlugin, parcelWatcherPlugin, simulationGraphPlugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    bytecode: true,
    sourcemap: Script.channel === "dev" || Script.channel === "local" ? "inline" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: target.replace(binary, "bun") as Bun.Build.CompileTarget,
      executablePath,
      outfile: path.join(outdir, name, "bin", binary),
      execArgv: [
        "--smol",
        `--user-agent=orbit/${Script.channel}/${Script.version}/cli`,
        "--use-system-ca",
        "--no-warnings",
        "--",
      ],
      windows: {},
    },
    define: {
      ORBIT_VERSION: `'${Script.version}'`,
      ORBIT_CLI_NAME: "'orb'",
      ORBIT_CHANNEL: `'${Script.channel}'`,
      ORBIT_ARTIFACT: `'cli'`,
      ORBIT_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      // FFF_LIBC selects the fff native lib variant: "musl" or "gnu".
      FFF_LIBC: item.os === "linux" ? `'${item.abi ?? "gnu"}'` : "undefined",
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  verifySimulationGraph(simulationInputs)

  await Bun.write(
    path.join(outdir, name, "package.json"),
    JSON.stringify(
      {
        name: `@orbit/${name}`,
        version: Script.version,
        license: "MIT",
        repository: { type: "git", url: "git+https://orbit.invalid" },
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  await verifyArtifact(path.join(outdir, name))
}

// The Bun runtime embedded in every compiled binary carries the upstream product name in two places: its
// trusted-dependency list for lifecycle scripts, and a local variable in its styleText builtin. Patch a copy of the
// runtime with same-length replacements before compiling, so the compiled binary never contains the name.
// The trusted-dependency entry becomes a name npm cannot publish (uppercase), and keeps the list's sort order.
async function brandRuntime(item: (typeof allTargets)[number], downloaded: string | undefined) {
  const native =
    item.os === process.platform && item.arch === process.arch && item.abi === undefined && item.avx2 === undefined
  if (!downloaded && !native)
    throw new Error(`Set BUN_COMPILE_RELEASE to build ${targetName(item)}: cross-target runtimes must be patched`)
  const source = downloaded ?? process.execPath
  const runtime = path.join(outdir, ".bun", "branded", targetName(item), path.basename(source))
  const word = ["open", "code"].join("")
  const replacements = [
    [`${word}-ai`, "opXXXXXX-ai"],
    [`${word.slice(0, 4)}C${word.slice(5)}s`, "leadCodes"],
  ]
  const bytes = replacements.reduce(
    (text, [from, to]) => {
      if (!text.includes(from))
        throw new Error(`Bun runtime ${source} no longer contains the expected ${from.length}-byte name`)
      return text.replaceAll(from, to)
    },
    Buffer.from(await Bun.file(source).arrayBuffer()).toString("latin1"),
  )
  if (bytes.toLowerCase().includes(word)) throw new Error(`Bun runtime ${source} contains an unpatched product name`)
  await mkdir(path.dirname(runtime), { recursive: true })
  await Bun.write(runtime, Buffer.from(bytes, "latin1"))
  await chmod(runtime, 0o755)
  return runtime
}

async function compileExecutable(item: (typeof allTargets)[number]) {
  const release = process.env.BUN_COMPILE_RELEASE
  if (!release) return

  const platform = item.os === "win32" ? "windows" : item.os
  const name = [
    "bun",
    platform,
    item.arch === "arm64" ? "aarch64" : item.arch,
    item.abi,
    item.avx2 === false ? "baseline" : undefined,
  ]
    .filter(Boolean)
    .join("-")
  const cache = path.join(outdir, ".bun", release)
  const executable = path.join(cache, name, item.os === "win32" ? "bun.exe" : "bun")
  if (await Bun.file(executable).exists()) return executable

  await mkdir(cache, { recursive: true })
  const archive = path.join(cache, `${name}.zip`)
  const assets = await compileReleaseAssets(release)
  const url = assets.get(`${name}.zip`)
  if (!url) throw new Error(`Bun release ${release} does not include ${name}.zip`)
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  const response = await fetch(url, {
    headers: { Accept: "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (!response.ok) throw new Error(`Failed to download ${name} from Bun release ${release}: ${response.status}`)
  // Stream to disk instead of `Bun.write(archive, response)`: passing the Response object
  // hangs forever if it gets GC'd mid-download (https://github.com/oven-sh/bun/issues/40278).
  const sink = Bun.file(archive).writer()
  for await (const chunk of response.body!) await sink.write(chunk)
  await sink.end()
  await $`unzip -oq ${archive} -d ${cache}`
  await rm(archive)
  return executable
}

function compileReleaseAssets(release: string) {
  const existing = releaseAssets.get(release)
  if (existing) return existing
  const pending = fetch(`https://api.github.com/repos/oven-sh/bun/releases/tags/${release}?cache=${Date.now()}`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Failed to resolve Bun release ${release}: ${response.status}`)
      const data: unknown = await response.json()
      if (typeof data !== "object" || data === null || !("assets" in data) || !Array.isArray(data.assets)) {
        throw new Error(`Bun release ${release} returned invalid metadata`)
      }
      return new Map(
        data.assets
          .filter(
            (asset): asset is { name: string; url: string } =>
              typeof asset === "object" &&
              asset !== null &&
              "name" in asset &&
              typeof asset.name === "string" &&
              "url" in asset &&
              typeof asset.url === "string",
          )
          .map((asset) => [asset.name, asset.url]),
      )
    })
    .catch((error) => {
      releaseAssets.delete(release)
      throw error
    })
  releaseAssets.set(release, pending)
  return pending
}

function targetName(item: (typeof allTargets)[number]) {
  return [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
}
