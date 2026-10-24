export * as Shell from "./shell.js"

import path from "path"
import { Context, Deferred, Duration, Effect, Exit, Fiber, Latch, Layer, Schema, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { produce } from "immer"
import { Shell } from "@orbit/schema/shell"
import { AppProcess } from "@orbit/util/process"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { makeGlobalNode, makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Bus } from "./bus.js"
import { Environment } from "./environment/index.js"
import { FileRetention } from "./file-retention.js"
import { Location } from "./location.js"
import { Global } from "@orbit/util/global"
import { ShellSelect } from "./shell/select.js"
import type { ShellCreateBefore } from "@orbit/plugin/effect/shell"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionEnvironment } from "./session/environment.js"
import { SessionSchema } from "./session/schema.js"
import { Config } from "./config.js"
import { ConfigEnv } from "./config/env.js"
import { ManagedNetwork } from "./managed-network.js"
import { ManagedPolicy } from "./managed-policy.js"
import { ToolOutput } from "./tool-output.js"
import { ShellResult } from "./shell/result.js"
import { ShellSandbox } from "./shell/sandbox.js"
import { tmpdir } from "node:os"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Shell.NotFoundError", {
  id: Shell.ID,
}) {}

// Keep recent exited processes observable in memory, including their file-backed output.
// The process-local cap complements the time-based sweep, which also cleans files left by restarts.
const EXITED_LIMIT = 25
export const RETENTION = Duration.days(7)
export const DIRECTORY = "shell"
/** How many bytes from the start of a command's output its result keeps, unless `tool_output.max_bytes` says otherwise. */
export const HEAD_BYTES = 30_000
/** The most bytes that `tool_output.max_bytes` can make a result keep. */
export const HEAD_CEILING = 150_000
/** The output size at which a command that left the foreground is killed. */
export const BACKGROUND_LIMIT = 5 * 1024 ** 3
/** How often the output size of a command that left the foreground is checked. */
export const WATCH_INTERVAL = Duration.seconds(5)

/** The number of bytes a result reads from the start of the output, from the `tool_output` setting. */
export const headLimit = (configured: { readonly max_bytes?: number } | undefined) =>
  Math.min(configured?.max_bytes ?? HEAD_BYTES, HEAD_CEILING)

// Re-exported so callers of the service can name its records without importing the schema module as well.
export const ID = Shell.ID
export const Status = Shell.Status
export type ID = Shell.ID
export type Info = Shell.Info
type CreateInput = Shell.CreateInput & {
  shell?: string
}

type Active = {
  // Immutable snapshot; lifecycle updates replace it via immer `produce`.
  info: Info
  file: string
  size: number
  // Resolves with the terminal Info once the command exits, times out, or is killed. A wait
  // started after termination resolves immediately from the already-completed deferred.
  done: Deferred.Deferred<Info, NotFoundError>
  timeoutFiber?: Fiber.Fiber<void>
  timeout?: (duration: number) => Effect.Effect<void>
  kill?: Effect.Effect<void>
  // A result read the whole file, so eviction may delete it; every other file stays for the sweep.
  whole: boolean
  watched: boolean
  // Killed by the size watchdog.
  capped: boolean
  // Killed because the run that started it ended, so nothing reports it.
  abandoned: boolean
}

/**
 * Location-owned non-interactive shell command process service.
 *
 * Each `create` spawns one shell command, captures combined stdout/stderr to a
 * file, and returns an ID. Clients poll `get` for status and `output` for
 * file-backed output by cursor. No session, message, or permission state lives
 * here; callers (e.g. `ShellTool`) own that association and store the shell ID.
 */
export interface Interface {
  readonly create: <E = never, R = never>(
    input: CreateInput,
    before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<Shell.Info, E | AppProcess.AppProcessError, R>
  // Currently running commands only; exited shells are retained for get/output but excluded here.
  readonly list: () => Effect.Effect<Shell.Info[]>
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with
  // NotFoundError if the command is unknown or is removed before it terminates.
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // A known shell's terminal state and the head of its output. Missing capture remains distinct from its exit status.
  readonly result: (started: Shell.Info) => Effect.Effect<ShellResult.Result>
  // Says the command left the foreground: from then on it is killed once its output passes the background limit.
  readonly background: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
  // Kills every running command started for this session and marks it abandoned. Returns their IDs.
  readonly abandon: (sessionID: string) => Effect.Effect<Shell.ID[]>
  // Hands a finished command's output file to the step that settles the result of this call, as its saved copy.
  readonly offer: (input: {
    readonly id: Shell.ID
    readonly sessionID: string
    readonly messageID: string
    readonly callID: string
  }) => Effect.Effect<void, NotFoundError>
  // Replaces the running command's timeout from now; zero clears it.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
  // Stops a running command and keeps its output; a command that already finished is returned unchanged.
  readonly kill: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Shell") {}

export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = path.join(global.data, DIRECTORY)
  const projects = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "directory")),
    Effect.orElseSucceed(() => []),
  )
  const files = yield* Effect.forEach(
    projects,
    (project) =>
      fs.readDirectoryEntries(path.join(directory, project.name)).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.type === "file" && /^sh_[0-9a-f]{12}.*\.out$/.test(entry.name)
              ? [path.join(directory, project.name, entry.name)]
              : [],
          ),
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  )
  yield* FileRetention.cleanup(fs, files.flat(), RETENTION)
})

const cleanupLayer = Layer.effectDiscard(
  cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped),
)

const cleanupNode = makeGlobalNode({
  name: "shell-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

type Options = {
  /** The output size, in bytes, past which a command that left the foreground is killed. */
  readonly backgroundLimit?: number
  /** How often that size is checked. */
  readonly watchInterval?: Duration.Duration
}

const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const backgroundLimit = options.backgroundLimit ?? BACKGROUND_LIMIT
      const watchInterval = options.watchInterval ?? WATCH_INTERVAL
      const bus = yield* Bus.Service
      const toolOutput = yield* ToolOutput.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const shell = yield* ShellSelect.Service
      const environment = yield* Environment.Service
      const hooks = yield* PluginHooks.Service
      const environments = yield* SessionEnvironment.Service
      const config = yield* Config.Service
      const managed = yield* ManagedPolicy.Service
      const context = yield* Effect.context()
      const runFork = Effect.runForkWith(context)
      const commands = new Map<Shell.ID, Active>()
      const exitOrder: Shell.ID[] = []

      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      const { mkdir, unlink } = yield* Effect.promise(() => import("fs/promises"))
      const { createWriteStream, createReadStream, constants } = yield* Effect.promise(() => import("fs"))
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const command of commands.values()) {
            if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
            // Teardown interrupts pending commands; it is not a terminal command failure.
            yield* Deferred.interrupt(command.done)
          }
          commands.clear()
          exitOrder.length = 0
        }),
      )

      const require = Effect.fnUntraced(function* (id: Shell.ID) {
        const command = commands.get(id)
        if (!command) return yield* new NotFoundError({ id })
        return command
      })

      const removeCommand = Effect.fnUntraced(function* (id: Shell.ID, evicted = false) {
        const command = commands.get(id)
        const index = exitOrder.indexOf(id)
        if (index !== -1) exitOrder.splice(index, 1)
        if (!command) return
        commands.delete(id)
        if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
        // Unblock any wait still pending when the command is removed before it terminated.
        yield* Deferred.fail(command.done, new NotFoundError({ id }))
        // Eviction forgets the command but keeps a file that a saved result or a notice may still point at, for the sweep
        // to remove later. An explicit removal takes the file with it.
        if (!evicted || command.whole) yield* Effect.promise(() => unlink(command.file).catch(() => {}))
        yield* bus.publish(Shell.Event.Deleted, { id })
      })

      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        yield* require(id)
        yield* removeCommand(id)
      })

      const list = Effect.fn("Shell.list")(function* () {
        return Array.from(commands.values())
          .filter((command) => command.info.status === "running")
          .map((command) => command.info)
      })

      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        return (yield* require(id)).info
      })

      const wait = Effect.fn("Shell.wait")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).done)
      })

      const timeout = Effect.fn("Shell.timeout")(function* (id: Shell.ID, duration: number) {
        const command = yield* require(id)
        if (command.info.status !== "running" || !command.timeout) return command.info
        yield* command.timeout(duration)
        return command.info
      })

      const output = Effect.fnUntraced(function* (id: Shell.ID, input?: Shell.OutputInput) {
        const command = yield* require(id)
        const cursor = input?.cursor ?? 0
        const limit = input?.limit ?? 65536
        if (cursor >= command.size) return { output: "", cursor: command.size, size: command.size, truncated: false }
        const start = Math.max(0, cursor)
        const length = Math.min(limit, command.size - start)
        const buffer = Buffer.alloc(length)
        const bytesRead = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const stream = createReadStream(command.file, { start, end: start + length - 1 })
              let offset = 0
              stream.on("data", (chunk: string | Buffer) => {
                const bytes = Buffer.from(chunk)
                bytes.copy(buffer, offset)
                offset += bytes.length
              })
              stream.on("end", () => resolve(offset))
              stream.on("error", () => resolve(0))
            }),
        )
        return {
          output: buffer.subarray(0, bytesRead).toString("utf8"),
          cursor: start + bytesRead,
          size: command.size,
          truncated: false,
        }
      })

      const result = Effect.fn("Shell.result")(function* (started: Shell.Info) {
        const info = yield* wait(started.id).pipe(
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({ ...started, status: "killed" as const, time: { ...started.time, completed: Date.now() } }),
          ),
        )
        const command = commands.get(info.id)
        if (!command) return { info, capture: undefined }
        const head = yield* readHead(command.file, headLimit(Config.latest(yield* config.entries(), "tool_output")))
        command.whole = head.whole
        return {
          info,
          capture: {
            // A size kill is said before the output, so its notice opens with it.
            output: command.capped ? `${ShellResult.sizeNotice(backgroundLimit)}\n\n${head.text}` : head.text,
            truncated: head.truncated,
          },
          ...(command.capped ? { capped: true as const } : {}),
          ...(command.abandoned ? { abandoned: true as const } : {}),
        }
      })

      // The first `limit` bytes of the output file, cut back to a whole character. The file is opened without following a
      // link, so a link planted at its path is reported like a missing file and never read (class 4), and a file that
      // cannot be read is named in the text, never shown as no output (class 7).
      const readHead = (file: string, limit: number) =>
        Effect.tryPromise({
          try: async () => {
            const handle = await ToolOutput.openFile(file, constants.O_RDONLY)
            try {
              const size = (await handle.stat()).size
              const buffer = Buffer.alloc(Math.min(limit, size))
              const read = (await handle.read(buffer, 0, buffer.length, 0)).bytesRead
              const whole = read >= size
              // Streaming decode holds back a character the limit cut in two.
              return {
                text: new TextDecoder().decode(buffer.subarray(0, read), { stream: !whole }),
                whole,
                truncated: !whole,
              }
            } finally {
              await handle.close()
            }
          },
          catch: (error) => error as NodeJS.ErrnoException,
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              text: `[The output file ${file} could not be read: ${error.code ?? error.message}]`,
              whole: false,
              truncated: false,
            }),
          ),
        )

      const background = Effect.fn("Shell.background")(function* (id: Shell.ID) {
        const command = yield* require(id)
        if (command.info.status !== "running" || command.watched) return
        command.watched = true
        // The bytes the command has written are what reaches the file. The check runs until the command passes the limit
        // or its end settles `done`, which stops it.
        const passed = Effect.sync(() => command.info.status === "running" && command.size > backgroundLimit)
        runFork(
          Effect.raceFirst(
            passed.pipe(
              Effect.delay(watchInterval),
              Effect.repeat({ until: (over) => over }),
              Effect.andThen(
                Effect.suspend(() => {
                  command.capped = true
                  return command.kill ?? Effect.void
                }),
              ),
            ),
            Deferred.await(command.done).pipe(Effect.ignore),
          ),
        )
      })

      const abandon = Effect.fn("Shell.abandon")(function* (sessionID: string) {
        const owned = Array.from(commands.values()).filter(
          (command) => command.info.status === "running" && command.info.metadata.sessionID === sessionID,
        )
        yield* Effect.forEach(
          owned,
          (command) =>
            Effect.gen(function* () {
              command.abandoned = true
              if (command.kill) yield* command.kill
            }),
          { discard: true },
        )
        return owned.map((command) => command.info.id)
      })

      const offer = Effect.fn("Shell.offer")(function* (input: Parameters<Interface["offer"]>[0]) {
        const command = yield* require(input.id)
        yield* toolOutput.adopt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          callID: input.callID,
          file: command.file,
        })
      })

      const create = Effect.fn("Shell.create")(function* <E = never, R = never>(
        input: CreateInput,
        before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
      ) {
        const sessionID = input.metadata?.sessionID
        const sessionEnvironment =
          location.workspaceID === undefined && Schema.is(SessionSchema.ID)(sessionID)
            ? yield* environments.get(sessionID)
            : undefined
        const invocation: ShellCreateBefore = {
          command: input.command,
          cwd: input.cwd ?? location.directory,
          timeout: input.timeout ?? 0,
          shell: input.shell ?? (yield* shell.resolve({ priority: "config" })),
          // The session's environment, then the settings' `env`, then Orbit's own variables. A workspace-bound location
          // takes no settings overlay: its environment is not this host's.
          env: ConfigEnv.applyTo(
            ConfigEnv.applyTo(
              { ...(sessionEnvironment ?? process.env) },
              location.workspaceID === undefined ? ConfigEnv.resolve(yield* config.entries()) : {},
            ),
            { TERM: "xterm-256color", ORBIT_TERMINAL: "1" },
          ),
        }
        yield* hooks.trigger("shell", "create.before", invocation)
        if (before) yield* before(invocation)

        const id = Shell.ID.ascending()
        const args = ShellSelect.args(invocation.shell, invocation.command)
        const sandbox = Config.latest(yield* config.entries(), "sandbox")
        const network = managed.current().restrictions.network
        const sandboxed = ShellSandbox.launch({
          settings: yield* ManagedNetwork.sandboxSettings(sandbox, network),
          shell: invocation.shell,
          args,
          cwd: invocation.cwd,
          writable: [location.project.directory, invocation.cwd, tmpdir()],
        })
        // Fail closed: a sandbox the user asked for but cannot get must not quietly become an unsandboxed command.
        if (sandboxed.type === "missing")
          return yield* new AppProcess.AppProcessError({
            command: invocation.command,
            cause: new Error(`Shell sandboxing is enabled but ${sandboxed.tool} is not installed`),
          })
        if (sandboxed.type === "unsupported")
          return yield* new AppProcess.AppProcessError({
            command: invocation.command,
            cause: new Error(sandboxed.reason),
          })
        if (sandboxed.type === "unwrapped") yield* ManagedNetwork.unbound(network)
        const file = path.join(outputDir, `${id}.out`)

        const info: Info = {
          id,
          status: "running",
          command: invocation.command,
          cwd: invocation.cwd,
          shell: invocation.shell,
          file,
          metadata: input.metadata ?? {},
          time: { started: Date.now() },
        }

        // Spawn through the Environment and stream combined output to the file. The handle is scope-bound, so
        // the managing fiber keeps its scope open until the command terminates (it awaits `done` at the
        // end). `create` returns once `ready` resolves with the registered command.
        const ready = Deferred.makeUnsafe<Active, AppProcess.AppProcessError>()
        runFork(
          Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* environment.spawner
                .spawn(
                  ChildProcess.make(
                    sandboxed.type === "wrapped" ? sandboxed.command : invocation.shell,
                    sandboxed.type === "wrapped" ? sandboxed.args : args,
                    {
                      cwd: invocation.cwd,
                      env: invocation.env,
                      stdin: "ignore",
                      detached: process.platform !== "win32",
                      forceKillAfter: Duration.seconds(3),
                    },
                  ),
                )
                .pipe(
                  Effect.mapError((cause) => new AppProcess.AppProcessError({ command: invocation.command, cause })),
                )
              const command: Active = {
                info: produce(info, (draft) => {
                  draft.pid = handle.pid
                }),
                file,
                size: 0,
                done: Deferred.makeUnsafe<Info, NotFoundError>(),
                whole: false,
                watched: false,
                capped: false,
                abandoned: false,
              }
              commands.set(id, command)

              // Never through a link at the path (class 4). The stream hands its flags to `fs.open`, which takes them as a
              // number; there is no string for O_NOFOLLOW.
              const stream = createWriteStream(file, {
                flags: (constants.O_WRONLY |
                  constants.O_CREAT |
                  constants.O_TRUNC |
                  (constants.O_NOFOLLOW ?? 0)) as unknown as string,
              })
              const outputDone = Latch.makeUnsafe()
              const pump = handle.all.pipe(
                Stream.runForEach((chunk: Uint8Array) =>
                  Effect.sync(() => {
                    stream.write(chunk)
                    command.size += chunk.length
                  }),
                ),
              )
              runFork(
                Effect.gen(function* () {
                  yield* pump.pipe(Effect.catch(() => Effect.void))
                  yield* Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        stream.end(() => resolve())
                      }),
                  )
                  yield* outputDone.open
                }),
              )
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    stream.once("open", () => resolve())
                    stream.once("error", () => resolve())
                  }),
              )

              const finish = (status: Info["status"], exit?: number, beforeWait = Effect.void, signal?: string) =>
                Effect.gen(function* () {
                  if (command.info.status !== "running") return
                  command.info = produce(command.info, (draft) => {
                    draft.status = status
                    if (exit !== undefined) draft.exit = exit
                    if (signal !== undefined) draft.signal = signal
                    draft.time.completed = Date.now()
                  })
                  yield* beforeWait
                  yield* outputDone.await
                  // Resolve waiters with the terminal Info before any retention eviction, so an evicted
                  // command still reports success rather than the removal NotFoundError. This runs before
                  // the timeout-fiber interrupt below, which on the timeout path would otherwise cancel
                  // this very fiber (finish is invoked by the timeout fiber) before waiters are resolved.
                  yield* Deferred.succeed(command.done, command.info)
                  yield* bus.publish(Shell.Event.Exited, {
                    id,
                    ...(exit !== undefined ? { exit } : {}),
                    status,
                  })
                  exitOrder.push(id)
                  while (exitOrder.length > EXITED_LIMIT) {
                    const oldest = exitOrder[0]
                    if (!oldest) break
                    yield* removeCommand(oldest, true)
                  }
                  // Keep exited history data-only. Interrupt last because finish may run on the timeout fiber.
                  const timeoutFiber = command.timeoutFiber
                  command.timeout = undefined
                  command.timeoutFiber = undefined
                  if (timeoutFiber) yield* Fiber.interrupt(timeoutFiber)
                })

              command.timeout = (duration) =>
                Effect.gen(function* () {
                  if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
                  command.timeoutFiber = undefined
                  if (duration === 0 || command.info.status !== "running") return
                  command.timeoutFiber = runFork(
                    Effect.sleep(Duration.millis(duration)).pipe(
                      Effect.flatMap(() =>
                        finish(
                          "timeout",
                          undefined,
                          handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.catch(() => Effect.void)),
                        ),
                      ),
                    ),
                  )
                })

              yield* command.timeout(invocation.timeout)
              command.kill = finish(
                "killed",
                undefined,
                handle.kill({ forceKillAfter: Duration.seconds(3) }).pipe(Effect.catch(() => Effect.void)),
              )

              runFork(
                handle.exitCode.pipe(
                  Effect.flatMap((code) => finish("exited", code)),
                  Effect.catch((error) =>
                    finish(
                      "exited",
                      undefined,
                      Effect.void,
                      error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
                    ),
                  ),
                ),
              )

              yield* bus.publish(Shell.Event.Created, { info })
              yield* Deferred.succeed(ready, command)
              // Hold the handle's scope open until the command terminates; closing it earlier would
              // release (kill) the process before its exit is observed.
              yield* Deferred.await(command.done).pipe(Effect.catch(() => Effect.void))
            }),
          ).pipe(
            Effect.catchTag("AppProcessError", (error) => Deferred.fail(ready, error)),
            // Whatever ends this fiber before the command is registered (a defect included) settles `ready`, so the
            // creator, and its interrupt cleanup below, never wait for a command that will not come. A no-op once done.
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Deferred.failCause(ready, exit.cause) : Effect.void,
            ),
          ),
        )

        // `list` shows the command before `ready` resolves, so a creator interrupted here would leave
        // a spawned process with no owner; remove it once it has spawned.
        const command = yield* Deferred.await(ready).pipe(
          Effect.onInterrupt(() =>
            Deferred.await(ready).pipe(
              Effect.flatMap((spawned) => removeCommand(spawned.info.id)),
              Effect.ignoreCause,
            ),
          ),
        )
        return command.info
      })

      const kill = Effect.fn("Shell.kill")(function* (id: Shell.ID) {
        const command = yield* require(id)
        if (command.info.status === "running" && command.kill) yield* command.kill
        return command.info
      })

      return Service.of({
        create,
        list,
        get,
        wait,
        result,
        background,
        abandon,
        offer,
        timeout,
        output,
        remove,
        kill,
      })
    }),
  )

/** The service with its own size watchdog: the seam for the background limit and how often it is checked. */
export const nodeWith = (options: Options) =>
  makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Bus.node,
      Location.node,
      Global.node,
      ShellSelect.node,
      Environment.node,
      PluginHooks.node,
      SessionEnvironment.node,
      ManagedPolicy.node,
      Config.node,
      ToolOutput.node,
      cleanupNode,
    ],
  })

export const node = nodeWith({})
