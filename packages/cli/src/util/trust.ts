import { ClientError, type OrbitClient, type TrustStatus } from "@orbit/client/promise"
import { plain } from "@orbit/flow/plain"
import { shellArgument } from "@orbit/util/shell-argument"
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
  /** The models and limits on attempts that the file picks, as `field: value`. */
  readonly models: ReadonlyArray<{ readonly id: string; readonly choice: string }>
}

type Options = {
  /** Trust an untrusted folder first (the `--trust` flag). */
  readonly grant?: boolean
  /** A session that, when it exists, decides the folder: the one the run happens in. */
  readonly session?: string
  /** The file the command is about to import, which runs the code in it. */
  readonly imports?: string
  /** The workflow or suite file the command is about to read, and what a run of it carries out, which may be nothing. */
  readonly defines?: Defined
  /**
   * The command sends the folder to a model and runs the tool calls that come back (`orb -p`): any untrusted folder
   * stops it, whether or not its config holds something back, because the folder's own instructions and files steer
   * the model and the default rules let its tool calls run without asking. `recorded` stops it for the same folders for
   * another reason: the command goes on from a run that the folder's run store records (`orb flow resume`,
   * `orb eval --resume`, `orb flow replay`), and the store is a file that a clone can ship with any run in it.
   */
  readonly strict?: boolean | "recorded"
}

/**
 * What stops a command before it does any work: its folder is not trusted, whatever the folder holds, because nothing a
 * folder supplies loads and no work starts there until the person trusts it (trust-first, class 12). A trusted folder
 * goes ahead with its config as it is now, whatever changed since the grant (D8). This is the text that says so, or
 * undefined when the command may go ahead. What the refusal explains depends on what the command was about
 * to do: import a file (`imports`), run what a workflow or suite file defines (`defines`: shell commands, nodes that
 * approve what their agents ask permission for, nodes that run as an agent the file names, and the models it picks),
 * send the folder to a model (`strict`), or go on from a run the folder's run store records (`strict: "recorded"`).
 * The code and the commands of a file come from the folder that holds it, which need not be the one the run happens in
 * and can belong to another project, so that folder has to be trusted as well. It is asked after the folder of the run,
 * so it is left out when the file is in that very folder. With `grant` (the `--trust` flag) an untrusted folder is first
 * trusted for as long as the serving process lives, which callers make a private one that ends with the run, and so is
 * the folder that holds the file. The folder is the one the run happens in: `directory` unless `session` names a
 * session that exists, which runs in its own folder wherever the command was started. A server older than workspace
 * trust cannot say whether the folder is trusted, so the command stops, and the text names the ways to get an answer
 * (class 7).
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
    (options.defines.commands.length > 0 ||
      options.defines.approvals.length > 0 ||
      options.defines.agents.length > 0 ||
      options.defines.models.length > 0)
      ? options.defines
      : undefined
  const current = yield* call((signal) => client.location.trust.get({ location }, { signal })).pipe(
    // A server older than workspace trust has no such route.
    Effect.catchIf(unsupported, () => Effect.succeed(undefined)),
    Effect.mapError(unchecked(location.directory)),
  )
  if (current === undefined) return unanswered(location.directory, options.imports, defined, options.strict)
  const status = options.grant && blocked(current) ? yield* grant(client, location) : current
  if (blocked(status)) return refusal(status, options.imports, defined, options.strict)
  // The folder that holds the file is the run's own unless the command was given a path elsewhere, and another project
  // can own that folder: the run takes nothing from it but the file, and the file is what its trust is for. Getting here
  // with a file means that the project of the run is trusted, so a folder of the same project is trusted as well.
  const file = options.imports ?? defined?.file
  const holder = file === undefined ? undefined : { directory: path.dirname(path.resolve(location.directory, file)) }
  if (holder === undefined || holder.directory === location.directory) return undefined
  const asked = yield* call((signal) => client.location.trust.get({ location: holder }, { signal })).pipe(
    Effect.mapError(unchecked(holder.directory)),
  )
  const decided = options.grant && !asked.trusted ? yield* grant(client, holder) : asked
  return decided.trusted ? undefined : holderRefusal(decided, options.imports, defined)
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

/**
 * The project of the folder, as the server resolved it, when the folder is trusted now, for a command that goes ahead
 * either way but must not start the folder's version control in one that is not (class 1): `orb flow run`, `flow resume`,
 * `flow clean` and `eval`. Its folders are the ones the decision covers, and the repository that git uses there must
 * stay inside them (`Git.root` of `@orbit/flow`). Ask after `requireTrust`, so that a `--trust` grant is in force. A
 * server that cannot say, or does not answer, counts as no.
 */
export const trustedProject = Effect.fn("cli.trust.project")(function* (client: OrbitClient, directory: string) {
  const status = yield* call((signal) => client.location.trust.get({ location: { directory } }, { signal })).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  if (status?.trusted !== true) return undefined
  const location = yield* call((signal) => client.location.get({ location: { directory } }, { signal })).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  return location?.project
})

/**
 * What a refusal says: the folder is not trusted, and what that holds up. That is the project config it finds, which
 * holds something back, and, when the command loads a file from the folder, what running that file does: the code
 * it imports (`imports`), or what it defines (`defines`), which is listed: shell commands, nodes that approve what
 * their agents ask permission for, and nodes that run as an agent the file names.
 */
export function refusal(
  status: TrustStatus,
  imports?: string,
  defines?: Defined,
  strict?: boolean | "recorded",
) {
  const own = status.withheld
  const loads = imports ?? defines?.file
  // A command that goes on from the run store is stopped by the folder itself, whatever it holds back.
  const recorded = strict === "recorded" && loads === undefined
  // A command stopped by a folder that holds nothing back: there is no list to show, only the folder itself.
  const quiet = status.withheld.length === 0 && loads === undefined && !recorded
  // What there is to look over before trusting the folder.
  const review =
    loads === undefined
      ? quiet || (recorded && own.length === 0)
        ? "the folder"
        : recorded
          ? "the folder and those files"
          : "those files"
      : own.length === 0
        ? "the file"
        : "the file and those files"
  return [
    ...lead(
      `Orbit stopped before doing any work: ${plain(status.directory)} is not trusted`,
      status.directory,
      imports,
      defines,
      recorded ? "recorded" : quiet ? (strict === true ? "prompt" : "folder") : undefined,
    ),
    ...(status.withheld.length === 0
      ? []
      : [
          "",
          ...(loads === undefined && !recorded
            ? []
            : ["The project config it finds also holds back what could run code or reach the network:", ""]),
          ...heldLines(status.directory, status.withheld),
        ]),
    "",
    // What trusting the project lifts.
    ...(own.length === 0 && loads === undefined && !quiet && !recorded
      ? []
      : [
          status.persistent
            ? `Look ${review} over, then trust the folder for good with \`orb trust\`, or for this run only with --trust. Starting \`orb\` there asks the same question.`
            : "That folder is a home directory or a filesystem root, which Orbit never trusts for good, so `orb trust` refuses it. Pass --trust to trust it for this run only, start `orb` there to trust it until Orbit restarts, or run from inside a project folder.",
        ]),
  ].join(EOL)
}

/**
 * What a refusal says when the server has no trust routes, because it is older than workspace trust: it cannot say whether
 * the folder is trusted, and the command is about to run what the folder brings in this process, so it stops. The text
 * names the file and what it brings as `refusal` does, and the ways to get an answer.
 */
export function unanswered(directory: string, imports?: string, defines?: Defined, strict?: boolean | "recorded") {
  return [
    ...lead(
      `Orbit stopped before doing any work: the server is older than workspace trust, so it cannot say whether ${directory} is trusted`,
      directory,
      imports,
      defines,
      imports !== undefined || defines !== undefined
        ? undefined
        : strict === "recorded"
          ? "recorded"
          : strict === true
            ? "prompt"
            : "folder",
    ),
    "",
    "Restart the server to get an answer, which for the background service is `orb service restart`. Or run on a current private server instead: --standalone starts one that checks the folder, and --trust starts one that trusts the folder for this run only.",
  ].join(EOL)
}

/**
 * What a refusal says when the folder that is not trusted is the one that holds the file the command loads, and not the
 * one the run happens in, which was. It names the file and what it brings as `refusal` does, but not the config of the
 * folder, which the run does not apply, and gives the command that trusts that folder, because a plain `orb trust` would
 * trust the folder of the run.
 */
export function holderRefusal(status: TrustStatus, imports?: string, defines?: Defined) {
  return [
    ...lead(
      `Orbit stopped before doing any work: ${plain(status.directory)} is not trusted`,
      status.directory,
      imports,
      defines,
    ),
    "",
    `The file is in another project than the one the command runs in, and each project is trusted on its own. ${
      status.persistent
        ? `Look the file over, then trust its folder for good ${
            quoted(status.directory) === undefined
              ? "by typing `orb trust` and the folder (its name is not printed as a command because a shell could act on it)"
              : `with \`orb trust ${quoted(status.directory)}\``
          }, or for this run only with --trust.`
        : "Its folder is a home directory or a filesystem root, which Orbit never trusts for good, so `orb trust` refuses it. Pass --trust to trust it for this run only, or keep the file in a project folder."
    }`,
  ].join(EOL)
}

/** The files and directories that hold something back and what each holds, one line apiece in two columns. */
export function heldLines(directory: string, items: ReadonlyArray<Withheld>) {
  const named = held(directory, items)
  const width = Math.max(...named.map((item) => item.name.length))
  return named.map((item) => `  ${item.name.padEnd(width)}  ${item.kinds}`)
}

/** A folder as a shell takes it as one argument, or undefined when it cannot be quoted so that no shell expands it. */
export const quoted = (folder: string) => shellArgument(folder)

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

// A folder that cannot be opened, or a server that does not answer, would otherwise surface as a bare status code.
const unchecked = (directory: string) => (cause: unknown) =>
  new Error(`Could not check whether ${directory} is trusted: ${errorMessage(cause)}`, { cause })

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
// names), the run store that a command goes on from (`recorded`), the model that a strict command sends the folder to
// (`prompt`), the folder itself when the command would only start work there (`folder`), or else the config it finds.
// `heading` is what comes before: why the folder is not enough as it stands.
function lead(
  heading: string,
  directory: string,
  imports: string | undefined,
  defines: Defined | undefined,
  reason?: "prompt" | "recorded" | "folder",
) {
  if (imports !== undefined)
    return [
      `${heading}, and this command runs code from the folder: it imports ${plain(fromFolder(directory, imports))}, and importing a TypeScript or JavaScript file runs the code in it.`,
    ]
  if (reason === "recorded")
    return [
      `${heading}, and this command goes on from a run that the folder's run store (.orbit/runs.db) records. A clone can ship that file with any run in it, and a resumed run picks up the folders, sessions and models it records, so the command does not open the store until the folder is trusted.`,
    ]
  if (reason === "folder")
    return [
      `${heading}. Nothing a folder holds is read, and no work starts there, until the folder is trusted: its instructions and files steer the model, and its config can name programs to run.`,
    ]
  if (reason === "prompt")
    return [
      `${heading}. This command sends the folder's instructions to a model and runs the tool calls that come back, which the default rules allow without asking, so the folder has to be trusted first.`,
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
    ...(defines.models.length === 0
      ? []
      : [
          {
            says: `lets the file choose which of your models run its nodes, and how many attempts they get: ${file} sets a \`model\`, fallback models or a limit on attempts for each entry below, where your own \`--model\` would otherwise decide, so the file can spend on a model you did not pick:`,
            rows: defines.models.map((item) => [item.id, item.choice] as const),
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

/** Whether the folder is held to a trust it lacks: it is not trusted, whatever it holds. */
const blocked = (status: TrustStatus) => !status.trusted
