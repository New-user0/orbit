/**
 * The built-in commands that Orbit offers a person, or has promised, in neutral words. Each entry names the command a
 * person may expect and says where it stands:
 *
 *  - `present`: a slash command serves it, under the names in `slash` (which may differ from `name`, and may be an alias).
 *  - `pending`: another task owns it and has not landed. The task that lands it flips the entry to `present`.
 *  - `cli`: it is a command of the `orb` program and not a slash command.
 *  - `server`: the server registers it as a built-in command.
 *
 * Commands that only Orbit has are listed too (`own`), so that "no registered built-in is missing from this list" can hold.
 * This file is data only: the tests in the TUI and in core read it.
 */
export type SlashEntry =
  | { name: string; state: "present"; slash: readonly string[]; own?: true }
  | { name: string; state: "pending"; task: string }
  | { name: string; state: "cli"; command: string }
  | { name: string; state: "server" }

const present = (name: string, ...slash: string[]): SlashEntry => ({ name, state: "present", slash: slash.length ? slash : [name] })
const own = (name: string, ...slash: string[]): SlashEntry => ({ ...present(name, ...slash), own: true }) as SlashEntry
const pending = (name: string, task: string): SlashEntry => ({ name, state: "pending", task })

export const slashParity: readonly SlashEntry[] = [
  // Commands that people of other tools expect.
  present("agents"),
  present("btw"),
  present("compact"),
  present("context"),
  present("copy"),
  present("diff"),
  present("export"),
  present("help"),
  present("keybindings"),
  present("output-style"),
  present("rename"),
  present("skills"),
  present("stats"),
  present("status"),
  present("clear"),
  present("config"),
  present("cost"),
  present("effort"),
  present("exit"),
  present("branch", "fork"),
  present("ide"),
  present("terminal-setup"),
  present("vim"),
  present("mcp"),
  present("model"),
  present("plugin"),
  present("resume"),
  present("theme", "themes"),
  { name: "init", state: "server" },
  { name: "review", state: "server" },
  { name: "doctor", state: "cli", command: "orb doctor" },
  pending("add-dir", "clients-ux-39"),
  pending("permissions", "clients-ux-39"),
  pending("hooks", "clients-ux-41"),
  pending("memory", "clients-ux-42"),
  pending("rewind", "clients-ux-5"),
  pending("statusline", "agents-extensibility-38"),
  pending("pr-comments", "agents-extensibility-41"),
  pending("plan", "agents-extensibility-19"),
  pending("security-review", "agents-extensibility-19"),
  // The other names and aliases of the commands above that Orbit registers.
  own("quit", "quit", "q"),
  own("usage", "usage"),
  own("thinking", "thinking"),
  own("continue", "continue"),
  // Commands that only Orbit has.
  own("settings"),
  own("sessions"),
  own("models"),
  own("mcps"),
  own("plugins"),
  own("variants"),
  own("new"),
  own("open", "open", "projects", "project"),
  own("connect"),
  own("debug"),
  own("editor"),
  own("reload"),
  own("restart"),
  own("update"),
  own("runs"),
  own("map"),
  own("pair", "pair", "web"),
  own("share"),
  own("unshare"),
  own("timeline"),
  own("undo"),
  own("redo"),
  own("worktrees"),
  own("trust"),
  own("terminal"),
  own("cd"),
  own("todos"),
]

/** Everything the list says the slash commands are called. */
export const listedNames = () => new Set(slashParity.flatMap((entry) => (entry.state === "present" ? entry.slash : [])))

export type Registered = { readonly names: ReadonlySet<string>; readonly claims: readonly string[] }

/**
 * What is wrong between the list and the commands that are registered, one sentence each: an entry that is present and
 * resolves to nothing, a registered name or alias that no entry lists, an entry that is pending and already registered,
 * and two commands that claim one name. `claims` holds every name and alias once per command that registered it.
 */
export function problems(registered: Registered, list: readonly SlashEntry[] = slashParity) {
  const listed = new Set(list.flatMap((entry) => (entry.state === "present" ? entry.slash : [])))
  return [
    ...list.flatMap((entry) =>
      entry.state === "present" && !entry.slash.some((name) => registered.names.has(name))
        ? [`${entry.name} is listed as present but nothing registers ${entry.slash.join(" or ")}`]
        : [],
    ),
    ...[...registered.names].flatMap((name) => (listed.has(name) ? [] : [`${name} is registered but not listed`])),
    ...list.flatMap((entry) =>
      entry.state === "pending" && registered.names.has(entry.name)
        ? [`${entry.name} is pending (${entry.task}) but already registered`]
        : [],
    ),
    ...[...new Set(registered.claims.filter((name, index) => registered.claims.indexOf(name) !== index))].map(
      (name) => `${name} is claimed by more than one command`,
    ),
  ]
}
