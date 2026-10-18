export * as CompatEditors from "./editors.js"

type Env = Readonly<Record<string, string | undefined>>

/**
 * The code editors that share VS Code's integrated terminal, its keybindings file and its way of opening a folder from a
 * command line. Orbit adds a Shift+Enter binding to the keybindings file of these editors and opens a folder in them, and
 * this is the one place that spells their names, folders and programs.
 */
export const ids = ["vscode", "cursor", "windsurf"] as const
export type Id = (typeof ids)[number]

const table = {
  vscode: { name: "VS Code", folder: "Code", remote: ".vscode-server" },
  cursor: { name: "Cursor", folder: "Cursor", remote: ".cursor-server" },
  windsurf: { name: "Windsurf", folder: "Windsurf", remote: ".windsurf-server" },
} as const satisfies Record<Id, { name: string; folder: string; remote: string }>

/** The name a person knows the editor by. */
export const name = (id: Id) => table[id].name

/** The editor's own folder under the application data folder of the platform, where its `User` folder lives. */
export const userFolder = (id: Id) => table[id].folder

/** The folder an editor puts its server in on a machine it is connected to, under the home folder of that machine. */
export const remoteFolder = (id: Id) => table[id].remote

/**
 * Which editor's integrated terminal the environment describes. The editors that are built on VS Code say they are VS
 * Code, so the more specific signs come first: a trace variable of one, and the path of the git helper, which the editor
 * puts in the environment of its terminals and which lies in the editor's own folder.
 */
export function terminal(env: Env): Id | undefined {
  const helper = env.GIT_ASKPASS?.toLowerCase() ?? ""
  if (env.CURSOR_TRACE_ID) return "cursor"
  if (helper.includes("cursor")) return "cursor"
  if (helper.includes("windsurf")) return "windsurf"
  if (env.TERM_PROGRAM?.toLowerCase() === "vscode") return "vscode"
  return undefined
}

/**
 * Whether the editor's server runs on another machine: the git helper or `PATH` lies in the folder one of the editors
 * keeps its server in. The keybindings file that counts is then on the machine the editor's window is on, not this one.
 */
export function remote(env: Env) {
  return [env.GIT_ASKPASS, env.PATH].some(
    (value) => value !== undefined && ids.some((id) => value.includes(table[id].remote)),
  )
}

/**
 * The command-line program that opens a folder in the editor a window reports itself as, from the name in its lock. The
 * editors that share VS Code's name are told apart first, because their own names contain `code` too. Any other editor has
 * none.
 */
export function program(windowName: string) {
  const lower = windowName.toLowerCase()
  if (lower.includes("cursor")) return "cursor"
  if (lower.includes("windsurf")) return "windsurf"
  if (lower.includes("codium")) return "codium"
  if (lower.includes("vscode") || lower.includes("visual studio code") || lower === "code") return "code"
  return undefined
}
