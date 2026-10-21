#!/usr/bin/env bun
/**
 * Brand gate and rename tool.
 *
 *   bun tools/rebrand/rebrand.ts --check   exit 1 if the upstream brand appears anywhere in the tree
 *   bun tools/rebrand/rebrand.ts --apply   rename contents and paths to Orbit (re-run after every upstream merge)
 *   bun tools/rebrand/rebrand.ts --scan <dir>   exit 1 if a built artifact contains the upstream brand or the notice file
 *
 * The upstream names are assembled at runtime so this file never contains them literally.
 * THIRD_PARTY_NOTICES.txt is the only file allowed to keep the upstream name. The tree has no such file, by the owner's
 * decision (2026-10-19, declined again), so today no file may hold the name.
 * files.ts lists the files; without .git, which an exported tree lacks, --check reads the tree instead.
 */
import { $ } from "bun"
import path from "node:path"
import { hasGit, listFiles, readText, root } from "./files.ts"

const word = ["open", "code"].join("")
const org = ["anomaly", "co"].join("")
const share = ["op", "ncd"].join("")
// The one allowed name is of a file that is not in the tree (no notice file, by the owner's decision of 2026-10-19).
const allowed = new Set(["THIRD_PARTY_NOTICES.txt"])
// License files are never rewritten: changing a copyright line would misstate who holds it. An upstream
// license copy fails the check instead. There is no notice file to move it to: the owner decided not to add one.
const license = (file: string) => /^(licen[cs]e|copying|notice)/i.test(path.basename(file))

// Reserved TLD: links that used to point at the upstream site can never resolve or leak traffic.
const host = "orbit.invalid"
const commands = [
  "serve",
  "service",
  "auth",
  "run",
  "mcp",
  "plugin",
  "models",
  "stats",
  "session",
  "debug",
  "acp",
  "api",
  "mini",
  "pair",
  "reload",
]

const rules: Array<[RegExp, string | ((match: string) => string)]> = [
  [new RegExp(`https?://(?:[a-z0-9-]+\\.)*${word}\\.ai`, "gi"), `https://${host}`],
  [new RegExp(`(?:[a-z0-9-]+\\.)*${word}\\.ai`, "gi"), host],
  // Regex sources escape the dot (`name\.ai`); map those too, or they would become a real domain we do not own.
  [new RegExp(`${word}\\\\\\.ai`, "gi"), "orbit\\.invalid"],
  [new RegExp(`https?://(?:[a-z0-9-]+\\.)*${share}\\.ai`, "gi"), `https://${host}`],
  [new RegExp(`https?://github\\.com/${org}/[A-Za-z0-9._-]+`, "gi"), `https://${host}`],
  [new RegExp(org, "gi"), "orbit"],
  [new RegExp(`\\b${word}(?= (?:(?:${commands.join("|")})\\b|-))`, "g"), "orb"],
  [new RegExp(word, "gi"), brand],
]
const pattern = new RegExp(`${word}|${org}|${share}\\.ai`, "i")

const mode = process.argv[2]
if (mode === "--scan") process.exit(await scan(process.argv[3]))
if (mode !== "--check" && mode !== "--apply") {
  console.error("usage: bun tools/rebrand/rebrand.ts --check | --apply | --scan <dir>")
  process.exit(2)
}

// Renaming a path is a `git mv`, so a tree without .git cannot be rewritten.
if (mode === "--apply" && !hasGit()) {
  console.error("--apply needs a git checkout")
  process.exit(2)
}

const files = await listFiles()
const hits = mode === "--check" ? await check(files) : await apply(files)
if (mode === "--check" && hits.length > 0) {
  console.error(hits.slice(0, 200).join("\n"))
  console.error(`\n${hits.length} upstream brand reference(s) found. Run: bun tools/rebrand/rebrand.ts --apply`)
  process.exit(1)
}
console.log(mode === "--check" ? "brand check passed" : `renamed ${hits.length} file(s)`)

async function check(list: string[]) {
  const results = await Promise.all(
    list
      .filter((file) => !allowed.has(file))
      .map(async (file) => {
        const pathHit = pattern.test(file) ? [`${file}: (path)`] : []
        const text = await readText(file)
        if (text === undefined) return pathHit
        return [
          ...pathHit,
          ...text
            .split("\n")
            .flatMap((line, index) =>
              pattern.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 160)}`] : [],
            ),
        ]
      }),
  )
  return results.flat()
}

async function apply(list: string[]) {
  const changed = await Promise.all(
    list
      .filter((file) => !allowed.has(file) && !license(file))
      .map(async (file) => {
        const text = await readText(file)
        if (text === undefined) return
        const next = rules.reduce((value, [regex, replacement]) => value.replace(regex, replacement as string), text)
        if (next === text) return
        await Bun.write(path.join(root, file), next)
        return file
      }),
  )
  // Rename paths after contents so imports and references already point at the new names.
  const moves = list
    .filter((file) => !allowed.has(file) && !license(file) && pattern.test(file))
    .map((file) => [file, file.replace(new RegExp(word, "gi"), brand)] as const)
  for (const [from, to] of moves) {
    await $`mkdir -p ${path.dirname(path.join(root, to))}`
    await $`git mv -k ${from} ${to}`.cwd(root).quiet()
  }
  return [...changed.filter((file) => file !== undefined), ...moves.map(([, to]) => to)]
}

// Build outputs are binary: search raw bytes, case-insensitively, and reject the repo-only notice file.
// The CLI build patches the name out of the embedded Bun runtime, so a compiled binary must contain none.
async function scan(directory: string | undefined) {
  if (!directory) {
    console.error("usage: bun tools/rebrand/rebrand.ts --scan <dir>")
    return 2
  }
  const needles = [word, org, `${share}.ai`]
  const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true, onlyFiles: true }))
  const found = (
    await Promise.all(
      files.map(async (file) => {
        if (path.basename(file) === "THIRD_PARTY_NOTICES.txt") return [`${file}: notice file must not ship`]
        const text = Buffer.from(await Bun.file(path.join(directory, file)).arrayBuffer())
          .toString("latin1")
          .toLowerCase()
        return needles
          .filter((needle) => text.includes(needle))
          .map((needle) => `${file}: contains ${needle.length}-char upstream token`)
      }),
    )
  ).flat()
  if (found.length === 0) {
    console.log(`brand scan passed (${files.length} file(s))`)
    return 0
  }
  console.error(found.join("\n"))
  return 1
}

function brand(match: string) {
  if (match === match.toUpperCase()) return "ORBIT"
  if (match[0] === match[0].toUpperCase()) return "Orbit"
  return "orbit"
}
