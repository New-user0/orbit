import type { CliRenderer } from "@opentui/core"
import { body } from "@orbit/flow/plain"

/**
 * A message body for the screen: model text, a stored prompt, tool output, a question preview or a tool error. Line breaks
 * and tabs stay; control characters and bidi overrides are written out, such as `\x1b` and `\u{202e}`, so an escape
 * sequence cannot act on the terminal and an approver can see that it was there. The escaping is `plain`'s, in
 * `@orbit/flow/plain`.
 */
export function bodyText(text: string) {
  return body(text)
}

/**
 * Program output for the screen. A lone carriage return is how progress meters (`git clone`, `npm`, `curl -#`) redraw
 * a line, and the renderer draws one as a line break, so it becomes one here instead of being written out as `\x0d`.
 * Commands and approval prompts use `bodyText`, where a carriage return is an ordinary character for the shell.
 */
export function outputText(text: string) {
  return bodyText(text.replace(/\r\n?/g, "\n"))
}

/**
 * The title of the terminal window for a session: its title without control and format characters, cut to 40
 * characters. A title can come from a model or from a workflow file, and the renderer writes the title into an escape
 * sequence as it is, so a BEL in it ends the sequence early and what follows acts as one of its own.
 */
export function terminalTitle(title: string | undefined, activity?: "working" | "needs input") {
  const clean = (title ?? "").replace(/\p{C}/gu, "")
  const named = clean ? `Orbit · ${clean.length > 40 ? clean.slice(0, 37) + "…" : clean}` : "Orbit"
  return activity ? `${named} · ${activity}` : named
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  renderer.destroy()
}
