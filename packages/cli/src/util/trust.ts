import { ClientError, type OrbitClient, type TrustStatus } from "@orbit/client/promise"
import { plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { UI } from "../run/ui"
import { findSession } from "../session-target"
import { errorMessage } from "./error"

type Withheld = TrustStatus["withheld"][number]

/**
 * What a workflow or suite file defines that a run carries out on its own account, as `@orbit/flow` lists it, each with
 * the node or task that carries it: the shell commands, the nodes whose agents have every action they ask permission
 * for approved, with the `permissions` they set as written, and the nodes that run as one of the user's agents because
 * the file names it, with the `agent` as written. Any of them can be none.
 */
type Defined = {
  readonly file: string
  readonly commands: ReadonlyArray<{ readonly id: string; readonly command: string }>
  readonly approvals: ReadonlyArray<{ readonly id: string; readonly permissions: string }>
  readonly agents: ReadonlyArray<{ readonly id: string; readonly agent: string }>
}

type Options = {
  /** Trust an untrusted folder first (the `--trust` flag). */
  readonly grant?: boolean
  /** A session that, when it exists, decides the folder: the one the run happens in. */
  readonly session?: string
  /** The file the command is about to import from its folder, which runs the code in it. */
  readonly imports?: string
  /** The workflow or suite file the command is about to read, and what a run of it carries out, which may be nothing. */
  readonly defines?: Defined
}

/**
 * What stops a command before it does any work: its folder is untrusted and its project config holds something back,
 * so a run would quietly go without the project's hooks, MCP servers and plugins and not be the run it asked for. This
 * is the text that says so, or undefined when the command may go ahead, as it may in a folder that holds nothing back
 * whether or not it is trusted. A command that imports a file from its folder, named by `imports`, is stopped by an
 * untrusted folder whatever it holds back, because importing the file runs its code and there is nothing to leave out
 * of that run. So is one that is about to run what a workflow or suite file defines, named by `defines`: shell commands,
 * which no permission rule is asked about, nodes that approve what their agents ask permission for, and nodes that run
 * as an agent the file names, whose own rules are added after the user's global ones and win. The last two settle the
 * user's own rules in the file's favour. With `grant` (the `--trust` flag) an untrusted folder is first trusted for
 * as long as the serving process lives, which callers make a private one that ends with the run. The folder is the one
 * the run happens in: `directory` unless `session` names a session that exists, which runs in its own folder wherever
 * the command was started. A server older than workspace trust has no such route and holds nothing back, so a command
 * that only checks what is held back goes ahead, with a line on stderr that says nothing was checked. One that imports
 * a file or runs what a file defines does not: that server cannot say whether the folder is trusted, and this process
 * would run the file or the commands itself, so the text says so and names the ways to get an answer. A trusted folder
 * whose config above it is still held back goes ahead, with a line that says what stays off.
 */
export const trustRefusal = Effect.fn("cli.trust.refusal")(function* (
  client: OrbitClient,
  directory: string,
  options: Options = {},
) {
  const named = options.session
  const existing = named === undefined ? undefined : yield* call((signal) => findSession(client, named, signal))
  const location = { directory: existing?.location.directory ?? directory }
  // A file that defines nothing a run carries out holds nothing up, as a folder that holds nothing back does not.
  const defined =
    options.defines &&
    (options.defines.commands.length > 0 || options.defines.approvals.length > 0 || options.defines.agents.length > 0)
      ? options.defines
      : undefined
  const current = yield* call((signal) => client.location.trust.get({ location }, { signal })).pipe(
    // A server older than workspace trust has no such route.
    Effect.catchIf(unsupported, () => Effect.succeed(undefined)),
    // A folder that cannot be opened, or a server that does not answer, would otherwise surface as a bare status code.
    Effect.mapError(
      (cause) =>
        new Error(`Could not check whether ${location.directory} is trusted: ${errorMessage(cause)}`, { cause }),
    ),
  )
  if (current === undefined) {
    if (options.imports !== undefined || defined !== undefined)
      return unanswered(location.directory, options.imports, defined)
    yield* Effect.sync(() =>
      process.stderr.write(
        `Warning: this server is older than workspace trust, so it applies a folder's project config without asking whether the folder is trusted, and nothing was checked. Restart it to get the check; for the background service that is \`orb service restart\`.${EOL}`,
      ),
    )
    return undefined
  }
  const status = options.grant && !current.trusted ? yield* grant(client, location) : current
  if (blocked(status, options.imports, defined)) return refusal(status, options.imports, defined)
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
 * it imports (`imports`), or what it defines (`defines`), which is listed: shell commands, nodes that approve what
 * their agents ask permission for, and nodes that run as an agent the file names.
 */
export function refusal(status: TrustStatus, imports?: string, defines?: Defined) {
  const own = status.withheld.filter((item) => item.directory === undefined)
  const above = status.withheld.filter((item) => item.directory !== undefined)
  const loads = imports ?? defines?.file
  // What there is to look over before trusting the folder.
  const review = loads === undefined ? "those files" : own.length === 0 ? "the file" : "the file and those files"
  return [
    ...lead(
      `Orbit stopped before doing any work: ${status.directory} is not trusted`,
      status.directory,
      imports,
      defines,
    ),
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

/**
 * What a refusal says when the server has no trust routes, because it is older than workspace trust: it cannot say whether
 * the folder is trusted, and the command is about to run what the folder brings in this process, so it stops. The text
 * names the file and what it brings as `refusal` does, and the ways to get an answer.
 */
export function unanswered(directory: string, imports?: string, defines?: Defined) {
  return [
    ...lead(
      `Orbit stopped before doing any work: the server is older than workspace trust, so it cannot say whether ${directory} is trusted`,
      directory,
      imports,
      defines,
    ),
    "",
    "Restart the server to get an answer, which for the background service is `orb service restart`. Or run on a current private server instead: --standalone starts one that checks the folder, and --trust starts one that trusts the folder for this run only.",
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
  return items.map((item) => ({ name: plain(fromFolder(directory, item.path)), kinds: item.kinds.join(", ") }))
}

// A file or directory named from the project's folder when it lies inside it.
function fromFolder(directory: string, file: string) {
  const relative = path.relative(directory, file)
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  return inside ? relative : file
}

// What the folder's missing trust holds up, first of all: the code the command imports, what the file it reads defines
// (shell commands, nodes that approve what their agents ask permission for, and nodes that run as an agent the file
// names), or else the config it finds. `heading` is what comes before: why the folder is not enough as it stands.
function lead(heading: string, directory: string, imports: string | undefined, defines: Defined | undefined) {
  if (imports !== undefined)
    return [
      `${heading}, and this command runs code from the folder: it imports ${plain(fromFolder(directory, imports))}, and importing a TypeScript or JavaScript file runs the code in it.`,
    ]
  if (defines === undefined)
    return [`${heading}, so the project config it finds holds back what could run code or reach the network:`]
  const file = plain(fromFolder(directory, defines.file))
  // Each is a sentence that says what the command does, with the rows it found.
  const found = [
    ...(defines.commands.length === 0
      ? []
      : [
          {
            says: `runs shell commands from the folder: ${file} defines them, and a run executes them through the platform shell without asking for permission:`,
            rows: defines.commands.map((item) => [item.id, item.command] as const),
          },
        ]),
    ...(defines.approvals.length === 0
      ? []
      : [
          {
            says: `approves actions without asking you: ${file} sets \`permissions\` on the nodes below to \`auto\`, or to a template that can fill in as \`auto\`, which makes a run say yes, once, to every action their agents ask permission for, where it rejects them otherwise:`,
            rows: defines.approvals.map((item) => [item.id, `permissions: ${item.permissions}`] as const),
          },
        ]),
    ...(defines.agents.length === 0
      ? []
      : [
          {
            says: `lets the file choose which of your agents run its nodes: ${file} names an \`agent\` for each entry below, and an agent's own rules are added after your global rules, where the last match wins, so the file can pick an agent whose rules allow actions that yours ask about, which a run then does without asking:`,
            rows: defines.agents.map((item) => [item.id, `agent: ${item.agent}`] as const),
          },
        ]),
  ]
  return found.flatMap((item, index) => [
    ...(index === 0 ? [`${heading}, and this command ${item.says}`] : ["", `It also ${item.says}`]),
    "",
    ...columns(item.rows),
  ])
}

// What a file defines, one line apiece in two columns: the node or task that carries it, and what it is.
function columns(rows: ReadonlyArray<readonly [string, string]>) {
  const shown = rows.map(([id, text]) => ({ id: plain(id), text: plain(text) }))
  const width = Math.max(...shown.map((item) => item.id.length))
  return shown.map((item) => `  ${item.id.padEnd(width)}  ${item.text}`)
}

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
 * through, or the command loads a file from it that runs code (a module it imports) or carries out what the file defines
 * (shell commands, approvals of what agents ask permission for, and the choice of which agents run), which a folder that
 * holds nothing back does not excuse.
 */
const blocked = (status: TrustStatus, imports: string | undefined, defines: Defined | undefined) =>
  !status.trusted && (imports !== undefined || defines !== undefined || status.withheld.length > 0)
