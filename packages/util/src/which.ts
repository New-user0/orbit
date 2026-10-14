import whichPkg from "which"
import path from "path"

export function which(cmd: string, env?: NodeJS.ProcessEnv, bin?: string) {
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  const full = base && bin ? base + path.delimiter + bin : base || bin
  const pathExt = env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt
  // A command that names a directory is a path, not a search, and the package checks it as given.
  if (path.basename(cmd) !== cmd) return whichPkg.sync(cmd, { nothrow: true, pathExt })
  // On Windows the package searches process.cwd() before PATH and has no option to skip it, so the repository Orbit was
  // started in could put its own git.exe or rg.exe ahead of the installed ones. It takes a name with a directory as
  // given, so look in each PATH entry by full name instead.
  for (const entry of full?.split(path.delimiter) ?? []) {
    // Windows allows quotes around a PATH entry. An empty entry means the working folder, which is never searched.
    const directory = entry.replace(/^"(.*)"$/, "$1")
    if (!directory) continue
    // A relative entry (`.`, `bin`, `node_modules/.bin`) resolves against the working folder, which may be a repository
    // that is not trusted, so it is skipped like an empty one. On Windows `C:x` and `\x` are not absolute either.
    if (!absolute(directory)) continue
    const found = whichPkg.sync(path.resolve(directory, cmd), { nothrow: true, pathExt })
    if (found) return found
  }
  return null
}

function absolute(directory: string) {
  if (process.platform === "win32") return /^([a-zA-Z]:[\\/]|\\\\|\/\/)/.test(directory)
  return path.isAbsolute(directory)
}
