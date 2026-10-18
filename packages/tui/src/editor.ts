import type { CliRenderer } from "@opentui/core"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Stream } from "node:stream"
import { Option, Schema } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { IdeLock } from "@orbit/util/ide-lock"
import { plain } from "@orbit/util/plain"
import { ProgramLookup } from "@orbit/util/program-lookup"

export { normalizePromptContent } from "./prompt/content"

type EditorStdio = "inherit" | "pipe" | "ignore" | number | Stream

/**
 * Opens `value` in $VISUAL or $EDITOR for the person to change, and returns what the file holds afterwards. A non-zero
 * exit rejects, so that the prompt is left as it was.
 *
 * The editor is started the way `openFile` starts it, and never through a shell: a shell on Windows looks for the program
 * in the working folder first, which can be a clone that is not trusted, and would run its `code.cmd` or `vim.bat` in
 * place of the editor.
 */
export async function openEditor(input: { value: string; renderer: CliRenderer; cwd?: string; stdin?: EditorStdio }) {
  const editor = (process.env.VISUAL || process.env.EDITOR)?.trim()
  if (!editor) return
  const file = path.join(os.tmpdir(), `${Date.now()}.md`)
  await writeFile(file, input.value)
  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  try {
    const exit = await launch(editor, file, {
      cwd: input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd(),
      stdin: input.stdin,
      wait: true,
    })
    if (exit.code !== 0) throw new Error(`Editor exited with ${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}`)
    return (await readFile(file, "utf8")) || undefined
  } finally {
    await rm(file, { force: true }).catch(() => {})
    input.renderer.currentRenderBuffer.clear()
    input.renderer.resume()
    input.renderer.requestRender()
  }
}

/**
 * Opens a file where it is, for editing: in $VISUAL or $EDITOR when one is set and can start, otherwise in whatever the
 * system opens that kind of file with. It rejects when neither can, so that the caller can say where the file is.
 *
 * The editor's name is looked up on PATH alone, never in the working folder, and the program is started by the path that
 * was found. It runs in the folder of the file, and a `cmd.exe` that it or cross-spawn starts is told to skip the working
 * folder too. So a program of the same name in the folder Orbit was started from is not the one that runs.
 */
export async function openFile(input: {
  file: string
  renderer: CliRenderer
  /** Opens a path with the system's default program. */
  system?: (file: string) => Promise<unknown>
}): Promise<"editor" | "system"> {
  const wanted = process.env.VISUAL || process.env.EDITOR
  const failure = wanted ? await edit(wanted, input).then(() => undefined, (error: unknown) => error) : undefined
  if (wanted && failure === undefined) return "editor"
  const { openPath } = await import("@orbit/util/open")
  // The editor's own error says more than the system's, so it is the one a caller sees when both fail.
  await (input.system ?? openPath)(input.file).catch((error: unknown) => {
    throw failure ?? error
  })
  return "system"
}

async function edit(editor: string, input: { file: string; renderer: CliRenderer }) {
  // Look the program up before the terminal is handed over, so that a missing editor leaves the screen alone.
  await program(editor)
  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  try {
    await launch(editor, input.file, { cwd: path.dirname(input.file) })
  } finally {
    input.renderer.currentRenderBuffer.clear()
    input.renderer.resume()
    input.renderer.requestRender()
  }
}

/**
 * Finds the editor on PATH alone and starts it by the path that was found, with `file` as the last argument. The program
 * may be quoted, as a path with spaces has to be, and may take arguments before the file. cross-spawn runs a .cmd or .bat
 * editor, such as code.cmd, the way Windows needs it to be run, and is given the path that `which` found, so it looks
 * nothing up. The spawner of Orbit is not used: it sets `windowsHide` on every child, which is meant for background
 * programs and not for an editor that the person has to see or type into.
 */
async function launch(
  editor: string,
  file: string,
  options: { cwd: string; stdin?: EditorStdio; /** Adds the flag that makes `code` and `subl` stay until the file is closed. */ wait?: boolean },
) {
  const { command, args, found } = await program(editor)
  const { default: crossSpawn } = await import("cross-spawn")
  // Without it `code` and `subl` return at once, and the prompt would come back as it was. Any other value is used as written.
  const wait = options.wait && args.length === 0 && (command === "code" || command === "subl") ? ["--wait"] : []
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = crossSpawn(found, [...args, ...wait, file], {
      cwd: options.cwd,
      env: ProgramLookup.environment(undefined),
      stdio: [options.stdin ?? "inherit", "inherit", "inherit"],
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

async function program(editor: string) {
  const [command, ...args] = [...editor.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  )
  const { which } = await import("@orbit/util/which")
  const found = command ? which(command) : null
  if (!found) throw new Error(`Cannot find the editor ${command ?? editor} on PATH`)
  return { command, args, found }
}

/**
 * The port of an editor's local WebSocket server, read from ORBIT_EDITOR_SSE_PORT. The editor's extension puts it into
 * the environment of its terminals; it names a lock, and the lock holds the token.
 */
export function editorPort(env: Readonly<Record<string, string | undefined>>) {
  const port = Number.parseInt(env.ORBIT_EDITOR_SSE_PORT ?? "", 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/** An editor window whose bridge has written a lock, as the terminal UI may connect to it. */
export type Editor = {
  port: number
  /** Goes into the upgrade request and nowhere else. */
  token: string
  /** Escaped for display with `plain`: the editor chose it. */
  name: string
  /** Paths as the editor reported them, for matching. Show one only through `plain`. */
  folders: string[]
  url: string
  /** When the lock was written, newest first in a list. */
  modified: number
}

const LockShape = Schema.Struct({
  version: Schema.Literal(IdeLock.version),
  pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 31 - 1 })),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  workspaceFolders: Schema.Array(Schema.String.check(Schema.isNonEmpty())),
  ideName: Schema.String,
  authToken: Schema.String.check(Schema.isPattern(IdeLock.tokenPattern)),
})
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(LockShape))

// A lock that is skipped is said once for as long as the file stays as it is, not on every poll.
const reported = new Set<string>()

/**
 * Every live lock in the folder, newest first. A lock that is not valid is skipped with one line in the log and costs
 * nothing else; the terminal UI never deletes one, because the file may belong to a newer extension and only the
 * extension that wrote it knows it is stale.
 */
export function readLocks(lockDirectory: string, log: (line: string) => void = () => {}): Editor[] {
  const entries = (() => {
    try {
      return readdirSync(lockDirectory, { withFileTypes: true })
    } catch {
      return []
    }
  })()
  return entries
    .flatMap((entry) => {
      const port = IdeLock.port(entry.name)
      if (port === undefined) return []
      const file = path.join(lockDirectory, entry.name)
      const skip = (stamp: string, reason: string) => {
        const key = `${file}|${stamp}|${reason}`
        if (reported.has(key)) return []
        if (reported.size > 1000) reported.clear()
        reported.add(key)
        log(`IDE lock ${entry.name} skipped: ${reason}`)
        return []
      }
      if (!entry.isFile()) return skip("entry", "it is not a plain file")
      const stat = (() => {
        try {
          return statSync(file)
        } catch {
          return undefined
        }
      })()
      if (!stat) return []
      const stamp = `${stat.mtimeMs}:${stat.size}`
      if (stat.size > IdeLock.lockCap) return skip(stamp, "it is too large")
      const text = (() => {
        try {
          return readFileSync(file, "utf8")
        } catch {
          return undefined
        }
      })()
      if (text === undefined) return skip(stamp, "it cannot be read")
      // The reason never quotes the file: a lock holds a token.
      const lock = decodeLock(text)
      if (Option.isNone(lock)) return skip(stamp, "it is not a version 1 lock")
      if (lock.value.port !== port) return skip(stamp, "its port is not the one in its name")
      if (!lock.value.workspaceFolders.every((folder) => path.isAbsolute(folder)))
        return skip(stamp, "a workspace folder is not an absolute path")
      if (!alive(lock.value.pid)) return skip(stamp, "its editor is no longer running")
      return [
        {
          port,
          token: lock.value.authToken,
          name: plain(lock.value.ideName),
          folders: [...lock.value.workspaceFolders],
          url: `ws://127.0.0.1:${port}`,
          modified: stat.mtimeMs,
        } satisfies Editor,
      ]
    })
    .sort((a, b) => b.modified - a.modified)
}

/**
 * The editor windows that a terminal in `directory` may use. A lock matches when its port is the one in the environment
 * (the window's own terminals have it), or when one of its workspace folders holds `directory`. With the port in the
 * environment and exactly one lock on it, that is the choice. Otherwise exactly one match is, and more or fewer leave the
 * choice to the person. Both lists are newest first.
 */
export function discoverEditors(input: {
  directory: string
  lockDirectory: string
  env: Readonly<Record<string, string | undefined>>
  log?: (line: string) => void
}) {
  const locks = readLocks(input.lockDirectory, input.log)
  const port = editorPort(input.env)
  const real = realDirectory(input.directory)
  const matched = locks.filter((lock) => lock.port === port || lock.folders.some((folder) => holds(folder, real)))
  const unmatched = locks.filter((lock) => !matched.includes(lock))
  const named = port === undefined ? [] : locks.filter((lock) => lock.port === port)
  const chosen = named.length === 1 ? named[0] : matched.length === 1 ? matched[0] : undefined
  return { matched, unmatched, chosen }
}

function realDirectory(directory: string) {
  try {
    return realpathSync.native(directory).normalize("NFC")
  } catch {
    return path.resolve(directory).normalize("NFC")
  }
}

/**
 * Whether the real path of the session's folder lies inside `folder`. A prefix of the text is not enough (`/a/proj` is not
 * `/a/project`) and a link in either path must not decide, so the folder is resolved on disk first; a folder that cannot
 * be resolved holds nothing. A network or device path is compared as written and never touched, because looking at it
 * could hang or reach a machine the editor named.
 */
function holds(folder: string, directory: string) {
  if (process.platform === "win32" && /^[\\/]{2}/.test(folder))
    return FSUtil.contains(FSUtil.windowsPath(folder).normalize("NFC"), directory)
  try {
    return FSUtil.contains(realpathSync.native(folder).normalize("NFC"), directory)
  } catch {
    return false
  }
}

/** Signal 0 sends nothing: the process exists when it succeeds, or when the system will not let this one signal it. */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * What the TUI can ask the editor it runs beside. `discover` finds the editor window that Orbit's own bridge advertises
 * in the state folder. Zed's selection comes out of Zed's own database, which is another tool's file: callers ask only
 * while compatibility is enabled.
 */
export const editorIntegration = {
  discover: (input: Parameters<typeof discoverEditors>[0]) => discoverEditors(input).chosen,
  selection: async (directory: string) => {
    const { CompatZed } = await import("@orbit/compat/zed")
    return CompatZed.activeSelection(CompatZed.databasePath(), directory)
  },
}
