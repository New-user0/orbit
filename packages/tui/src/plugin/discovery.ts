import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { localSource } from "@orbit/plugin/source"
import { isMissingPath, localProjectDirectory, projectConfigDirectories } from "../util/config-directories"

export { localSource }

/** Where the terminal UI looks for plugin directories, split by whose they are. */
export type PluginDirectories = {
  /** The user's own: the global config directory, and `.orbit` in the home directory. */
  readonly global: readonly string[]
  /** The project's: the `.orbit` directories from its root down to the working directory. */
  readonly project: readonly string[]
}

export async function localPluginDirectories(
  cwd: string,
  directories: { readonly config: string; readonly home: string },
): Promise<PluginDirectories> {
  const projectDirectory = await localProjectDirectory(cwd)
  const projectConfig = path.join(projectDirectory, ".orbit")
  const candidates = projectConfigDirectories(projectDirectory, cwd)
  const exists = await Promise.all(
    candidates.map(async (directory) => {
      if (directory === projectConfig) return true
      return await stat(directory).then(
        (info) => info.isDirectory(),
        (error) => (isMissingPath(error) ? false : Promise.reject(error)),
      )
    }),
  )
  // Orbit files in the home directory are the user's own config even when a walk from the project passes through it,
  // which is how the server reads them too. path.relative compares case-insensitively where Windows does.
  const own = path.join(directories.home, ".orbit")
  const found = candidates
    .filter((_, index) => exists[index])
    .map((directory) => ({ plugins: path.join(directory, "plugins"), own: path.relative(own, directory) === "" }))
  return {
    global: [path.join(directories.config, "plugins"), ...found.filter((item) => item.own).map((item) => item.plugins)],
    project: found.filter((item) => !item.own).map((item) => item.plugins),
  }
}

/**
 * The plugin directories to read now. A plugin runs in this process, so the ones a project keeps wait for its folder
 * to be trusted, as the server's do; the user's own never wait.
 *
 * `above` is the folders around the project whose config the server still holds back, each waiting on its own decision.
 * The terminal UI finds the project's root without asking the server, so when the two disagree, a folder the server
 * counts as above its project can lie inside the terminal UI's walk, and its plugins wait like the server's.
 *
 * `changed` is the config directories whose plugins changed since their folder was trusted, which the server holds back
 * too: they wait until the changes are trusted, while the folder's other directories keep loading.
 */
export function trustedPluginDirectories(
  directories: PluginDirectories,
  trusted: boolean,
  above: readonly string[],
  changed: readonly string[] = [],
) {
  if (!trusted) return [...directories.global]
  return [
    ...directories.global,
    // A plugins directory sits in `.orbit` in the folder that holds it. path.relative compares case-insensitively where
    // Windows does.
    ...directories.project.filter(
      (plugins) =>
        !above.some((folder) => path.relative(folder, path.dirname(path.dirname(plugins))) === "") &&
        !changed.some((orbit) => path.relative(orbit, path.dirname(plugins)) === ""),
    ),
  ]
}

export async function discoverPluginTargets(directories: string[]) {
  return (
    await Promise.all(
      directories.map(async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
          if (isMissingPath(error)) return []
          return Promise.reject(error)
        })
        return (
          await Promise.all(
            entries
              .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(async (entry): Promise<string | undefined> => {
                const plugin = path.join(directory, entry.name)
                const isDirectory =
                  entry.isDirectory() ||
                  (await stat(plugin).then(
                    (info) => info.isDirectory(),
                    (error) => (isMissingPath(error) ? false : Promise.reject(error)),
                  ))
                if (!isDirectory) return undefined
                return plugin
              }),
          )
        ).filter((entry): entry is string => entry !== undefined)
      }),
    )
  ).flat()
}

export function mergePluginTargets<const Target extends { readonly entry: string | { readonly package: string } }>(
  targets: readonly Target[],
  directory: string,
) {
  return [
    ...targets
      .reduce((result, target) => {
        const value = typeof target.entry === "string" ? target.entry : target.entry.package
        return result.set(localSource(value, directory)?.href ?? value, target)
      }, new Map<string, Target>())
      .values(),
  ]
}
