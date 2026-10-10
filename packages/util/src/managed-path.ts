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
  if (platform === "win32") return path.win32.join(env.ProgramData || "C:\\ProgramData", "Orbit")
  if (platform === "darwin") return "/Library/Application Support/Orbit"
  return "/etc/orbit"
}
