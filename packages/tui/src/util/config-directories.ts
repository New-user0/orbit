import path from "node:path"
import { realpath, stat } from "node:fs/promises"
import { LinkShare } from "@orbit/util/link-share"

/** The `.orbit` folders from the project's root down to `cwd`, outermost first. */
export function projectConfigDirectories(project: string, cwd: string) {
  const directories = ancestors(cwd)
  // path.relative compares case-insensitively where Windows does, so a root spelled in another case is still found.
  const index = directories.findIndex((directory) => path.relative(project, directory) === "")
  return directories.slice(index === -1 ? directories.length - 1 : index).map((directory) => path.join(directory, ".orbit"))
}

export async function localProjectDirectory(cwd: string) {
  const directories = ancestors(cwd)
  const repositories = await Promise.all(
    directories.map((directory) =>
      Promise.all([".git", ".hg"].map((name) => present(path.join(directory, name)))).then((matches) =>
        matches.some((kind) => kind !== undefined),
      ),
    ),
  )
  return directories.findLast((_, index) => repositories[index]) ?? path.resolve(cwd)
}

/**
 * The project's root for the terminal UI's own walks: the nearest folder at or above `cwd` that holds `.git` or `.hg`,
 * else `cwd`. `decided` is the folder the server decided trust for. The server accepts fewer markers than this walk does
 * (it rejects a `.git` file that names no repository), so when `decided` lies between `cwd` and that folder the walk
 * starts there instead: the terminal UI never reads further up than the server does (class 3, the stricter answer wins).
 */
export async function projectRoot(cwd: string, decided?: string) {
  const found = await localProjectDirectory(cwd)
  if (decided === undefined || !within(decided, cwd) || !within(found, decided)) return found
  return path.resolve(decided)
}

/**
 * The folders whose `themes` the terminal UI and Mini read, later ones winning: the user's own (the global config folder,
 * then `.orbit` in the home directory), and with `project` the project's `.orbit` folders from its root down to the start
 * folder, which wait for the folder to be trusted (class 1). Nothing above the project's root is read (D7). The start
 * folder is taken by its real path, as the server takes it (class 4).
 */
export async function themeDirectories(input: {
  readonly config: string
  readonly home: string
  readonly cwd: string
  readonly project?: { readonly decided?: string }
}) {
  const own = [input.config, path.join(input.home, ".orbit")]
  if (input.project === undefined) return own
  const start = await realStart(input.cwd)
  return [...new Set([...own, ...projectConfigDirectories(await projectRoot(start, input.project.decided), start)])]
}

/** The real path of the folder a walk starts in, or the folder as it is spelled when it cannot be read. */
export function realStart(cwd: string) {
  return realpath(cwd).catch(() => path.resolve(cwd))
}

/**
 * What a marker or config folder of the walk is, answered before anyone has said the folder is trusted. A folder can ship
 * the name as a link to a share, and a stat through it connects to a host the folder chose, so a link that leads to one is
 * "share": there, but never followed. Any other failure (a link that loops, a name that is not readable) is not there, with
 * one log line, so one bad entry costs only itself.
 */
export async function present(file: string) {
  if (LinkShare.ofSync(file) !== undefined) return "share" as const
  return stat(file).then(
    (info) => (info.isDirectory() ? ("directory" as const) : ("file" as const)),
    (error) => {
      if (!isMissingPath(error)) console.warn(`Skipping ${file}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    },
  )
}

export function isMissingPath(error: unknown) {
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? error.code : undefined
  return code === "ENOENT" || code === "ENOTDIR"
}

/** Whether `child` is `parent` or a folder inside it, folding case where Windows does. */
export function within(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function ancestors(cwd: string) {
  const directories: string[] = []
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    directories.push(current)
    if (path.dirname(current) === current) break
  }
  return directories.reverse()
}
