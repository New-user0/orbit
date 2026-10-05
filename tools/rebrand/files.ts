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
 * untracked ones, so it skips nothing but what the .gitignore files in the tree exclude. It is a local convenience: CI
 * always has git.
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
  // -t tags each path: ? is untracked and every other tag is tracked (H, S for skip-worktree, M for unmerged). An
  // unmerged path is listed once per stage, hence the set. A trailing slash is a nested repository, which has no text.
  const listed = new Set(
    (await $`git ls-files -co --exclude-standard -t -z`.cwd(root).text()).split("\0").filter(Boolean),
  )
  return [...listed]
    .map((entry) => ({ tracked: !entry.startsWith("?"), file: entry.slice(2) }))
    .filter((entry) => !entry.file.endsWith("/"))
    .filter((entry) => entry.tracked || !entry.file.split("/").some((segment) => foreign.has(segment.toLowerCase())))
    .map((entry) => entry.file)
}

type Rule = { readonly base: string; readonly glob: Bun.Glob; readonly negated: boolean; readonly directory: boolean }

async function fromTree() {
  // `prefix` is the directory being walked: empty at the root, otherwise its path from the root and a slash.
  const visit = async (prefix: string, inherited: Rule[]): Promise<string[]> => {
    const rules = [...inherited, ...(await gitignore(prefix))]
    // The last rule that matches decides, and a deeper .gitignore comes after the ones above it.
    const ignored = (file: string, isDirectory: boolean) =>
      rules.reduce(
        (state, rule) =>
          (rule.directory && !isDirectory) || !rule.glob.match(file.slice(rule.base.length)) ? state : !rule.negated,
        false,
      )
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true })
    const found = await Promise.all(
      entries.map(async (entry) => {
        const file = `${prefix}${entry.name}`
        if (entry.isDirectory()) return pruned.has(entry.name) || ignored(file, true) ? [] : visit(`${file}/`, rules)
        // Symlinks are skipped: git lists their target path, not the text behind them.
        return entry.isFile() && !ignored(file, false) ? [file] : []
      }),
    )
    return found.flat()
  }
  return visit("", [])
}

// The rules of the .gitignore in one directory, which apply below it. Directories that match are never entered, so the
// rule that a file inside an ignored directory cannot be re-included holds without being tested. Only .gitignore files
// count: the walk has no git to read .git/info/exclude or a global excludes file from.
async function gitignore(prefix: string): Promise<Rule[]> {
  const blob = Bun.file(path.join(root, prefix, ".gitignore"))
  if (!(await blob.exists())) return []
  return (await blob.text()).split(/\r?\n/).flatMap((line) => {
    const pattern = line.trimEnd()
    if (pattern === "" || pattern.startsWith("#")) return []
    const negated = pattern.startsWith("!")
    const body = negated ? pattern.slice(1) : pattern
    const directory = body.endsWith("/")
    const name = directory ? body.slice(0, -1) : body
    // A pattern with a slash in it is relative to the .gitignore's directory; one without matches at any depth.
    const glob = name.includes("/") ? name.replace(/^\//, "") : `**/${name}`
    return [{ base: prefix, glob: new Bun.Glob(glob), negated, directory }]
  })
}
