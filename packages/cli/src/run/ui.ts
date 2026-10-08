import { progress } from "@orbit/flow/plain"
import { EOL } from "node:os"

export const Style = {
  TEXT_DIM: "\x1b[90m",
  TEXT_NORMAL: "\x1b[0m",
  TEXT_WARNING_BOLD: "\x1b[93m\x1b[1m",
  TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
}

export function println(...message: string[]) {
  process.stderr.write(message.join(" ") + EOL)
}

let blank = false

export function empty() {
  if (blank) return
  println(Style.TEXT_NORMAL)
  blank = true
}

export function error(message: string) {
  if (message.startsWith("Error: ")) message = message.slice("Error: ".length)
  // A failure's text comes from a provider, a tool or a stored message, which a repository can shape, so each line is
  // written out as `progress` does before it reaches the terminal.
  println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message.split(/\r?\n/).map(progress).join(EOL))
}

export * as UI from "./ui"
