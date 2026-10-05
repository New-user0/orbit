import { ClientError, type OrbitClient, type TrustStatus } from "@orbit/client/promise"
import { Effect } from "effect"
import { EOL } from "node:os"
import path from "node:path"

/**
 * Stops the command, before it does any work, when its folder is untrusted and its project config holds something
 * back: a run that quietly went without the project's hooks, MCP servers and plugins would not be the run it asked for.
 * A folder that holds nothing back runs whether or not it is trusted. With `grant` (the `--trust` flag) an untrusted
 * folder is first trusted for as long as the serving process lives, which callers make a private one that ends with
 * the run. A server older than workspace trust has no such route and holds nothing back, so it asks nothing.
 */
export const requireTrust = Effect.fn("cli.trust.require")(function* (
  client: OrbitClient,
  directory: string,
  options: { readonly grant?: boolean } = {},
) {
  const location = { directory }
  const current = yield* call((signal) => client.location.trust.get({ location }, { signal })).pipe(
    Effect.catchIf(unsupported, () => Effect.succeed(undefined)),
  )
  if (current === undefined) return
  const status = options.grant && !current.trusted ? yield* grant(client, location) : current
  if (!blocked(status)) return
  yield* Effect.sync(() => {
    process.stderr.write(refusal(status) + EOL)
    process.exit(1)
  })
})

/** For a command that cannot stop, such as `orb acp` whose stdout belongs to the protocol: says on stderr what is held back. */
export const warnUntrusted = Effect.fn("cli.trust.warn")(function* (client: OrbitClient, directory: string) {
  const status = yield* call((signal) => client.location.trust.get({ location: { directory } }, { signal }))
  if (!blocked(status)) return
  const items = held(status).map((item) => `${item.name}: ${item.kinds}`)
  const advice = status.persistent ? "Trust it with `orb trust`." : "Orbit never trusts that folder for good."
  process.stderr.write(
    `orb acp: ${status.directory} is not trusted, so its project config is held back (${items.join("; ")}). ${advice}${EOL}`,
  )
})

export function refusal(status: TrustStatus) {
  return [
    `Orbit stopped before doing any work: ${status.directory} is not trusted, so its project config holds back what could run code or reach the network:`,
    "",
    ...heldLines(status),
    "",
    status.persistent
      ? "Look those files over, then trust the folder for good with `orb trust`, or for this run only with --trust."
      : "That folder is a home directory or a filesystem root, which Orbit never trusts for good, so `orb trust` refuses it. Pass --trust to trust it for this run only, or run from inside a project folder.",
  ].join(EOL)
}

/** The files and directories that hold something back and what each holds, one line apiece in two columns. */
export function heldLines(status: TrustStatus) {
  const items = held(status)
  const width = Math.max(...items.map((item) => item.name.length))
  return items.map((item) => `  ${item.name.padEnd(width)}  ${item.kinds}`)
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

// Named from the project's folder when it lies inside it.
function held(status: TrustStatus) {
  return status.withheld.map((item) => {
    const relative = path.relative(status.directory, item.path)
    const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
    return { name: inside ? relative : item.path, kinds: item.kinds.join(", ") }
  })
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

/** Whether the folder is held to a trust it lacks: untrusted, with something held back that a grant would let through. */
const blocked = (status: TrustStatus) => !status.trusted && status.withheld.length > 0
