import { Service } from "@orbit/client/effect/service"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { plain } from "@orbit/util/plain"
import { Deferred, Effect, Exit, Fiber, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { randomBytes } from "node:crypto"
import { selfCommand } from "../util/process"

const Ready = Schema.Struct({ url: Schema.String })
const decodeReady = Schema.decodeUnknownPromise(Schema.fromJsonString(Ready))

type Options = {
  readonly command?: ReadonlyArray<string>
}

const startupDirectory = process.cwd()

function command(password: string, options: Options) {
  const [executable, ...args] = options.command ?? [...selfCommand(), "serve"]
  if (!executable) throw new Error("Failed to resolve standalone server command")
  return ChildProcess.make(executable, [...args, "--stdio", "--port", "0"], {
    cwd: startupDirectory,
    // Explicit entry wins over anything inherited, so a user-exported
    // ORBIT_PASSWORD cannot shadow the child's lease credential.
    env: { ORBIT_PASSWORD: password },
    extendEnv: true,
    // The server treats EOF on this pipe as the end of its ownership lease.
    // The OS closes it even when the TUI is killed before Effect finalizers run.
    stdin: "pipe",
    stderr: process.env.ORBIT_PRINT_LOGS === "1" ? "inherit" : "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "3 seconds",
  })
}

const makeEndpoint = Effect.fn("cli.standalone.endpoint")(
  function* (options: Options) {
    const password = randomBytes(32).toString("base64url")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const proc = yield* spawner.spawn(command(password, options))
    const readyLine = yield* Deferred.make<string, Error>()
    // The end of what the server wrote to stderr, for the error when it exits before it is ready. Drained for the whole
    // run, so a server that writes much cannot fill the pipe and stall.
    const stderr = { tail: "" }
    const drained = yield* proc.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) => Effect.sync(() => (stderr.tail = (stderr.tail + text).slice(-STDERR_TAIL)))),
      Effect.ignore,
      Effect.forkScoped,
    )
    // Keep draining stdout after readiness so later server writes cannot hit EPIPE.
    yield* proc.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Deferred.succeed(readyLine, line)),
      // A server whose output ended by itself is asked why. The end of the command interrupts this first and stops the
      // server only after it, so a server stopped that way is not asked: it is still running, and waiting for its exit
      // there would hold the end of the command for the whole wait.
      Effect.onExit((exit) =>
        Exit.hasInterrupts(exit)
          ? Deferred.fail(readyLine, new Error(notReady(Option.none(), "")))
          : Effect.gen(function* () {
              const code = yield* proc.exitCode.pipe(Effect.timeoutOption("5 seconds"), Effect.option)
              yield* Fiber.join(drained).pipe(Effect.timeoutOption("1 second"))
              yield* Deferred.fail(readyLine, new Error(notReady(Option.flatten(code), stderr.tail)))
            }),
      ),
      Effect.forkScoped,
    )
    const output = yield* Deferred.await(readyLine)
    const ready = yield* Effect.tryPromise(() => decodeReady(output))
    return {
      url: ready.url,
      auth: { type: "basic" as const, username: "orbit", password },
      pid: proc.pid,
      exited: proc.exitCode,
    }
  },
  Effect.provide(LayerNode.compile(CrossSpawnSpawner.node)),
)

export function start(options: Options = {}) {
  return makeEndpoint(options)
}

const STDERR_TAIL = 2_000

// The server's own output, but it can quote a config file or a path, so it is escaped before it reaches the terminal.
function notReady(code: Option.Option<number>, stderr: string) {
  const exit = Option.match(code, { onNone: () => "", onSome: (code) => ` with code ${code}` })
  const output = plain(stderr)
  return `Standalone server exited${exit} before reporting readiness${output ? `: ${output}` : ""}`
}

export * as Standalone from "./standalone"
