import { stat } from "node:fs/promises"
import path from "node:path"
import { collectFiles } from "./files"

const forbidden = [
  "@napi-rs/canvas",
  "@fontsource/commit-mono",
  "@fontsource/noto-sans",
  "SimulationPng",
  "frontend/png",
  "Failed to register screenshot font",
  "commit-mono-latin-400-normal",
  "noto-sans-symbols-symbols-400-normal",
  "noto-sans-math-math-400-normal",
  "CommitMono-400-Regular.otf",
  "NotoSansSymbols.ttf",
  "src/frontend/png.ts",
  "skia.darwin-",
  "skia.linux-",
  "skia.win32-",
]
// A `#name` import maps through the `imports` field of the package.json nearest the file that asks, and the binary
// starts in a folder that can be an untrusted repository. The bundler resolves every one of them at build time, so
// none may reach the output (see autoload.ts). Bun writes an import as `import("#x")`, `import"#x"` or `from"#x"`, and
// a require as `__require("#x")` or, minified, a call through a variable bound to `import.meta.require`.
const nameLiteral = "\\s*[\"'`]#[^\"'`\\s]{1,200}[\"'`]"
const importForm = new RegExp(`\\bimport\\s*\\(?${nameLiteral}|\\bfrom${nameLiteral}`)
// The lookbehind keeps a long run of name characters from being tried at every position.
const requireAlias = /(?<![\w$])([\w$]+)\s*=\s*import\.meta\.require\b/g
const overlap = Math.max(256, ...forbidden.map((value) => value.length)) - 1

/**
 * The first import of a `#name` in `text`, or undefined. `aliases` holds the names bound to `import.meta.require`; the
 * scan of a large file passes the same set for every chunk, because the binding comes before its uses.
 */
export function findHashImport(text: string, aliases = new Set<string>()) {
  for (const match of text.matchAll(requireAlias)) aliases.add(match[1])
  const names = ["__require", "require", ...aliases].map((name) => name.replace(/\$/g, "\\$"))
  const call = new RegExp(`(?<![\\w$.])(?:${names.join("|")})(?:\\.resolve)?\\s*\\(${nameLiteral}`)
  return importForm.exec(text)?.[0] ?? call.exec(text)?.[0]
}

export async function verifyArtifact(target: string) {
  const files = await artifactFiles(target)
  if (files.length === 0) throw new Error(`Artifact contains no published files: ${target}`)
  for (const file of files) await scan(file)
}

export function verifySimulationGraph(inputs: Iterable<string>) {
  const modules = Array.from(inputs, (input) => input.replaceAll("\\", "/"))
  const required = [
    "/packages/simulation/src/frontend/simulation.ts",
    "/packages/simulation/src/frontend/server.ts",
    "/packages/simulation/src/control-server.ts",
  ]
  const missing = required.filter((input) => !modules.some((module) => module.endsWith(input)))
  if (missing.length > 0) throw new Error(`Build graph is missing simulation bridge inputs: ${missing.join(", ")}`)
  const leaked = modules.find((module) => module.includes("/packages/simulation/src/frontend/png."))
  if (leaked) throw new Error(`Build graph contains Drive-only rendering input: ${leaked}`)
}

async function artifactFiles(target: string): Promise<string[]> {
  if ((await stat(target)).isFile()) return [target]
  return (await collectFiles(target)).map((file) => path.join(target, file))
}

async function scan(file: string) {
  let trailing = ""
  const aliases = new Set<string>()
  const reader = Bun.file(file).stream().getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    const text = trailing + Buffer.from(chunk.value).toString("latin1")
    const leaked = forbidden.find((marker) => text.includes(marker))
    if (leaked) throw new Error(`Artifact file ${file} contains forbidden simulation payload: ${leaked}`)
    const hash = findHashImport(text, aliases)
    if (hash) throw new Error(`Artifact file ${file} imports a name that the runtime would resolve from the folder: ${hash}`)
    trailing = text.slice(-overlap)
  }
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error("Usage: bun run script/verify-artifact.ts <file-or-directory>")
  await verifyArtifact(target)
}
