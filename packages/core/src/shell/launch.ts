export * as ShellLaunch from "./launch.js"

import type { Command, Word } from "./analysis.js"
import { ShellWrappers } from "./wrappers.js"

// Commands that start another shell and hand it a script. When the script is a literal word the analysis reads it
// (`script`); when Orbit cannot see what will run (a computed script, a pipe, an encoded command, an option it cannot
// place) the launch is `opaque`. A script file (`bash x.sh`, `pwsh -File x.ps1`) is neither: it is an ordinary program.

export type Launch = { kind: "script"; dialect: "bash" | "powershell"; program: string; text: string } | { kind: "opaque" }

export const BASH_SHELLS = ["sh", "bash", "dash", "ksh", "mksh", "ash", "zsh"]
const OTHER_SHELLS = ["fish", "csh", "tcsh", "nu"]
const POWERSHELLS = ["pwsh", "powershell"]

/** The program's base name: lower-case and without `.exe` on Windows, as written elsewhere. */
export function programName(raw: string, platform: NodeJS.Platform) {
  const base = raw.slice(Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\")) + 1)
  return platform === "win32" ? base.toLowerCase().replace(/\.exe$/, "") : base
}

/** A program that runs a script Orbit may not be able to read: any shell, `cmd`, `wsl`. */
export function isShell(name: string) {
  return [...BASH_SHELLS, ...OTHER_SHELLS, ...POWERSHELLS, "cmd", "wsl"].includes(name)
}

export function launch(command: Command, platform: NodeJS.Platform): Launch | undefined {
  const words = command.argv.slice(command.argv.length - command.inner.length)
  const program = command.inner[0]
  if (program === undefined || words.length === 0) return undefined
  const name = programName(program, platform)
  const reads = command.piped === true || command.redirects.some((item) => item.op === "<<" || item.op === "<<<")
  const args = words.slice(1).map((word) => word.value)
  const opaque = { kind: "opaque" as const }
  if (BASH_SHELLS.includes(name)) return bashLaunch(program, words, reads)
  if (POWERSHELLS.includes(name)) return powershellLaunch(program, name, words, reads)
  if (name === "cmd") return reads || args.some((arg) => /^\/[ckr]/i.test(arg)) ? opaque : undefined
  if (OTHER_SHELLS.includes(name)) return reads || args.some((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg) || /^--commands?(?:=|$)/.test(arg)) ? opaque : undefined
  if (name === "wsl" || name === "watch") return opaque
  if (name === "su") return args.some((arg) => /^-[A-Za-z]*c$/.test(arg) || /^--(?:command|session-command)(?:=|$)/.test(arg)) ? opaque : undefined
  if (name === "script") return args.some((arg) => /^-[A-Za-z]*c$/.test(arg) || /^--command(?:=|$)/.test(arg)) ? opaque : undefined
  if (name === "flock") return flock(args) ? opaque : undefined
  if (name === "find") return ShellWrappers.find(command.inner).exec.some((action) => runsShell(action, platform)) ? opaque : undefined
  if (name === "xargs") {
    const program = ShellWrappers.xargs(command.inner).program
    return program === undefined || runsShell(program, platform) ? opaque : undefined
  }
  return undefined
}

// The program of an action's argv is a shell, or cannot be told after its wrappers.
function runsShell(argv: string[], platform: NodeJS.Platform) {
  if (argv.length === 0) return false
  const unwrapped = ShellWrappers.unwrap(argv)
  if (unwrapped.unanalysable) return true
  return isShell(programName(unwrapped.inner[0] ?? "", platform))
}

const BASH_LONG = new Set([
  "--debug",
  "--debugger",
  "--dump-po-strings",
  "--dump-strings",
  "--help",
  "--login",
  "--noediting",
  "--noprofile",
  "--norc",
  "--posix",
  "--pretty-print",
  "--restricted",
  "--verbose",
  "--version",
])

// See the OPTIONS section of the bash manual. `-o` and `-O` (also `+o`, `+O`), `--rcfile` and `--init-file` take a value.
function bashLaunch(program: string, words: Word[], reads: boolean): Launch | undefined {
  const opaque = { kind: "opaque" as const }
  let command = false
  let stdin = false
  let index = 1
  for (; index < words.length; index++) {
    const token = words[index].value
    if (token === "--") {
      index++
      break
    }
    if (token.startsWith("--")) {
      if (token === "--rcfile" || token === "--init-file") index++
      else if (!BASH_LONG.has(token)) return opaque
      continue
    }
    if (token.length < 2 || (token[0] !== "-" && token[0] !== "+")) break
    for (const char of token.slice(1)) {
      if (char === "c" && token[0] === "-") command = true
      else if (char === "s" && token[0] === "-") stdin = true
      else if (char === "o" || char === "O") index++
    }
  }
  const operand = words[index]
  if (command) return operand?.literal ? { kind: "script", dialect: "bash", program, text: operand.value } : opaque
  if (operand === undefined || operand.value === "-" || stdin) return reads ? opaque : undefined
  return undefined
}

// Parameters of the PowerShell programs, in the order the programs test them (see `about_Pwsh` and
// `about_PowerShell_exe`). A written name matches the first entry that it starts and that it is long enough for.
const PARAMETERS: { name: string; min: number; value?: true }[] = [
  { name: "file", min: 1, value: true },
  { name: "command", min: 1, value: true },
  { name: "encodedcommand", min: 1, value: true },
  { name: "ec", min: 2, value: true },
  { name: "encodedarguments", min: 2, value: true },
  { name: "workingdirectory", min: 2, value: true },
  { name: "wd", min: 2, value: true },
  { name: "configurationname", min: 6, value: true },
  { name: "configurationfile", min: 14, value: true },
  { name: "custompipename", min: 3, value: true },
  { name: "executionpolicy", min: 2, value: true },
  { name: "ep", min: 2, value: true },
  { name: "inputformat", min: 2, value: true },
  { name: "if", min: 2, value: true },
  { name: "outputformat", min: 1, value: true },
  { name: "of", min: 2, value: true },
  { name: "settingsfile", min: 3, value: true },
  { name: "version", min: 1, value: true },
  { name: "windowstyle", min: 1, value: true },
  { name: "psconsolefile", min: 2, value: true },
  { name: "noprofile", min: 3 },
  { name: "nologo", min: 3 },
  { name: "noninteractive", min: 4 },
  { name: "noexit", min: 3 },
  { name: "interactive", min: 1 },
  { name: "login", min: 1 },
  { name: "sta", min: 3 },
  { name: "mta", min: 3 },
  { name: "noprofileloadtime", min: 8 },
  { name: "help", min: 1 },
  { name: "?", min: 1 },
]
const DASHES = /^[-–—―]+/

/** The canonical parameter a written PowerShell program parameter stands for, or undefined when it is not one. */
export function powershellParameter(written: string) {
  const name = written.replace(DASHES, "").replace(/^\//, "").split(":")[0].toLowerCase()
  if (name === "") return undefined
  return PARAMETERS.find((entry) => name.length >= entry.min && entry.name.startsWith(name))
}

function powershellLaunch(program: string, name: string, words: Word[], reads: boolean): Launch | undefined {
  const opaque = { kind: "opaque" as const }
  const script = (from: number, inline?: string): Launch => {
    const rest = words.slice(from)
    const text = [...(inline === undefined ? [] : [inline]), ...rest.map((word) => word.value)].join(" ")
    if (rest.length === 0 && inline === undefined) return opaque
    if (rest[0]?.value === "-" && inline === undefined) return opaque
    if (!rest.every((word) => word.literal)) return opaque
    return { kind: "script", dialect: "powershell", program, text }
  }
  for (let index = 1; index < words.length; index++) {
    const token = words[index].value
    const dash = DASHES.test(token) || (name === "powershell" && token.startsWith("/") && powershellParameter(token) !== undefined)
    if (!dash) return name === "powershell" ? script(index) : undefined
    const parameter = powershellParameter(token)
    if (!parameter) return opaque
    const colon = token.indexOf(":")
    const inline = colon > 0 ? token.slice(colon + 1) : undefined
    if (["encodedcommand", "ec", "workingdirectory", "wd"].includes(parameter.name)) return opaque
    if (parameter.name === "command") return script(index + 1, inline)
    if (parameter.name === "file") return (inline ?? words[index + 1]?.value) === "-" ? opaque : undefined
    if (parameter.value && inline === undefined) index++
  }
  return reads ? opaque : undefined
}

// `flock` runs a command: after `-c`, or after the lock file.
function flock(args: string[]) {
  let positional = 0
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === "-c" || /^--command(?:=|$)/.test(token)) return true
    if (["-w", "-E", "--timeout", "--wait", "--conflict-exit-code"].includes(token)) index++
    else if (!token.startsWith("-")) positional++
  }
  return positional >= 2
}
