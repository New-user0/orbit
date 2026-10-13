import path from "node:path"
import { stat } from "node:fs/promises"
import { LinkShare } from "@orbit/util/link-share"

export function configDirectories(config: string, cwd: string) {
  return [...new Set([config, ...ancestors(cwd).map((directory) => path.join(directory, ".orbit"))])]
}

export function projectConfigDirectories(project: string, cwd: string) {
  const directories = ancestors(cwd)
  return directories
    .slice(directories.indexOf(path.resolve(project)))
    .map((directory) => path.join(directory, ".orbit"))
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

function ancestors(cwd: string) {
  const directories: string[] = []
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    directories.push(current)
    if (path.dirname(current) === current) break
  }
  return directories.reverse()
}
