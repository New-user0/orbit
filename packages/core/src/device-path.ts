export * as DevicePath from "./device-path.js"

import path from "path"

const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[1-9¹²³])$/i
const UNIX_DEVICES = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/console",
  "/dev/ptmx",
])
// `self`, `thread-self` or a process id, directly or through one of its tasks.
const PROC_FD = /^\/proc\/(self|thread-self|[0-9]+)\/(task\/[0-9]+\/)?fd\//
const UNIX_PREFIXES = ["/dev/tty", "/dev/pts/", "/dev/fd/", "/dev/cu."]

/**
 * Whether an absolute path names a device or stream that never ends or blocks: reading one hangs the tool or fills
 * memory. The rules of `platform` run on any host, so each platform's table is tested everywhere. This is the one
 * shared device list.
 */
export function blocked(absolute: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? windows(absolute) : unix(absolute)
}

function unix(absolute: string) {
  const file = path.posix.normalize(absolute)
  return UNIX_DEVICES.has(file) || UNIX_PREFIXES.some((prefix) => file.startsWith(prefix)) || PROC_FD.test(file)
}

function windows(absolute: string) {
  const file = absolute.replaceAll("/", "\\")
  // The device namespaces open a device by name, whatever the rest says.
  if (file.startsWith("\\\\.\\") || file.startsWith("\\\\?\\")) return true
  // Windows drops trailing dots and spaces and reads everything from the first dot as the extension, so `NUL.txt`,
  // `nul .txt` and `NUL.` are the device. Only the whole name before the extension counts: `console.log` is a file.
  const name = path.win32.basename(file).split(".")[0].trimEnd()
  return WINDOWS_RESERVED.test(name)
}
