import type { CliRenderer } from "@opentui/core"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import type { Stream } from "node:stream"

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
