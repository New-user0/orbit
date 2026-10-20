export * as Git from "./git.js"

import { existsSync, statSync } from "node:fs"
import { appendFile, readdir, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"

// Worktrees give each agent its own checkout and branch, so agents running in parallel never touch the same files.
// They live under .orbit/worktrees/<run>/<node> and branch from the commit the run started at.

/**
 * Runs git in `directory`. Git looks for the repository there and in the folders above it up to `top` (`directory` when not
 * given), and never above (`GIT_CEILING_DIRECTORIES`): a `.git` that git passes over would otherwise hand the command, with
 * the config of the repository above, to a folder that nobody was asked about (class 1, class 3). A folder above `top`
 * whose path holds the list separator cannot be given to git that way, and git is then not started.
 */
export async function git(directory: string, args: ReadonlyArray<string>, top = directory) {
  const result = await spawn(directory, args, top)
  return { code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

// `git`, with the output as git wrote it.
async function spawn(directory: string, args: ReadonlyArray<string>, top: string) {
  // Without git, every directory is simply not a repository: runs still work, without worktrees or merges.
  if (!Bun.which("git")) return { code: 127, stdout: "", stderr: "git is not installed or not on PATH" }
  const bound = path.resolve(top)
  const above = path.dirname(bound)
  if (above.includes(path.delimiter))
    return { code: 1, stdout: "", stderr: "git was not started: the folder above the repository cannot be its ceiling" }
  // Worktrees nest deep under .orbit/worktrees; on Windows that passes the 260-character path limit without this.
  const options = process.platform === "win32" ? ["-c", "core.longpaths=true"] : []
  const child = Bun.spawn(["git", ...options, ...args], {
    cwd: directory,
    env: above === bound ? process.env : { ...process.env, GIT_CEILING_DIRECTORIES: above },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

async function ok(directory: string, args: ReadonlyArray<string>) {
  const result = await git(directory, args)
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

/** The folders that the trust decision for a run's folder covers, as the server resolved its project. */
export interface Project {
  /** The project's folder: git looks for a repository no further up than it. */
  readonly directory: string
  /** The project's main checkout, which is the project's folder unless that is a linked worktree. */
  readonly canonical: string
}

/**
 * The repository that git uses in `directory`, a folder that is trusted: `root` is its work tree, or `outside` names the
 * part of it (work tree, git directory or common directory) that lies outside `directory` and the project's folders, and
 * neither is set outside a repository. Git follows what a folder's `.git` names (a `gitdir:` pointer, a link, a
 * `commondir`) and applies the config and hooks of the directory it lands in, so it is first asked which directories it
 * would use (`rev-parse`, which starts no program that a config names), and the repository is used only when all of them
 * are inside the folders that the decision covers (class 1, class 3). Without `project`, git looks only in `directory`.
 */
export async function root(
  directory: string,
  project: Project = { directory, canonical: directory },
): Promise<{ readonly root?: string; readonly outside?: string }> {
  const result = await spawn(
    directory,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
    project.directory,
  )
  // One path a line, in the order asked, and nothing trimmed: a path with a line break in it gives more lines and is not
  // taken apart, and a name that ends in a space keeps it.
  const lines = result.stdout.replace(/\n$/, "").split("\n")
  if (result.code !== 0 || lines.length !== 3) return {}
  const real = (file: string) => realpath(file).catch(() => undefined)
  const places = await Promise.all(lines.map((line) => real(process.platform === "win32" ? line.replace(/\r$/, "") : line)))
  const folders = await Promise.all([directory, project.directory, project.canonical].map(real))
  const outside = lines.find((line, index) => {
    const place = places[index]
    return place === undefined || !folders.some((folder) => folder !== undefined && within(folder, place))
  })
  return outside === undefined ? { root: places[0] } : { outside }
}

/**
 * The folder that holds the `.git` nearest to `directory`, found with `stat` and no process, or undefined outside a
 * repository. The commands that only read the run store use it: starting git in a folder applies the config that the
 * folder ships, which can name programs to run or shares to open, and these commands run before anyone is asked about it.
 */
export function holder(directory: string) {
  const start = path.resolve(directory)
  for (let folder = start; ; folder = path.dirname(folder)) {
    const marker = path.join(folder, ".git")
    // Git passes over a `.git` directory with no HEAD and looks in the folder above, as `Git.root` does up to the
    // project's folder.
    if (existsSync(marker) && (!statSync(marker).isDirectory() || existsSync(path.join(marker, "HEAD")))) return folder
    if (path.dirname(folder) === folder) return undefined
  }
}

export const head = (directory: string) => ok(directory, ["rev-parse", "HEAD"])

export function branch(run: string, node: string) {
  return `orbit/${run}/${node.replace(/[^a-zA-Z0-9._-]+/g, "-")}`
}

// A run ID is a folder under .orbit/worktrees and part of a branch name, and git reads the branch name as a pattern. The
// runner makes `run_<timestamp>_<hex>`, but an ID can also come from a run store, which a repository can ship, so it is
// one plain name or it is not a run: no separator that leads out of the folder (`../..`), no `.` or `..`, and no
// character that a pattern or a file system treats as more than itself.
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function runFolder(repository: string, run: string) {
  if (!PLAIN_NAME.test(run)) throw new Error(`Not a run: ${JSON.stringify(run)}`)
  return path.join(repository, ".orbit", "worktrees", run)
}

/** Create (or reuse, on resume) the worktree for a node, branching from `base`. */
export async function worktree(repository: string, run: string, node: string, base: string) {
  const segment = node.replace(/[^a-zA-Z0-9._-]+/g, "-")
  // A node named `.` or `..`, or with no name, would be the run's folder or the one that holds every run's.
  if (/^\.*$/.test(segment)) throw new Error(`Not a node: ${JSON.stringify(node)}`)
  const directory = path.join(runFolder(repository, run), segment)
  const name = branch(run, node)
  if (existsSync(directory)) return { directory, branch: name }
  // Parallel nodes of one run add worktrees to the same repository, and git can fail one of several concurrent adds
  // with "failed to read .git/worktrees/<sibling>/commondir". The adds of a repository therefore run one at a time.
  const previous = adding.get(repository) ?? Promise.resolve()
  const add = previous.then(async () => {
    const exists = (await git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).code === 0
    await ok(repository, ["worktree", "add", ...(exists ? [directory, name] : ["-b", name, directory, base])])
  })
  // The chain goes on after a failed add; each caller still sees its own result.
  adding.set(
    repository,
    add.catch(() => undefined),
  )
  await add
  return { directory, branch: name }
}

const adding = new Map<string, Promise<void>>()

/** Commit whatever the agent changed in its worktree; returns false when nothing changed. */
// Caches that tools such as pytest create as a side effect. An agent committing them would put them on its branch,
// and the merge would then collide with the user's own untracked copies.
const GENERATED = ["__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".DS_Store"]

export async function commit(directory: string, message: string) {
  await ok(directory, [
    "add",
    "-A",
    "--",
    ".",
    ...GENERATED.map((pattern) => `:(exclude,glob)**/${pattern}/**`),
    ...GENERATED.map((pattern) => `:(exclude,glob)**/${pattern}`),
  ])
  if ((await git(directory, ["diff", "--cached", "--quiet"])).code === 0) return false
  await ok(directory, ["-c", "user.name=Orbit", "-c", "user.email=orbit@localhost", "commit", "-q", "-m", message])
  return true
}

/** Tracked files with uncommitted changes; a merge into the checkout would refuse to overwrite them. */
export async function dirty(repository: string) {
  return (await ok(repository, ["diff", "--name-only", "HEAD"])).split("\n").filter(Boolean)
}

/** Merge `name` into the checkout at `repository`; on conflict, abort and report the conflicting files. */
export async function merge(repository: string, name: string, message: string) {
  const result = await git(repository, [
    "-c",
    "user.name=Orbit",
    "-c",
    "user.email=orbit@localhost",
    "merge",
    "--no-ff",
    "-m",
    message,
    name,
  ])
  if (result.code === 0) return { merged: true as const }
  // Git refuses before touching anything when the merge would overwrite local files; nothing to abort.
  const blocked = [...(result.stderr + "\n" + result.stdout).matchAll(/^\t(.+)$/gm)].map((match) => match[1].trim())
  if (/would be overwritten by merge/.test(result.stderr))
    return { merged: false as const, files: [], blocked: blocked.length > 0 ? blocked : ["local files"] }
  const files = (await git(repository, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean)
  await git(repository, ["merge", "--abort"])
  // An aborted merge can leave a file behind on Windows (line-ending conversion under core.autocrlf, or a file that
  // was briefly locked). Merges only start in a clean checkout, so anything still changed came from this merge.
  const left = await dirty(repository)
  if (left.length > 0) await git(repository, ["checkout", "HEAD", "--", ...left])
  if (files.length === 0) throw new Error(`git merge ${name} failed: ${result.stderr || result.stdout}`)
  return { merged: false as const, files, blocked: [] }
}

/** Keep run data and worktrees out of the user's status without touching their tracked .gitignore. */
export async function exclude(repository: string) {
  const file = path.join(
    await ok(repository, ["rev-parse", "--git-common-dir"]).then((dir) => path.resolve(repository, dir)),
    "info",
    "exclude",
  )
  const current = await readFile(file, "utf8").catch(() => "")
  if (current.split("\n").includes(".orbit/")) return
  await appendFile(file, `${current.endsWith("\n") || current === "" ? "" : "\n"}.orbit/\n`)
}

/** What a worktree changed since `base`, for a reviewer; cut at `limit` characters. */
export async function diff(directory: string, base: string, limit = 40_000) {
  const text = await ok(directory, [
    "diff",
    base,
    "--",
    ".",
    ...GENERATED.map((pattern) => `:(exclude,glob)**/${pattern}/**`),
  ])
  return text.length > limit ? `${text.slice(0, limit)}\n… diff cut at ${limit} characters` : text
}

// Whether `candidate` is a folder under `folder`, judged the way the platform compares paths: a drive letter or a folder
// name that differs only in case is the same place on Windows, which a string prefix test misses.
function inside(folder: string, candidate: string) {
  const relative = path.relative(folder, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

// Whether `candidate` is `folder` or inside it, compared as `inside` compares.
function within(folder: string, candidate: string) {
  return path.relative(folder, candidate) === "" || inside(folder, candidate)
}

/** Remove a run's worktrees and branches; returns how many of each went. */
export async function clean(repository: string, run: string) {
  const prefix = runFolder(repository, run)
  const listed = (await ok(repository, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .flatMap((line) => (line.startsWith("worktree ") ? [path.resolve(line.slice("worktree ".length))] : []))
    .filter((directory) => inside(prefix, directory))
  for (const directory of listed) await ok(repository, ["worktree", "remove", "--force", directory])
  await ok(repository, ["worktree", "prune"])
  await rm(prefix, { recursive: true, force: true })
  const parent = path.dirname(prefix)
  if ((await readdir(parent).catch(() => [])).length === 0) await rm(parent, { recursive: true, force: true })
  const branches = (await ok(repository, ["for-each-ref", "--format=%(refname:short)", `refs/heads/orbit/${run}/`]))
    .split("\n")
    .filter(Boolean)
  if (branches.length > 0) await ok(repository, ["branch", "-D", ...branches])
  return { worktrees: listed.length, branches: branches.length }
}
