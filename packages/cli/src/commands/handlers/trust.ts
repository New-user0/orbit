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
import { aboveAdvice, call, heldLines, quoted, unsupported } from "../../util/trust"
import { directory } from "./flow/execute"

export default Runtime.handler(
  Commands.commands.trust,
  Effect.fn("cli.trust")(function* (input) {
    if (input.list && (input.revoke || Option.isSome(input.directory) || Option.isSome(input.for)))
      return yield* Effect.fail(new Error("--list takes no folder and cannot be combined with --revoke or --for"))
    if (input.revoke && Option.isSome(input.for))
      return yield* Effect.fail(new Error("--for names the location a folder is trusted through, so it cannot be combined with --revoke"))
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
    // The folder named, and the location it is trusted through: its own, unless --for names the location of a project
    // that the folder is above.
    const named = path.resolve(directory(), expand(Option.getOrUndefined(input.directory) ?? ".", global.home))
    const location = {
      directory: Option.isSome(input.for) ? path.resolve(directory(), expand(input.for.value, global.home)) : named,
    }
    const holder = Option.isSome(input.for) ? named : undefined
    // A folder on this machine is checked here, where a typo gets a plain answer rather than a server error. The
    // folders of a server given with --server are its own.
    const folders = [location.directory, ...(holder === undefined ? [] : [holder])]
    const missing =
      Option.isNone(input.server) ? yield* Effect.promise(() => firstMissing(folders)) : undefined
    // A stored grant is ended by name, which the server matches without looking at the disk: a folder that was deleted can
    // still be revoked, and so can a folder trusted as the holder of config above a project (--for), where opening a
    // location for it would end the grant of the project it belongs to instead. A folder that is the project of its own
    // location is ended through the location, as it always was.
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
          : `Stopped trusting ${ended.join(", ")}.`,
      ])
    }
    if (missing !== undefined) {
      process.exitCode = 1
      return yield* print([`Not a folder: ${missing}`], process.stderr)
    }
    if (input.revoke) {
      const status = yield* ask((signal) => client.location.trust.update({ location, trust: false }, { signal }))
      return yield* print([
        status.trusted
          ? `${plain(status.directory)} is still trusted: this server trusts every folder except a home directory and a filesystem root.`
          : `${plain(status.directory)} is not trusted.`,
      ])
    }

    // Asked before anything is granted: a grant for a home directory or a filesystem root is made in memory and would
    // last only until the server restarts, which is not what this command promises.
    const before = yield* ask((signal) => client.location.trust.get({ location }, { signal }))
    // A folder above the project is trusted through a location that holds config back for it, and for no other.
    const held = holder === undefined ? undefined : before.withheld.find((item) => sameFolder(item.directory, holder))
    if (holder !== undefined && held === undefined && !sameFolder(before.directory, holder)) {
      process.exitCode = 1
      return yield* print(
        [
          `${plain(holder)} holds no config back for ${plain(location.directory)}, so there is nothing to trust it for there. \`orb trust\` without --for trusts the folder itself.`,
        ],
        process.stderr,
      )
    }
    if (held !== undefined && held.persistent === false) {
      process.exitCode = 1
      return yield* print(
        [
          `${plain(holder ?? "")} is a home directory or a filesystem root, and Orbit never trusts those for good: that would trust every folder below it.`,
          "To work with it, choose to trust it until Orbit restarts in the terminal UI, or pass --trust to `orb run`, `orb loop`, `orb flow` or `orb eval` for a single run.",
        ],
        process.stderr,
      )
    }
    if (holder === undefined && !before.persistent) {
      process.exitCode = 1
      return yield* print(
        [
          `${before.directory} is a home directory or a filesystem root, and Orbit never trusts those for good: that would trust every folder below it.`,
          "To work there, choose to trust it until Orbit restarts in the terminal UI, or pass --trust to `orb run`, `orb loop`, `orb flow` or `orb eval` for a single run.",
        ],
        process.stderr,
      )
    }
    // A folder that is trusted already is trusted again when what it holds changed since, and says what that lifted.
    const saved = holder === undefined && before.source === "saved" && (before.changed ?? []).length === 0
    const status = saved
      ? before
      : yield* ask((signal) =>
          client.location.trust.update({ location, trust: true, ...(holder === undefined ? {} : { holder }) }, { signal }),
        )
    // Only what the grant lifted is applied now. A file in a folder above the project is decided by its own folder's
    // trust, so it is still held back, and the person is told which folder would lift it.
    const applied = before.withheld.filter((item) => !status.withheld.some((left) => left.path === item.path))
    return yield* print([
      saved
        ? `${plain(status.directory)} is already trusted.`
        : `Trusted ${plain(holder ?? status.directory)}${(before.changed ?? []).length > 0 ? " again" : ""}`,
      ...(applied.length === 0
        ? []
        : ["Orbit now applies the project config it was holding back:", ...heldLines(status.directory, applied)]),
      ...(status.withheld.length === 0
        ? []
        : [
            "Still held back, because it sits in a folder above the project and each folder is trusted on its own:",
            ...heldLines(status.directory, status.withheld),
            `Look it over, then ${aboveAdvice(status.withheld, location.directory)}.`,
          ]),
      ...(saved ? [] : revokeAdvice(holder ?? status.directory)),
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

// The first of these that is not a folder on this machine.
const firstMissing = async (targets: ReadonlyArray<string>) => {
  for (const target of targets) if (!(await isFolder(target))) return target
}

// Whether two names are one folder, folding case where the file system does.
const sameFolder = (a: string | undefined, b: string) =>
  a !== undefined &&
  (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b))
