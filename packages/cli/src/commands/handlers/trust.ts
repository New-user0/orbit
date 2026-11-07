import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { plain } from "@orbit/flow/plain"
import { Global } from "@orbit/util/global"
import { Effect, Option } from "effect"
import { stat } from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { call, heldLines, quoted, unsupported } from "../../util/trust"
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
          : grants.map((grant) => `${plain(grant.directory)}  ${new Date(grant.time).toISOString()}`),
      )
    }

    const global = yield* Global.Service
    // The folder named, which is trusted through a location of its own.
    const location = {
      directory: path.resolve(directory(), expand(Option.getOrUndefined(input.directory) ?? ".", global.home)),
    }
    // A folder on this machine is checked here, where a typo gets a plain answer rather than a server error. The
    // folders of a server given with --server are its own.
    const missing =
      Option.isNone(input.server) && !(yield* Effect.promise(() => isFolder(location.directory)))
        ? location.directory
        : undefined
    // A stored grant is ended by name, which the server matches without looking at the disk: a folder that was deleted can
    // still be revoked, and so can a grant stored for a folder that is not the project of its own location (one that an
    // older `orb trust --for` made), where opening a location for it would end the grant of the project it belongs to
    // instead. A folder that is the project of its own location is ended through the location, as it always was.
    const holderGrant =
      input.revoke && missing === undefined
        ? (yield* ask((signal) => client.location.trust.list({ signal }))).some((grant) =>
            sameFolder(grant.directory, location.directory),
          ) &&
          !sameFolder((yield* ask((signal) => client.location.trust.get({ location }, { signal }))).directory, location.directory)
        : false
    if (input.revoke && (missing !== undefined || holderGrant)) {
      const ended = yield* ask((signal) => client.location.trust.revoke({ directory: location.directory }, { signal }))
      return yield* print([
        ended.length === 0
          ? `${plain(location.directory)} is not trusted.`
          : `Stopped trusting ${ended.map(plain).join(", ")}.`,
      ])
    }
    if (missing !== undefined) {
      process.exitCode = 1
      return yield* print([`Not a folder: ${plain(missing)}`], process.stderr)
    }
    if (input.revoke) {
      const status = yield* ask((signal) => client.location.trust.update({ location, trust: false }, { signal }))
      if (!status.trusted) return yield* print([`${plain(status.directory)} is not trusted.`])
      // A grant for a folder above still covers this one, and only revoking that grant ends it (class 3).
      if (status.granted !== undefined) {
        const argument = quoted(status.granted)
        return yield* print([
          `${plain(status.directory)} is still trusted, because ${plain(status.granted)} is trusted and that covers the folders inside it.`,
          argument === undefined
            ? "End that grant with `orb trust --revoke <folder>`; the folder's name is not printed as a command because a shell could act on it."
            : `End that grant with: orb trust --revoke ${argument}`,
        ])
      }
      return yield* print([
        `${plain(status.directory)} is still trusted: this server trusts every folder except a home directory and a filesystem root.`,
      ])
    }

    // Asked before anything is granted: a grant for a home directory or a filesystem root is made in memory and would
    // last only until the server restarts, which is not what this command promises.
    const before = yield* ask((signal) => client.location.trust.get({ location }, { signal }))
    if (!before.persistent) {
      process.exitCode = 1
      return yield* print(
        [
          `${plain(before.directory)} is a home directory or a filesystem root, and Orbit never trusts those for good: that would trust every folder below it.`,
          "To work there, choose to trust it until Orbit restarts in the terminal UI, or pass --trust to `orb run`, `orb loop`, `orb flow` or `orb eval` for a single run.",
        ],
        process.stderr,
      )
    }
    // A folder with a saved grant of its own is trusted as it stands, whatever its config holds now (D8). One that only a
    // grant for a folder above covers gets a grant of its own, so it stays trusted when that grant ends.
    const saved = before.source === "saved" && before.granted === undefined
    const status = saved ? before : yield* ask((signal) => client.location.trust.update({ location, trust: true }, { signal }))
    // Only what the grant lifted is applied now.
    const applied = before.withheld.filter((item) => !status.withheld.some((left) => left.path === item.path))
    return yield* print([
      saved ? `${plain(status.directory)} is already trusted.` : `Trusted ${plain(status.directory)}`,
      ...(applied.length === 0
        ? []
        : ["Orbit now applies the project config it was holding back:", ...heldLines(status.directory, applied)]),
      ...(saved ? [] : revokeAdvice(status.directory)),
    ])
  }),
)

// How to end the grant just made, with the folder that was granted named exactly. A name that no quoting makes safe
// to paste gets no command.
const revokeAdvice = (folder: string) => {
  const argument = quoted(folder)
  return [
    argument === undefined
      ? `Stop trusting ${plain(folder)} with \`orb trust --revoke <folder>\`; its name is not printed as a command because a shell could act on it.`
      : `Stop trusting it with: orb trust --revoke ${argument}`,
  ]
}

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

// Whether two names are one folder, folding case where the file system does.
const sameFolder = (a: string | undefined, b: string) =>
  a !== undefined &&
  (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))
