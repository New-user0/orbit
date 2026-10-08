import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { run } from "@orbit/tui"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Config } from "../../config"
import { Context, Effect, FileSystem, Option, Queue } from "effect"
import { ServerConnection } from "../../services/server-connection"
import { Npm } from "@orbit/util/npm"
import { ORBIT_ARTIFACT, ORBIT_CHANNEL, ORBIT_VERSION } from "../../version"
import { Env } from "../../env"
import { Service } from "@orbit/client/effect/service"
import { Orbit } from "@orbit/client/promise"
import { findSession } from "../../session-target"
import { errorMessage } from "../../util/error"

export default Runtime.handler(Commands, (input) =>
  Effect.gen(function* () {
    // The flags of a printed run mean nothing to the interface, so say so instead of dropping them.
    const printOnly = [
      ["--output-format", Option.isSome(input.outputFormat)],
      ["--json-schema", Option.isSome(input.jsonSchema)],
      ["--file", input.file.length > 0],
      ["--title", Option.isSome(input.title)],
      ["--bare", input.bare],
      ["--thinking", input.thinking],
    ].flatMap(([flag, given]) => (given ? [flag] : []))
    if (printOnly.length > 0)
      return yield* Effect.fail(new Error(`${printOnly.join(", ")} can only be used with -p, as in: orb -p <message>`))
    const resume = Option.getOrUndefined(input.resume)
    if (resume !== undefined && (input.continue || Option.isSome(input.session)))
      return yield* Effect.fail(new Error("--resume cannot be combined with --continue or --session"))
    if (input.fork && !input.continue && Option.isNone(input.session) && resume === undefined)
      return yield* Effect.fail(new Error("--fork requires --continue, --session or --resume"))
    const requestedDirectory =Option.getOrUndefined(input.directory)
    const requestedServer = Option.getOrUndefined(input.server)
    if (requestedDirectory !== undefined) process.chdir(requestedDirectory)
    const serviceStarts = yield* Queue.unbounded<{
      readonly reason: "missing" | "version-mismatch"
      readonly previousVersion?: string
    }>()
    yield* Queue.take(serviceStarts).pipe(
      Effect.flatMap((event) => Effect.logInfo("background service starting", event)),
      Effect.forever,
      Effect.forkScoped,
    )
    const server = yield* ServerConnection.resolve({
      server: requestedServer,
      standalone: input.standalone,
      mismatch: "replace",
      onStart: (reason, previousVersion) => {
        Queue.offerUnsafe(serviceStarts, { reason, previousVersion })
        process.stderr.write(
          reason === "version-mismatch"
            ? "Restarting background server (version mismatch)...\n"
            : "Starting background server...\n",
        )
      },
    })
    // A --resume value that is the ID of a session opens it, as --session does; anything else, including nothing, opens
    // the session list with the value typed into its search.
    const resumeID = resume !== undefined && /^ses\S*$/.test(resume) ? resume : undefined
    const session = Option.getOrUndefined(input.session) ?? resumeID
    // A missing --session ID becomes the ID of the session the first prompt creates.
    const sessionExists =
      session !== undefined &&
      (yield* Effect.tryPromise({
        try: () =>
          findSession(Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) }), session),
        catch: (cause) => new Error(errorMessage(cause)),
      })) !== undefined
    const resumePicks = resume !== undefined && !(resumeID !== undefined && sessionExists)
    if (resumePicks && input.fork)
      return yield* Effect.fail(new Error("--fork with --resume needs the ID of an existing session"))
    const config =yield* Config.Service
    const npm = yield* Npm.Service
    const fileSystem = yield* FileSystem.FileSystem
    const runServicePromise = Effect.runPromiseWith(Context.make(FileSystem.FileSystem, fileSystem))
    const context = yield* Effect.context<FileSystem.FileSystem>()
    const runFork = Effect.runForkWith(context)
    const runPromise = Effect.runPromiseWith(context)
    const service = server.service
    yield* run({
      app: {
        name: process.env.ORBIT_CLIENT ?? ORBIT_ARTIFACT,
        version: ORBIT_VERSION,
        channel: process.env.ORBIT_TUI_CHANNEL ?? ORBIT_CHANNEL,
      },
      server: {
        endpoint: server.endpoint,
        service: service
          ? {
              reconnect: (signal) => runServicePromise(service.reconnect(), { signal }),
              restart: () => runServicePromise(service.restart()),
            }
          : undefined,
      },
      args: {
        continue: input.continue,
        sessionID: sessionExists ? session : undefined,
        newSessionID: sessionExists ? undefined : Option.getOrUndefined(input.session),
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        fork: input.fork,
        resume: resumePicks ? resume : undefined,
        prompt: Option.getOrUndefined(input.prompt),
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      },
      config: {
        path: config.path,
        get: () => runPromise(config.get()),
        update: (update) => runPromise(config.update(update)),
      },
      packages: {
        prepare: (spec, install = true) => runPromise(install ? npm.add(spec) : npm.resolve(spec)),
      },
      environment: requestedServer === undefined ? Env.session() : undefined,
      log: (level, message, tags) => {
        const effect =
          level === "debug"
            ? Effect.logDebug(message, tags)
            : level === "warn"
              ? Effect.logWarning(message, tags)
              : level === "error"
                ? Effect.logError(message, tags)
                : Effect.logInfo(message, tags)
        runFork(effect)
      },
    }).pipe(Effect.provide(LayerNode.compile(Global.node)))
  }),
)
