import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// How the extension finds and starts `orb`.
//
// On Windows a program started by a bare name is looked for in the working folder before PATH, by Node's `execFile` as
// much as by Bun's, unless the process that starts it has `NoDefaultCurrentDirectoryInExePath`. The extension host is
// not an Orbit process and is shared with every other extension, so the extension does not set that variable there.
// It finds the program itself, on PATH only, and starts it by its full path, which nothing looks up. The working folder
// of a call is the workspace, which a repository chooses, so an `orb.exe` in it must never be the one that runs.
//
// Nothing here imports `vscode`, so it is tested with real programs and with a real Node process.

/**
 * The program `name` names: a full path, or a name that is looked up on PATH. A name with a directory in it that is not a
 * full path is never found, because `execFile` would read it from the working folder, and neither is a PATH entry that
 * is empty or relative, which a shell reads as the working folder. Windows can start only a `.exe` or a `.com` this way,
 * and adds the extension to a name that has none.
 */
export function find(name: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  if (path.basename(name) !== name) return path.isAbsolute(name) ? candidates(name).find(isProgram) : undefined
  return (env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter((entry) => path.isAbsolute(entry))
    .flatMap((directory) => candidates(path.join(directory, name)))
    .find(isProgram)
}

/**
 * Runs `executable` with `args` and returns what it printed. It is the only place in the extension that starts a program
 * other than a terminal, which gets the same path from `find`. The failure is what the program said on stderr, or why it
 * could not start.
 */
export function launch(
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeout: number
    readonly cwd?: string
    readonly env?: NodeJS.ProcessEnv
    readonly maxBuffer?: number
  },
) {
  const program = find(executable, options.env)
  if (!program) return Promise.reject(new Error(missing(executable)))
  return new Promise<string>((resolve, reject) =>
    execFile(program, [...args], { ...options, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message))
      resolve(stdout)
    }),
  )
}

/** Why `find` found nothing for `executable`, in words for the person who set `orbit.executable`. */
export function missing(executable: string) {
  return `Could not find "${executable}". Set orbit.executable in your user settings to a program on PATH or to the full path of orb: a workspace cannot set it.`
}

/**
 * The `orbit.executable` the person chose: their own user setting, else the default. The value that a workspace or a
 * folder sets is never read, whatever scope VS Code gives the setting, because it picks the program the extension runs.
 */
export function configured(setting: { readonly defaultValue?: unknown; readonly globalValue?: unknown } | undefined) {
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined)
  return text(setting?.globalValue) ?? text(setting?.defaultValue) ?? "orb"
}

function candidates(file: string) {
  return process.platform === "win32" && path.extname(file) === "" ? [`${file}.exe`, `${file}.com`] : [file]
}

function isProgram(file: string) {
  const info = fs.statSync(file, { throwIfNoEntry: false })
  return info?.isFile() === true && (process.platform === "win32" || (info.mode & 0o111) !== 0)
}
