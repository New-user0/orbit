export * as ManagedPath from "./managed-path.js"

import path from "path"

/**
 * The override that an environment names for the managed folder. This is the one place that reads it: the property
 * access on `process.env` is written out in full so that the build of a released CLI can replace it with `undefined`
 * (see `packages/cli/script/managed-define.ts`), and then no environment can move an organization's policy folder.
 * Source runs and tests keep the override, and so does an environment object that a caller built on purpose.
 */
export function override(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env === process.env ? process.env.ORBIT_MANAGED_DIR : env.ORBIT_MANAGED_DIR
}

/**
 * The folder an organization puts managed settings in. It is a pure computation: nothing here reads the disk, and
 * nothing in Orbit ever creates the folder.
 */
export function directory(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>) {
  // A relative override would be read from the working folder, which a repository supplies.
  const absolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute
  const requested = override(env)
  if (requested && absolute(requested)) return requested
  // Program Files, not ProgramData: a standard user can create and write under ProgramData, so a file planted there
  // would run as every other user. Only an administrator can create the folder or add a file under Program Files.
  // A relative ProgramFiles would be read from the working folder, which a repository supplies.
  if (platform === "win32") {
    const base = env.ProgramFiles && path.win32.isAbsolute(env.ProgramFiles) ? env.ProgramFiles : "C:\\Program Files"
    return path.win32.join(base, "Orbit")
  }
  if (platform === "darwin") return "/Library/Application Support/Orbit"
  return "/etc/orbit"
}
