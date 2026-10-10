import type { CliRenderer } from "@opentui/core"
import { body } from "@orbit/flow/plain"
import { isFallbackTitle } from "@orbit/util/session-title-fallback"

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

/**
 * The Mini footer's window title: written only where the terminal title is Orbit's to set (Linux), with the session
 * title cleaned by `terminalTitle` and the activity the footer reports.
 */
export function createMiniTitle(
  renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle">,
  platform: string,
  initial?: string,
) {
  let titled = initial
  let activity: "working" | "needs input" | undefined
  const write = () => {
    if (platform !== "linux" || renderer.isDestroyed) return
    renderer.setTerminalTitle(terminalTitle(!titled || isFallbackTitle(titled) ? undefined : titled, activity))
  }
  write()
  return {
    setTitle(title?: string) {
      titled = title
      write()
    },
    setActivity(next: "working" | "needs input" | undefined) {
      if (activity === next) return
      activity = next
      write()
    },
  }
}

export function destroyRenderer(renderer: Pick<CliRenderer, "isDestroyed" | "setTerminalTitle" | "destroy">) {
  renderer.setTerminalTitle("")
  if (renderer.isDestroyed) return
  renderer.destroy()
}
