import { ClientError, type OrbitClient, type TrustStatus } from "@orbit/client/promise"
import { Effect } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { UI } from "../run/ui"
import { findSession } from "../session-target"
import { errorMessage } from "./error"

type Withheld = TrustStatus["withheld"][number]

/**
 * The shell commands a workflow or suite file defines, as `@orbit/flow` lists them, each with the node or task that
 * carries it.
 */
type Commands = {
  readonly file: string
  readonly found: ReadonlyArray<{ readonly id: string; readonly command: string }>
}

type Options = {
  /** Trust an untrusted folder first (the `--trust` flag). */
  readonly grant?: boolean
  /** A session that, when it exists, decides the folder: the one the run happens in. */
  readonly session?: string
  /** The file the command is about to import from its folder, which runs the code in it. */
  readonly imports?: string
  /** The workflow or suite file the command is about to read, and the shell commands it defines, which may be none. */
  readonly commands?: Commands
}

/**
 * What stops a command before it does any work: its folder is untrusted and its project config holds something back,
 * so a run would quietly go without the project's hooks, MCP servers and plugins and not be the run it asked for. This
 * is the text that says so, or undefined when the command may go ahead, as it may in a folder that holds nothing back
 * whether or not it is trusted. A command that imports a file from its folder, named by `imports`, is stopped by an
 * untrusted folder whatever it holds back, because importing the file runs its code and there is nothing to leave out
 * of that run. So is one that is about to run the shell commands that a workflow or suite file defines, named by
 * `commands`, which no permission rule is asked about. With `grant` (the `--trust` flag) an untrusted folder is first
 * trusted for as long as the serving process lives, which callers make a private one that ends with the run. The
 * folder is the one the run happens in: `directory` unless `session` names a session that exists, which runs in its
 * own folder wherever the command was started. A server older than workspace trust has no such route and holds
 * nothing back, so the command goes ahead, with a line on stderr that says nothing was checked. A trusted folder whose
 * config above it is still held back goes ahead as well, with a line that says what stays off.
 */
export const trustRefusal = Effect.fn("cli.trust.refusal")(function* (
  client: OrbitClient,
  directory: string,
  options: Options = {},
) {
  const named = options.session
  const existing = named === undefined ? undefined : yield* call((signal) => findSession(client, named, signal))
  const location = { directory: existing?.location.directory ?? directory }
  const current = yield* call((signal) => client.location.trust.get({ location }, { signal })).pipe(
    Effect.catchIf(unsupported, () =>
      Effect.sync(() => {
        process.stderr.write(
          `Warning: this server is older than workspace trust, so it applies a folder's project config without asking whether the folder is trusted, and nothing was checked. Restart it to get the check; for the background service that is \`orb service restart\`.${EOL}`,
        )
        return undefined
      }),
    ),
    // A folder that cannot be opened, or a server that does not answer, would otherwise surface as a bare status code.
    Effect.mapError(
      (cause) =>
        new Error(`Could not check whether ${location.directory} is trusted: ${errorMessage(cause)}`, { cause }),
    ),
  )
  if (current === undefined) return undefined
  const status = options.grant && !current.trusted ? yield* grant(client, location) : current
  // A file that defines no command holds nothing up, as a folder that holds nothing back does not.
  const commands = options.commands?.found.length ? options.commands : undefined
  if (blocked(status, options.imports, commands)) return refusal(status, options.imports, commands)
  if (status.withheld.length > 0) yield* Effect.sync(() => process.stderr.write(`Warning: ${notice(status)}${EOL}`))
  return undefined
})

/** Prints the refusal, if there is one, the way `orb run` prints an error, and exits 1: for a command with nothing of its own to report it through. */
export const requireTrust = Effect.fn("cli.trust.require")(function* (
  client: OrbitClient,
  directory: string,
  options: Options = {},
) {
  const text = yield* trustRefusal(client, directory, options)
  if (text === undefined) return
  yield* Effect.sync(() => {
    UI.error(text)
    process.exit(1)
  })
})

/** For a command that cannot stop, such as `orb acp` whose stdout belongs to the protocol: says on stderr what is held back. */
export const warnUntrusted = Effect.fn("cli.trust.warn")(function* (client: OrbitClient, directory: string) {
  const status = yield* call((signal) => client.location.trust.get({ location: { directory } }, { signal }))
  if (status.withheld.length === 0) return
  process.stderr.write(`orb acp: ${notice(status)}${EOL}`)
})

/**
 * What a refusal says: the folder is not trusted, and what that holds up. That is the project config it finds, which
 * holds something back, and, when the command loads a file from the folder, what running that file does: the code
 * it imports (`imports`), or the shell commands it defines (`commands`), which are listed.
 */
export function refusal(status: TrustStatus, imports?: string, commands?: Commands) {
  const own = status.withheld.filter((item) => item.directory === undefined)
  const above = status.withheld.filter((item) => item.directory !== undefined)
  const loads = imports ?? commands?.file
  // What there is to look over before trusting the folder.
  const review = loads === undefined ? "those files" : own.length === 0 ? "the file" : "the file and those files"
  return [
    ...lead(status, imports, commands),
    ...(status.withheld.length === 0
      ? []
      : [
          "",
          ...(loads === undefined
            ? []
            : ["The project config it finds also holds back what could run code or reach the network:", ""]),
          ...heldLines(status.directory, status.withheld),
        ]),
    "",
    // What trusting the project lifts, and the files above it, which only their own folders do.
    ...(own.length === 0 && loads === undefined
      ? []
      : [
          status.persistent
            ? `Look ${review} over, then trust the folder for good with \`orb trust\`, or for this run only with --trust.`
            : "That folder is a home directory or a filesystem root, which Orbit never trusts for good, so `orb trust` refuses it. Pass --trust to trust it for this run only, or run from inside a project folder.",
        ]),
    ...(above.length === 0
      ? []
      : [
          `The files above the project stay off until the folder that holds them is trusted, which trusting the project does not do. Look them over, then trust it for good with ${trustCommands(above)}.`,
        ]),
  ].join(EOL)
}

/** The files and directories that hold something back and what each holds, one line apiece in two columns. */
export function heldLines(directory: string, items: ReadonlyArray<Withheld>) {
  const named = held(directory, items)
  const width = Math.max(...named.map((item) => item.name.length))
  return named.map((item) => `  ${item.name.padEnd(width)}  ${item.kinds}`)
}

/** The commands that trust each folder that holds some of what is held back above the project, as they are typed. */
export function trustCommands(items: ReadonlyArray<Withheld>) {
  return [...new Set(items.flatMap((item) => item.directory ?? []))]
    .map((folder) => `\`orb trust ${quoted(folder)}\``)
    .join(", ")
}

/** A folder as a shell takes it as one argument. */
export function quoted(folder: string) {
  return /\s/.test(folder) ? `"${folder}"` : folder
}

/** Whether the server has no such route, as one older than the trust routes answers: a command can say so or go without. */
export const unsupported = (cause: unknown) =>
  cause instanceof ClientError &&
  cause.reason === "UnexpectedStatus" &&
  typeof cause.cause === "object" &&
  cause.cause !== null &&
  "status" in cause.cause &&
  cause.cause.status === 404

/** Calls the server and keeps whatever error it answers with, which is what the commands report. */
export const call = <A>(request: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: request, catch: (cause) => cause })

// One sentence on what stays off: the project's own files while it is untrusted, and what sits in folders above it.
function notice(status: TrustStatus) {
  const above = status.withheld.filter((item) => item.directory !== undefined)
  const own = status.withheld.filter((item) => item.directory === undefined)
  return [
    ...(own.length === 0
      ? []
      : [
          `${status.directory} is not trusted, so its project config is held back (${summary(status.directory, own)}). ${status.persistent ? "Trust it with `orb trust`." : "Orbit never trusts that folder for good."}`,
        ]),
    ...(above.length === 0
      ? []
      : [
          `Config in a folder above ${status.directory} stays off until that folder is trusted too (${summary(status.directory, above)}): ${trustCommands(above)}.`,
        ]),
  ].join(" ")
}

const summary = (directory: string, items: ReadonlyArray<Withheld>) =>
  held(directory, items)
    .map((item) => `${item.name}: ${item.kinds}`)
    .join("; ")

function held(directory: string, items: ReadonlyArray<Withheld>) {
  return items.map((item) => ({ name: fromFolder(directory, item.path), kinds: item.kinds.join(", ") }))
}

// A file or directory named from the project's folder when it lies inside it.
function fromFolder(directory: string, file: string) {
  const relative = path.relative(directory, file)
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  return inside ? relative : file
}

// What the folder's missing trust holds up, first of all: the config it finds, the code the command imports, or the
// shell commands that the file the command reads defines.
function lead(status: TrustStatus, imports: string | undefined, commands: Commands | undefined) {
  const heading = `Orbit stopped before doing any work: ${status.directory} is not trusted`
  if (imports !== undefined)
    return [
      `${heading}, and this command runs code from the folder: it imports ${fromFolder(status.directory, imports)}, and importing a TypeScript or JavaScript file runs the code in it.`,
    ]
  if (commands !== undefined)
    return [
      `${heading}, and this command runs shell commands from the folder: ${fromFolder(status.directory, commands.file)} defines them, and a run executes them through the platform shell without asking for permission:`,
      "",
      ...commandLines(commands.found),
    ]
  return [`${heading}, so the project config it finds holds back what could run code or reach the network:`]
}

// The shell commands that a file defines, one line apiece in two columns: the node or task that carries one, and the
// command.
function commandLines(found: Commands["found"]) {
  const shown = found.map((item) => ({ id: plain(item.id), command: plain(item.command) }))
  const width = Math.max(...shown.map((item) => item.id.length))
  return shown.map((item) => `  ${item.id.padEnd(width)}  ${item.command}`)
}

// Text from a file that is not trusted yet, on one line and without the characters that act on a terminal or on the text
// around them: control characters, as a carriage return or an escape sequence could overwrite what was printed before
// it, and format characters, as a right-to-left override or a zero-width space reorder or hide text. Either could hide
// a command from the person who is asked to look the file over.
const plain = (text: string) =>
  text.trim().replace(/\r?\n|\p{C}/gu, (match) => {
    if (match.endsWith("\n")) return "\\n"
    const code = match.codePointAt(0) ?? 0
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`
  })

// Trusts the folder for as long as this server lives, and nothing is stored. The config applies a grant a moment after
// it is made, so a run that began in that moment would go without the hooks and plugins that were trusted for it.
// Rebuilding the locations, which on a private server is the run's own, returns once the grant is in force.
const grant = Effect.fnUntraced(function* (client: OrbitClient, location: { readonly directory: string }) {
  const status = yield* call((signal) =>
    client.location.trust.update({ location, trust: true, persist: false }, { signal }),
  )
  yield* call((signal) => client.location.reload({ signal }))
  return status
})

/**
 * Whether the folder is held to a trust it lacks: untrusted, and either something is held back that a grant would let
 * through, or the command loads a file from it that runs code (a module it imports) or shell commands (those that a
 * workflow or suite defines), which a folder that holds nothing back does not excuse.
 */
const blocked = (status: TrustStatus, imports: string | undefined, commands: Commands | undefined) =>
  !status.trusted && (imports !== undefined || commands !== undefined || status.withheld.length > 0)
