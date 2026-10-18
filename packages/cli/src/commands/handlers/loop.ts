import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { SessionID } from "@orbit/schema/session-id"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { ConfigOverlay } from "../../config-overlay"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { bypassDecision, printBypassNotice } from "../../util/managed-bypass"
import { requireTrust } from "../../util/trust"
import { directory } from "./flow/execute"

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000 }

/** Parses "30s", "10m" or "1h" into milliseconds; undefined for anything else or under ten seconds. */
export function parseInterval(value: string) {
  const match = /^(\d+)(s|m|h)$/.exec(value.trim())
  if (!match) return undefined
  const ms = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
  return ms >= 10_000 ? ms : undefined
}

export default Runtime.handler(Commands.commands.loop, (input) =>
  Effect.gen(function* () {
    const interval = parseInterval(input.interval)
    if (interval === undefined)
      return yield* Effect.fail(
        new Error(`Invalid interval "${input.interval}": use a number with s, m or h, at least 10s`),
      )
    const { runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    // A --settings file or JSON reaches a private server, so it is read here, before anything starts.
    const overlay = yield* ConfigOverlay.apply({
      settings: input.settings,
      server: Option.getOrUndefined(input.server),
    })
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone || overlay,
      trust: input.trust,
    })
    yield* Effect.promise(() => ConfigOverlay.release())
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    // A private server shares the database with the background service, so a session the service is running is not
    // driven a second time.
    const named = Option.getOrUndefined(input.session)
    const target = overlay
      ? yield* ConfigOverlay.refuseActive({ client, session: named, continue: false, directory: directory() })
      : named
    // Once, before the first run: a refusal that came with every run would only repeat itself on each interval. The
    // folder is the one the runs happen in, which is the folder of the session when --session names one that exists.
    yield* requireTrust(client, directory(), { grant: input.trust, session: target })
    const bypass = yield* bypassDecision(
      client,
      directory(),
      input.auto || input.yolo || input.dangerouslySkipPermissions,
    )
    printBypassNotice(bypass.notice)
    // One session for the whole loop, so each run sees what the previous ones found.
    const session = target ?? SessionID.create()
    const times = Option.getOrUndefined(input.times)
    for (let run = 1; times === undefined || run <= times; run++) {
      process.stderr.write(`\nLoop run ${run}${times ? ` of ${times}` : ""} · session ${session}\n`)
      yield* Effect.promise(() =>
        runNonInteractive({
          server,
          message: [...input.message],
          session,
          model: Option.getOrUndefined(input.model),
          agent: Option.getOrUndefined(input.agent),
          format: "default",
          file: [],
          auto: bypass.auto,
        }),
      )
      if (times !== undefined && run >= times) break
      process.stderr.write(`Next run at ${new Date(Date.now() + interval).toLocaleTimeString()}\n`)
      yield* Effect.sleep(interval)
    }
  }),
)
