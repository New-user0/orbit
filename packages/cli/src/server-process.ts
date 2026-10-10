export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service, type DiscoverOptions } from "@orbit/client/effect/service"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { ORBIT_ARTIFACT, ORBIT_CHANNEL, ORBIT_VERSION } from "./version"
import { AppProcess } from "@orbit/util/process"
import { randomBytes, randomUUID } from "node:crypto"
import { Effect, Option, Redacted, Schedule, Schema } from "effect"
import { PersistentPty } from "@orbit/schema/persistent-pty"
import { HttpServer } from "effect/unstable/http"
import { Env } from "./env"
import { ServiceConfig } from "./services/service-config"
import { RetainedImage } from "./services/retained-image"
import { ServiceRegistration } from "./services/service-registration"
import { databasePath } from "./database-path"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly cors?: readonly string[]
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* processEffect(options).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
        replacements: [
          Global.node.replace(
            Global.layerWith(process.env.ORBIT_CONFIG_DIR ? { config: process.env.ORBIT_CONFIG_DIR } : {}),
          ),
        ],
      }),
    ),
    Effect.provide(NodeServices.layer),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  const inherited = process.env.ORBIT_PTY_HANDOFF
  delete process.env.ORBIT_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.mapError(() => new Error("Invalid PTY restart handoff")),
        )
  const global = yield* Global.Service
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(global.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const foreground = options.mode === "default"
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const incumbent =
        serviceOptions !== undefined && port !== undefined
          ? yield* Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (incumbent !== undefined) return
      // Keep a package-manager or curl install replaceable while the service runs; Desktop updates its own copy.
      if (options.mode === "service" && process.platform === "win32" && RetainedImage.installed(global.home))
        yield* RetainedImage.retain(global.cache, "service")
      const { start } = yield* Effect.promise(() => import("@orbit/server/process"))
      const environmentPassword = yield* Env.password
      // Keep the lease credential out of the environment inherited by tools.
      if (options.mode === "stdio") {
        delete process.env.ORBIT_PASSWORD
        delete process.env.ORBIT_SERVER_PASSWORD
      }
      const password =
        options.mode === "service"
          ? config.password || randomBytes(32).toString("base64url")
          : environmentPassword
            ? Redacted.value(environmentPassword)
            : randomBytes(32).toString("base64url")
      if (!password) return yield* Effect.fail(new Error("Missing server password"))
      const instanceID = randomUUID()
      // The CLI hands a private server its run-scoped config as a file, because the environment is size limited; the
      // file wins over ORBIT_CONFIG_CONTENT, which the CLI has already merged into it. The shared service never reads
      // one: a variable that happened to be set when it started must not shape every client's config.
      const overlay = yield* Effect.tryPromise({
        try: () => takeOverlay(options.mode, process.env),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      const server = yield* start(
        {
          app: {
            name: process.env.ORBIT_CLIENT ?? ORBIT_ARTIFACT,
            version: ORBIT_VERSION,
            channel: ORBIT_CHANNEL,
          },
          hostname,
          port,
          cors: options.cors ?? config.cors,
          password,
          pty: { handoff },
          simulation: truthy(process.env.ORBIT_SIMULATE),
          database: {
            path: databasePath(global.data),
          },
          models: {
            url: process.env.ORBIT_MODELS_URL,
            file: process.env.ORBIT_MODELS_PATH,
            fetch: !truthy(process.env.ORBIT_DISABLE_MODELS_FETCH),
          },
          config: {
            directory: process.env.ORBIT_CONFIG_DIR,
            project: !truthy(process.env.ORBIT_CONFIG_PROJECT_DISABLE ?? process.env.ORBIT_DISABLE_PROJECT_CONFIG),
            file: process.env.ORBIT_CONFIG,
            content: overlay ?? process.env.ORBIT_CONFIG_CONTENT,
          },
          trust: trustOptions(options.mode, process.env),
          windows: {
            gitbash: process.env.ORBIT_GIT_BASH_PATH,
          },
          fs: {
            filewatcher: !truthy(process.env.ORBIT_FILEWATCHER_DISABLE ?? process.env.ORBIT_DISABLE_FILEWATCHER),
            fff:
              process.env.ORBIT_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.ORBIT_DISABLE_FFF),
          },
        },
        serviceOptions === undefined
          ? undefined
          : {
              onListen: (address, shutdown) =>
                Effect.gen(function* () {
                  if (!config.password) yield* ServiceConfig.password(password)
                  return yield* ServiceRegistration.register({
                    address,
                    password,
                    id: instanceID,
                    file: serviceOptions.file,
                    shutdown,
                  })
                }),
            },
      ).pipe(
        Effect.catch((error) => {
          if (serviceOptions === undefined || port === undefined || !addressInUse(error)) return Effect.fail(error)
          return recognizeIncumbent(serviceOptions, hostname, port).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.void
                : Effect.fail(
                    new Error(
                      `Managed service port ${port} on ${hostname} is already in use by another process. ` +
                        "Configure another port with `orb service set port <port>` and start the service again.",
                      { cause: error },
                    ),
                  ),
            ),
          )
        }),
      )
      if (server === undefined) return
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      if (foreground && !environmentPassword) console.log(`server password ${password}`)
      return yield* options.mode === "service"
        ? server.shutdown
        : options.mode === "stdio"
          ? waitForStdinClose()
          : Effect.never
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

const recognizeIncumbent = Effect.fnUntraced(function* (options: DiscoverOptions, hostname: string, port: number) {
  const found = yield* Service.incumbent({ ...options, url: serviceURL(hostname, port) }).pipe(
    Effect.filterOrFail((value) => value !== undefined),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeoutOption("15 seconds"),
  )
  return Option.isSome(found)
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

/**
 * Whether the server trusts the folders it is pointed at without a grant. A private or foreground server belongs to
 * whoever starts it, so `ORBIT_TRUST_PROJECT` can ask for that. The background service is shared by every client and
 * project, and a variable that happened to be set when the first client started it must not decide for all of them.
 */
export function trustOptions(mode: Mode, env: Readonly<Record<string, string | undefined>>) {
  return { implicit: mode === "service" ? false : truthy(env.ORBIT_TRUST_PROJECT) }
}

/**
 * The run-scoped config that the CLI left for this server in ORBIT_CONFIG_CONTENT_FILE, read once. The variable is
 * removed from `env` whatever happens, so nothing this server starts inherits it. The background service never reads
 * it, and a path that is not a file the CLI wrote is refused without being touched.
 */
export async function takeOverlay(mode: Mode, env: Record<string, string | undefined>) {
  const file = env.ORBIT_CONFIG_CONTENT_FILE
  delete env.ORBIT_CONFIG_CONTENT_FILE
  if (file === undefined || mode === "service") return undefined
  const { ConfigOverlay } = await import("./config-overlay")
  return ConfigOverlay.consume(file)
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}
