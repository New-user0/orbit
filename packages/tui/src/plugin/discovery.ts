import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { localSource } from "@orbit/plugin/source"
import {
  isMissingPath,
  localProjectDirectory,
  present,
  projectConfigDirectories,
  realStart,
  within,
} from "../util/config-directories"

export { localSource }

/** Where the terminal UI looks for plugin directories, split by whose they are. */
export type PluginDirectories = {
  /** The user's own: the global config directory, and `.orbit` in the home directory. */
  readonly global: readonly string[]
  /** The project's: the `.orbit` directories from its root down to the working directory. */
  readonly project: readonly string[]
  /** The project's root, which a plugin of the project must stay inside once every link in it is followed. */
  readonly root: string
  /** The folder the terminal UI started in, by its real path, as the server takes it (class 4). */
  readonly start: string
}

export async function localPluginDirectories(
  cwd: string,
  directories: { readonly config: string; readonly home: string },
): Promise<PluginDirectories> {
  const start = await realStart(cwd)
  const projectDirectory = await localProjectDirectory(start)
  const projectConfig = path.join(projectDirectory, ".orbit")
  const candidates = projectConfigDirectories(projectDirectory, start)
  const exists = await Promise.all(
    candidates.map(async (directory) => {
      if (directory === projectConfig) return true
      // A folder that is a link to a share is not read.
      return (await present(directory)) === "directory"
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
    root: projectDirectory,
    start,
  }
}

/**
 * The plugin directories to read now. A plugin runs in this process, so the ones a project keeps wait for its folder
 * to be trusted, as the server's do; the user's own never wait. Once it is trusted they load as they are, a plugin added
 * after the grant included (D8).
 *
 * `root` is the folder the server decided the trust for. The terminal UI finds the project's root without asking the
 * server, and the server rejects some markers this walk accepts, so where `root` is the start folder or a folder above
 * it, a plugins directory in a folder above `root` is left out: nothing above the project is read (D7), and the stricter
 * of the two roots wins (class 3).
 */
export function trustedPluginDirectories(
  directories: Pick<PluginDirectories, "global" | "project" | "start">,
  trusted: boolean,
  root?: string,
) {
  if (!trusted) return [...directories.global]
  const bound = root !== undefined && within(root, directories.start) ? root : undefined
  return [
    ...directories.global,
    // A plugins directory sits in `.orbit` in the folder that holds it.
    ...directories.project.filter((plugins) => bound === undefined || within(bound, path.dirname(path.dirname(plugins)))),
  ]
}

/**
 * The plugins in these directories. With `within`, a plugin whose real path lies outside that folder is left out, and
 * so is every plugin of a directory that itself leads out: what a link out of the project points at is not the
 * project's to supply.
 */
export async function discoverPluginTargets(directories: string[], within?: string) {
  const bound = within === undefined ? undefined : await realpath(within).catch(() => within)
  const stays = async (target: string) => {
    if (bound === undefined) return true
    const real = await realpath(target).catch(() => undefined)
    if (real === undefined) return false
    const relative = path.relative(bound, real)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }
  const found = await discoverAll(directories)
  const kept = await Promise.all(found.map(async (target) => ((await stays(target)) ? [target] : [])))
  return kept.flat()
}

async function discoverAll(directories: string[]) {
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
              .filter((entry) => entry.name !== "node_modules" && (entry.isDirectory() || entry.isSymbolicLink()))
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
