/**
 * The file listing and reader that the brand gate (rebrand.ts) and the vendor gate (vendor.ts) share.
 */
import { $ } from "bun"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { directories } from "./tokens.ts"

export const root = path.resolve(import.meta.dir, "../..")

// Directories the walk without git never enters: build output and tool state, which no checkout commits.
const pruned = new Set(["node_modules", "dist", ".turbo", ".git"])

/**
 * The files the gates read, as paths relative to the root with forward slashes: every tracked file, and every
 * untracked file that .gitignore does not exclude.
 *
 * Untracked files under another agent tool's directory are left out. They are that tool's local state, and a checkout
 * that has been used with the tool must not fail the gates for it. Tracked files there are still listed, because what
 * is committed is what ships.
 *
 * Without .git, which an exported tree does not have, the tree is walked instead. That cannot tell tracked files from
 * untracked ones, so it skips nothing but what .gitignore excludes. It is a local convenience: CI always has git.
 */
export async function listFiles() {
  return hasGit() ? fromGit() : fromTree()
}

/** Whether the root is a git checkout: .git is a directory, or a file in a linked worktree. */
export function hasGit() {
  return existsSync(path.join(root, ".git"))
}

/** The text of a listed file, or undefined when it is binary or has been deleted since it was listed. */
export async function readText(file: string) {
  const blob = Bun.file(path.join(root, file))
  if (!(await blob.exists())) return
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.includes(0)) return
  return new TextDecoder().decode(bytes)
}

async function fromGit() {
  const foreign = new Set(directories.map((directory) => directory.toLowerCase()))
  // -t tags each path: H is tracked, ? is untracked. A trailing slash is a nested repository, which has no text.
  const listed = (await $`git ls-files -co --exclude-standard -t -z`.cwd(root).text()).split("\0").filter(Boolean)
  return listed
    .map((entry) => ({ tracked: entry.startsWith("H"), file: entry.slice(2) }))
    .filter((entry) => !entry.file.endsWith("/"))
    .filter((entry) => entry.tracked || !entry.file.split("/").some((segment) => foreign.has(segment.toLowerCase())))
    .map((entry) => entry.file)
}

async function fromTree() {
  const ignored = await gitignore()
  const visit = async (directory: string): Promise<string[]> => {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true })
    const found = await Promise.all(
      entries.map(async (entry) => {
        const file = directory === "" ? entry.name : `${directory}/${entry.name}`
        if (entry.isDirectory()) return pruned.has(entry.name) || ignored(file, true) ? [] : visit(file)
        // Symlinks are skipped: git lists their target path, not the text behind them.
        return entry.isFile() && !ignored(file, false) ? [file] : []
      }),
    )
    return found.flat()
  }
  return visit("")
}

// The root .gitignore only, which is all the repository uses. Directories that match are never entered, so the
// rule that a file inside an ignored directory cannot be re-included holds without being tested.
async function gitignore() {
  const blob = Bun.file(path.join(root, ".gitignore"))
  const lines = (await blob.exists()) ? (await blob.text()).split(/\r?\n/) : []
  const rules = lines.flatMap((line) => {
    const pattern = line.trimEnd()
    if (pattern === "" || pattern.startsWith("#")) return []
    const negated = pattern.startsWith("!")
    const body = negated ? pattern.slice(1) : pattern
    const directory = body.endsWith("/")
    const name = directory ? body.slice(0, -1) : body
    // A pattern with a slash in it is relative to the root; one without matches at any depth.
    const glob = name.includes("/") ? name.replace(/^\//, "") : `**/${name}`
    return [{ glob: new Bun.Glob(glob), negated, directory }]
  })
  return (file: string, isDirectory: boolean) =>
    rules.reduce(
      (ignored, rule) => ((rule.directory && !isDirectory) || !rule.glob.match(file) ? ignored : !rule.negated),
      false,
    )
}
