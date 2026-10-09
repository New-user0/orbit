import path from "path"
import { FSUtil } from "@orbit/util/fs-util"

export function abbreviateHome(input: string, home: string) {
  if (!home) return input
  const paths = windowsPath(home) ? path.win32 : path.posix
  const relative = paths.relative(home, input)
  if (!relative) return "~"
  if (relative === ".." || relative.startsWith(".." + paths.sep) || paths.isAbsolute(relative)) return input
  return "~/" + relative.split(paths.sep).join("/")
}

/**
 * `input` from `base`. `home` abbreviates a path under it as `~/...`; `tilde`, which defaults to `home`, is the folder
 * that a leading `~` in `input` stands for.
 */
export function formatPath(
  input: string | undefined,
  options: { base: string; home?: string; tilde?: string; forwardSlashes?: boolean },
) {
  if (!input) return ""
  const windows = windowsPath(options.base)
  if (!windows && windowsPath(input)) {
    return options.forwardSlashes ? input.replaceAll("\\", "/") : input
  }

  const paths = windows ? path.win32 : path.posix
  // The tools read a leading `~` as the home folder and a Git Bash drive spelling as that drive, so a path is shown where
  // a tool acts on it: `~/../x` is not `x` in the project. A base from a system of the other kind keeps the plain rules.
  const tilde = options.tilde ?? options.home
  const absolute =
    tilde && windows === (process.platform === "win32")
      ? FSUtil.resolveFrom(options.base, input, tilde)
      : paths.isAbsolute(input)
        ? input
        : paths.resolve(options.base, input)
  const relative = paths.relative(options.base, absolute)
  const formatted = !relative
    ? "."
    : relative !== ".." && !relative.startsWith(".." + paths.sep) && !paths.isAbsolute(relative)
      ? relative
      : options.home
        ? abbreviateHome(absolute, options.home)
        : absolute
  return options.forwardSlashes ? formatted.replaceAll("\\", "/") : formatted
}

function windowsPath(input: string) {
  return /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\")
}
