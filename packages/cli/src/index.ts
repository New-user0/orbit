#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { progress } from "@orbit/flow/plain"
import { Cause, Effect } from "effect"
import { getErrorReported } from "effect/Runtime"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { Observability } from "@orbit/util/observability"
import { ORBIT_ARTIFACT, ORBIT_CHANNEL, ORBIT_LOCAL, ORBIT_VERSION } from "./version"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { AppProcess } from "@orbit/util/process"
import { Config } from "./config"
import { Npm } from "@orbit/util/npm"
import { EffectFlock } from "@orbit/util/effect-flock"
import { Heap } from "./heap"
import { CpuProfile } from "./cpu-profile"
import { Network } from "@orbit/util/network"

// Custom CA bundles and client certificates apply to every request, so install them before anything connects.
Network.install()

if (process.env.ORBIT_SSH_ASKPASS_PORT) {
  const { askpass } = await import("./ssh-askpass")
  process.exit(await Effect.runPromise(askpass.pipe(Effect.provide(NodeServices.layer))))
}

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  acp: () => import("./commands/handlers/acp"),
  api: () => import("./commands/handlers/api"),
  auth: {
    list: () => import("./commands/handlers/auth/list"),
    login: () => import("./commands/handlers/auth/login"),
    logout: () => import("./commands/handlers/auth/logout"),
    export: () => import("./commands/handlers/auth/export"),
    import: () => import("./commands/handlers/auth/import"),
    switch: () => import("./commands/handlers/auth/switch"),
  },
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
    config: () => import("./commands/handlers/debug/config"),
    paths: () => import("./commands/handlers/debug/paths"),
  },
  mcp: {
    list: () => import("./commands/handlers/mcp/list"),
    add: () => import("./commands/handlers/mcp/add"),
    auth: () => import("./commands/handlers/mcp/auth"),
    logout: () => import("./commands/handlers/mcp/logout"),
  },
  plugin: {
    list: () => import("./commands/handlers/plugin/list"),
    add: () => import("./commands/handlers/plugin/add"),
    check: () => import("./commands/handlers/plugin/check"),
    update: () => import("./commands/handlers/plugin/update"),
    remove: () => import("./commands/handlers/plugin/remove"),
  },
  models: () => import("./commands/handlers/models"),
  doctor: () => import("./commands/handlers/doctor"),
  flow: {
    run: () => import("./commands/handlers/flow/run"),
    resume: () => import("./commands/handlers/flow/resume"),
    approve: () => import("./commands/handlers/flow/approve"),
    cost: () => import("./commands/handlers/flow/cost"),
    clean: () => import("./commands/handlers/flow/clean"),
    replay: () => import("./commands/handlers/flow/replay"),
    watch: () => import("./commands/handlers/flow/watch"),
    trace: () => import("./commands/handlers/flow/trace"),
    ls: () => import("./commands/handlers/flow/ls"),
    show: () => import("./commands/handlers/flow/show"),
  },
  eval: () => import("./commands/handlers/eval"),
  stats: () => import("./commands/handlers/stats"),
  mini: () => import("./commands/handlers/mini"),
  run: () => import("./commands/handlers/run"),
  loop: () => import("./commands/handlers/loop"),
  pair: () => import("./commands/handlers/pair"),
  reload: () => import("./commands/handlers/reload"),
  trust: () => import("./commands/handlers/trust"),
  session: {
    list: () => import("./commands/handlers/session/list"),
    delete: () => import("./commands/handlers/session/delete"),
    export: () => import("./commands/handlers/session/export"),
    import: () => import("./commands/handlers/session/import"),
  },
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    get: () => import("./commands/handlers/service/get"),
    set: () => import("./commands/handlers/service/set"),
    unset: () => import("./commands/handlers/service/unset"),
  },
  serve: () => import("./commands/handlers/serve"),
})

Effect.gen(function* () {
  yield* Heap.listen
  yield* CpuProfile.listen
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const uncaughtException = (cause: Error, origin: "uncaughtException" | "unhandledRejection") => {
    runFork(Effect.logError("uncaught exception", { cause, origin }))
  }
  const unhandledRejection = (cause: unknown) => {
    runFork(Effect.logError("unhandled rejection", { cause }))
  }
  process.on("uncaughtException", uncaughtException)
  process.on("unhandledRejection", unhandledRejection)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.off("uncaughtException", uncaughtException)
      process.off("unhandledRejection", unhandledRejection)
    }),
  )
  yield* Effect.logInfo("cli starting", {
    version: ORBIT_VERSION,
    channel: ORBIT_CHANNEL,
    local: ORBIT_LOCAL,
    args: process.argv.slice(2),
  })
  return yield* Runtime.run(Commands, Handlers, { version: ORBIT_VERSION })
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("cli process failed", {
      cause,
      args: process.argv.slice(2),
    }).pipe(Effect.andThen(Effect.failCause(cause))),
  ),
  Effect.annotateLogs({ role: "cli" }),
  Effect.provide(Config.layer),
  Effect.provide(
    LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node, EffectFlock.node]), {
      replacements: [
        Global.node.replace(
          Global.layerWith(process.env.ORBIT_CONFIG_DIR ? { config: process.env.ORBIT_CONFIG_DIR } : {}),
        ),
      ],
    }),
  ),
  Effect.provide(
    Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: process.env.ORBIT_CLIENT ?? ORBIT_ARTIFACT,
      version: ORBIT_VERSION,
      channel: ORBIT_CHANNEL,
    }),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
  // runMain's default reporter logs the fatal cause to stdout. Write it to stderr instead: the
  // desktop and `Service.ensure` only capture stderr from `serve --service`, so this is the only
  // channel through which a startup failure's reason reaches the user.
  Effect.tapCause((cause) =>
    Effect.sync(() => {
      if (Cause.hasInterruptsOnly(cause)) return
      if (!getErrorReported(Cause.squash(cause))) return
      // Any failure can name text from a file that a clone brings along, such as the node IDs of an invalid workflow or
      // the file a run store names. The line breaks of the message and its stack stay, and every other control or
      // format character is written out, so a failure cannot act on the terminal either.
      process.stderr.write(Cause.pretty(cause).split(/\r?\n/).map(progress).join("\n") + "\n")
    }),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
