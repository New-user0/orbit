export * as DevicePath from "./device-path.js"

import os from "os"
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
 * shared device list. `release` is the Windows release (`10.0.<build>`), which decides how a name with an extension is
 * read.
 */
export function blocked(
  absolute: string,
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
) {
  return platform === "win32" ? windows(absolute, release) : unix(absolute)
}

// From this build on (Windows 11), a reserved name with an extension is an ordinary file.
const PLAIN_FILE_BUILD = 22000

function unix(absolute: string) {
  const file = path.posix.normalize(absolute)
  return UNIX_DEVICES.has(file) || UNIX_PREFIXES.some((prefix) => file.startsWith(prefix)) || PROC_FD.test(file)
}

function windows(absolute: string, release: string) {
  const file = absolute.replaceAll("/", "\\")
  // The device namespaces open a device by name, whatever the rest says.
  if (file.startsWith("\\\\.\\") || file.startsWith("\\\\?\\")) return true
  const base = path.win32.basename(file)
  // From Windows 11 only the bare name is a device (trailing dots and spaces are dropped): `nul.txt` is a file there.
  // A release that cannot be read is taken as the older rule, which refuses more.
  const build = Number(release.split(".")[2])
  if (build >= PLAIN_FILE_BUILD) return WINDOWS_RESERVED.test(base.replace(/[. ]+$/, ""))
  // Before it, Windows reads everything from the first dot as the extension, so `NUL.txt`, `nul .txt` and `NUL.` are the
  // device. Only the whole name before the extension counts: `console.log` is a file.
  return WINDOWS_RESERVED.test(base.split(".")[0].trimEnd())
}
