import type { CliRenderer } from "@opentui/core"

/**
 * The title of the terminal window for a session: its title without control and format characters, cut to 40
 * characters. A title can come from a model or from a workflow file, and the renderer writes the title into an escape
 * sequence as it is, so a BEL in it ends the sequence early and what follows acts as one of its own.
 */
export function terminalTitle(title: string) {
  const clean = title.replace(/\p{C}/gu, "")
  return `OC | ${clean.length > 40 ? clean.slice(0, 37) + "…" : clean}`
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  renderer.destroy()
}
