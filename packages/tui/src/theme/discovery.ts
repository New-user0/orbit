import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { LinkShare } from "@orbit/util/link-share"
import { isMissingPath } from "../util/config-directories"

/**
 * Custom themes from each folder's `themes` directory, later folders winning. This runs when the terminal UI mounts, before
 * anyone has answered a trust question, on folders and files a repository supplies. A name that is, or leads through a link
 * to, a share is skipped before it is listed or read: opening it connects to a host the repository chose (class 6). Any
 * other failure costs only its own entry, with one log line, so one bad theme does not reset the person's choice (class 7).
 */
export async function discoverThemes(directories: string[]) {
  const result: Record<string, unknown> = {}
  for (const directory of directories) {
    const themeDirectory = path.join(directory, "themes")
    // `LinkShare.ofSync` reads every part of the path, so this also covers the `.orbit` folder above `themes`.
    if (skipShare(themeDirectory)) continue
    const entries = await readdir(themeDirectory, { withFileTypes: true }).catch((error: unknown) => {
      if (!isMissingPath(error)) warn(themeDirectory, error)
      return []
    })
    const files = entries
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && path.extname(entry.name) === ".json")
      .map((entry) => path.join(themeDirectory, entry.name))
      .sort()
    for (const file of files) {
      if (skipShare(file)) continue
      const theme = await readFile(file, "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch((error: unknown) => warn(file, error))
      if (theme !== undefined) result[path.basename(file, ".json")] = theme
    }
  }
  return result
}

function skipShare(file: string) {
  if (LinkShare.ofSync(file) === undefined) return false
  console.warn(`Skipping ${file}: it leads to a network share`)
  return true
}

function warn(file: string, error: unknown) {
  console.warn(`Skipping ${file}: ${error instanceof Error ? error.message : String(error)}`)
}
