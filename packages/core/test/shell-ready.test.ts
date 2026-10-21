import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
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

// FU-M2-040: the fiber that spawns the command can end with a defect before it registers the command. `create` and its
// interrupt cleanup must still return.
const withSpawner = <A, E>(
  spawn: () => Effect.Effect<never>,
  body: (shell: Shell.Interface) => Effect.Effect<A, E>,
) => {
  const environment = Layer.effect(
    Environment.Service,
    Effect.gen(function* () {
      const host = yield* Environment.Service
      return Environment.Service.of({ ...host, spawner: ChildProcessSpawner.make(spawn) })
    }),
  ).pipe(Layer.provide(hostEnvironmentLayer))
  return Effect.gen(function* () {
    return yield* body(yield* Shell.Service)
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
}

const request = { shell: "sh", command: "true", timeout: 0 } as const

it.live("create fails when the spawn dies with a defect, instead of waiting for the command", () =>
  withSpawner(
    () => Effect.die(new Error("spawn defect")),
    (shell) =>
      Effect.gen(function* () {
        const exit = yield* shell.create(request).pipe(Effect.timeout("3 seconds"), Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("spawn defect")
      }),
  ),
)

it.live("an interrupt of create returns when the spawn dies with a defect", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* withSpawner(
      () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.die(new Error("spawn defect"))),
        ),
      (shell) =>
        Effect.gen(function* () {
          const creator = yield* shell.create(request).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const interrupting = yield* Fiber.interrupt(creator).pipe(Effect.forkChild)
          yield* Deferred.succeed(release, undefined)

          // Before the fix the cleanup waited for a command that never registered, and the interrupt never returned.
          const outcome = yield* Fiber.join(interrupting).pipe(Effect.timeoutOption("3 seconds"))
          expect(outcome._tag).toBe("Some")
        }),
    )
  }),
)
