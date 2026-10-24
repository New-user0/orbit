import { expect } from "bun:test"
import fs from "node:fs/promises"
import { Deferred, Effect, Fiber, Layer, Queue, Scope, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Environment } from "@orbit/core/environment/index"
import { Location } from "@orbit/core/location"
import { Shell } from "@orbit/core/shell"
import { Global } from "@orbit/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { it } from "./lib/effect"

it.live("eviction makes progress past an already-removed shell", () =>
  Effect.gen(function* () {
    const completions = yield* Queue.unbounded<Effect.Effect<void>>()
    const environment = Layer.effect(
      Environment.Service,
      Effect.gen(function* () {
        const host = yield* Environment.Service
        const scope = yield* Scope.Scope
        return Environment.Service.of({
          ...host,
          spawner: ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const exited = yield* Deferred.make<ExitCode>()
              const observer = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
              yield* Queue.offer(
                completions,
                Effect.gen(function* () {
                  yield* Deferred.succeed(exited, ExitCode(0))
                  // Shell.wait resolves before retention runs; join the whole exit handler instead.
                  const fiber = yield* Deferred.await(observer)
                  yield* Fiber.join(fiber).pipe(Effect.orDie)
                }),
              )
              const output = Stream.succeed(Buffer.from("hello"))
              return makeHandle({
                pid: ProcessId(1),
                exitCode: Effect.withFiber((fiber) =>
                  Scope.addFinalizer(scope, Fiber.interrupt(fiber)).pipe(
                    Effect.andThen(Deferred.succeed(observer, fiber)),
                    Effect.andThen(Deferred.await(exited)),
                  ),
                ),
                isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
                kill: () => Deferred.succeed(exited, ExitCode(0)).pipe(Effect.asVoid),
                stdin: Sink.drain,
                stdout: output,
                stderr: Stream.empty,
                all: output,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
              })
            }),
          ),
        })
      }),
    ).pipe(Layer.provide(hostEnvironmentLayer))

    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const removed = yield* shell.create({ shell: "sh", command: "removed", timeout: 0 })
      const finishRemoved = yield* Queue.take(completions)
      yield* shell.remove(removed.id)
      expect((yield* shell.result(removed)).capture).toBeUndefined()
      yield* finishRemoved

      const complete = Effect.gen(function* () {
        const info = yield* shell.create({ shell: "sh", command: "hello", timeout: 0 })
        const finish = yield* Queue.take(completions)
        yield* finish
        return info
      })
      const oldest = yield* complete
      // Exceed the 25-entry retention cap with the removed ID at the head of exitOrder.
      yield* Effect.forEach(Array.from({ length: 25 }), () => complete, { discard: true })
      expect(yield* shell.get(oldest.id).pipe(Effect.flip)).toBeInstanceOf(Shell.NotFoundError)

      const survivor = yield* complete
      expect(yield* shell.result(survivor)).toMatchObject({
        info: { status: "exited", exit: 0 },
        capture: { output: "hello", truncated: false },
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(environment),
        ]),
      ),
    )
  }),
)

// shell-safety-6: eviction forgets a command, never a file that a result may still point at. A file whose whole output
// reached a result is redundant and goes with the command; one that did not fit, and one whose result nobody took, stay
// for the 7-day sweep. The command's text picks its output: "big" prints more than the 30,000-byte head read.
const BIG = 40_000

const evictionEnvironment = (completions: Queue.Queue<Effect.Effect<void>>) =>
  Layer.effect(
    Environment.Service,
    Effect.gen(function* () {
      const host = yield* Environment.Service
      const scope = yield* Scope.Scope
      return Environment.Service.of({
        ...host,
        spawner: ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const exited = yield* Deferred.make<ExitCode>()
            const observer = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
            yield* Queue.offer(
              completions,
              Effect.gen(function* () {
                yield* Deferred.succeed(exited, ExitCode(0))
                // Shell.wait resolves before retention runs; join the whole exit handler instead.
                const fiber = yield* Deferred.await(observer)
                yield* Fiber.join(fiber).pipe(Effect.orDie)
              }),
            )
            // The command's arguments carry its text (a command serialises to no fields of its own).
            const big = command._tag === "StandardCommand" && command.args.includes("big")
            const output = Stream.succeed(Buffer.from(big ? "b".repeat(BIG) : "hello"))
            return makeHandle({
              pid: ProcessId(1),
              exitCode: Effect.withFiber((fiber) =>
                Scope.addFinalizer(scope, Fiber.interrupt(fiber)).pipe(
                  Effect.andThen(Deferred.succeed(observer, fiber)),
                  Effect.andThen(Deferred.await(exited)),
                ),
              ),
              isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
              kill: () => Deferred.succeed(exited, ExitCode(0)).pipe(Effect.asVoid),
              stdin: Sink.drain,
              stdout: output,
              stderr: Stream.empty,
              all: output,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            })
          }),
        ),
      })
    }),
  ).pipe(Layer.provide(hostEnvironmentLayer))

/** Runs `command` and evicts it behind 25 later commands; the size of its output file afterwards, or none. */
const sizeAfterEviction = (input: { command: string; takeResult: boolean }) =>
  Effect.gen(function* () {
    const completions = yield* Queue.unbounded<Effect.Effect<void>>()
    return yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const complete = (command: string) =>
        Effect.gen(function* () {
          const info = yield* shell.create({ shell: "sh", command, timeout: 0 })
          yield* Effect.flatten(Queue.take(completions))
          return info
        })
      const first = yield* complete(input.command)
      if (input.takeResult) yield* shell.result(first)
      yield* Effect.forEach(Array.from({ length: 25 }), () => complete("hello"), { discard: true })
      expect(yield* shell.get(first.id).pipe(Effect.flip)).toBeInstanceOf(Shell.NotFoundError)
      return yield* Effect.promise(() =>
        fs.stat(first.file).then(
          (stat) => stat.size,
          () => undefined,
        ),
      )
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(evictionEnvironment(completions)),
        ]),
      ),
    )
  })

// Fails on the base: `removeCommand` unlinks every evicted file, so the source of a saved copy and the file a notice
// names are gone.
it.live("keeps the output file of an evicted command whose output did not fit", () =>
  sizeAfterEviction({ command: "big", takeResult: true }).pipe(
    Effect.tap((size) => Effect.sync(() => expect(size).toBe(BIG))),
  ),
)

// Fails on the base for the same reason: nobody has read this output yet, so the file is all there is of it.
it.live("keeps the output file of an evicted command whose result was never taken", () =>
  sizeAfterEviction({ command: "hello", takeResult: false }).pipe(
    Effect.tap((size) => Effect.sync(() => expect(size).toBe("hello".length))),
  ),
)

// The control, which passes on the base: the whole output reached the result, so the file leaves with the command.
it.live("deletes the output file of an evicted command whose whole output reached its result", () =>
  sizeAfterEviction({ command: "hello", takeResult: true }).pipe(
    Effect.tap((size) => Effect.sync(() => expect(size).toBeUndefined())),
  ),
)
