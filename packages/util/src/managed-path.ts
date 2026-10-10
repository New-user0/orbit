export * as ManagedPath from "./managed-path.js"

import path from "path"

/**
 * The folder an organization puts managed settings in. It is a pure computation: nothing here reads the disk, and
 * nothing in Orbit ever creates the folder.
 */
export function directory(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>) {
  // A relative override would be read from the working folder, which a repository supplies.
  const absolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute
  if (env.ORBIT_MANAGED_DIR && absolute(env.ORBIT_MANAGED_DIR)) return env.ORBIT_MANAGED_DIR
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
