import type { CliRenderer } from "@opentui/core"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Stream } from "node:stream"
import { ProgramLookup } from "@orbit/util/program-lookup"

export { normalizePromptContent } from "./prompt/content"

type EditorStdio = "inherit" | "pipe" | "ignore" | number | Stream

export async function openEditor(input: { value: string; renderer: CliRenderer; cwd?: string; stdin?: EditorStdio }) {
  const editor = process.env.VISUAL || process.env.EDITOR
  if (!editor) return
  const file = path.join(os.tmpdir(), `${Date.now()}.md`)
  await writeFile(file, input.value)
  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  try {
    await new Promise<void>((resolve, reject) => {
      const parts = editor.split(" ")
      const child = spawn(parts[0]!, [...parts.slice(1), file], {
        cwd: input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd(),
        stdio: [input.stdin ?? "inherit", "inherit", "inherit"],
        shell: process.platform === "win32",
      })
      child.on("error", reject)
      child.on("exit", (code, signal) => {
        if (code === 0) return resolve()
        reject(new Error(`Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
    })
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
  // The program may be quoted, as a path with spaces has to be, and may take arguments before the file.
  const [command, ...args] = [...editor.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  )
  const { which } = await import("@orbit/core/util/which")
  const program = command ? which(command) : null
  if (!program) throw new Error(`Cannot find the editor ${command ?? editor} on PATH`)
  // cross-spawn runs a .cmd or .bat editor, such as code.cmd, the way Windows needs it to be run, and is given the path
  // that `which` found, so it looks nothing up. The spawner of Orbit is not used: it sets `windowsHide` on every child,
  // which is meant for background programs and not for an editor that the person has to see or type into.
  const { default: crossSpawn } = await import("cross-spawn")
  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  try {
    await new Promise<void>((resolve, reject) => {
      const child = crossSpawn(program, [...args, input.file], {
        cwd: path.dirname(input.file),
        env: ProgramLookup.environment(undefined),
        stdio: "inherit",
      })
      child.once("error", reject)
      child.once("exit", () => resolve())
    })
  } finally {
    input.renderer.currentRenderBuffer.clear()
    input.renderer.resume()
    input.renderer.requestRender()
  }
}

/**
 * The port of an editor's local WebSocket server, read from ORBIT_EDITOR_SSE_PORT. Until Orbit's own IDE bridge can find
 * an editor by itself, this is the only way to point Orbit at one.
 */
export function editorPort(env: Readonly<Record<string, string | undefined>>) {
  const port = Number.parseInt(env.ORBIT_EDITOR_SSE_PORT ?? "", 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

/**
 * What the TUI can ask the editor it runs beside. Nothing here finds a WebSocket editor, so one is reached only through
 * `editorPort`. Zed's selection comes out of Zed's own database, which is another tool's file: callers ask only while
 * compatibility is enabled.
 */
export const editorIntegration = {
  selection: async (directory: string) => {
    const { CompatZed } = await import("@orbit/compat/zed")
    return CompatZed.activeSelection(CompatZed.databasePath(), directory)
  },
}
