import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Global } from "@orbit/util/global"
import { Effect, Option } from "effect"
import { stat } from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { call, heldLines, unsupported } from "../../util/trust"
import { directory } from "./flow/execute"

export default Runtime.handler(
  Commands.commands.trust,
  Effect.fn("cli.trust")(function* (input) {
    if (input.list && (input.revoke || Option.isSome(input.directory)))
      return yield* Effect.fail(new Error("--list takes no folder and cannot be combined with --revoke"))
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })

    if (input.list) {
      const grants = yield* ask((signal) => client.location.trust.list({ signal }))
      return yield* print(
        grants.length === 0
          ? ["No folder is trusted for good."]
          : grants.map((grant) => `${grant.directory}  ${new Date(grant.time).toISOString()}`),
      )
    }

    const global = yield* Global.Service
    const location = {
      directory: path.resolve(directory(), expand(Option.getOrUndefined(input.directory) ?? ".", global.home)),
    }
    if (input.revoke) {
      const status = yield* ask((signal) => client.location.trust.update({ location, trust: false }, { signal }))
      return yield* print([
        status.trusted
          ? `${status.directory} is still trusted: this server trusts every folder except a home directory and a filesystem root.`
          : `${status.directory} is not trusted.`,
      ])
    }

    // A folder on this machine is checked here, where a typo gets a plain answer rather than a server error. The
    // folders of a server given with --server are its own.
    if (Option.isNone(input.server) && !(yield* Effect.promise(() => isFolder(location.directory)))) {
      process.exitCode = 1
      return yield* print([`Not a folder: ${location.directory}`], process.stderr)
    }
    // Asked before anything is granted: a grant for a home directory or a filesystem root is made in memory and would
    // last only until the server restarts, which is not what this command promises.
    const before = yield* ask((signal) => client.location.trust.get({ location }, { signal }))
    if (!before.persistent) {
      process.exitCode = 1
      return yield* print(
        [
          `${before.directory} is a home directory or a filesystem root, and Orbit never trusts those for good: that would trust every folder below it.`,
          "To work there, choose to trust it until Orbit restarts in the terminal UI, or pass --trust to `orb run`, `orb loop`, `orb flow` or `orb eval` for a single run.",
        ],
        process.stderr,
      )
    }
    if (before.source === "saved") return yield* print([`${before.directory} is already trusted.`])
    const status = yield* ask((signal) => client.location.trust.update({ location, trust: true }, { signal }))
    return yield* print([
      `Trusted ${status.directory}`,
      ...(before.withheld.length === 0
        ? []
        : ["Orbit now applies the project config it was holding back:", ...heldLines(before)]),
      `Stop trusting it with: orb trust --revoke ${status.directory}`,
    ])
  }),
)

// A server older than workspace trust has no trust routes, and that is worth saying plainly.
const ask = <A>(request: (signal: AbortSignal) => Promise<A>) =>
  call(request).pipe(
    Effect.catchIf(unsupported, () =>
      Effect.fail(
        new Error(
          "This server is older than workspace trust, so it cannot trust a folder. Restart it; for the background service that is `orb service restart`.",
        ),
      ),
    ),
  )

const print = (lines: ReadonlyArray<string>, stream: NodeJS.WriteStream = process.stdout) =>
  Effect.sync(() => void stream.write(lines.join(EOL) + EOL))

// A Unix shell expands a leading ~ before orb sees it. PowerShell and cmd hand it over as typed.
const expand = (folder: string, home: string) =>
  folder === "~" || /^~[\\/]/.test(folder) ? path.join(home, folder.slice(1)) : folder

const isFolder = (target: string) =>
  stat(target).then(
    (info) => info.isDirectory(),
    () => false,
  )
