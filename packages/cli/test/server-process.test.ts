import { NodeServices } from "@effect/platform-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Logger, Option } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../../core/test/lib/effect"
import { ConfigOverlay } from "../src/config-overlay"
import { ServerProcess } from "../src/server-process"
import { bareEnvironment, headlessInput } from "../src/commands/handlers/run"

test("a private or foreground server trusts folders only when its environment asks it to", () => {
  for (const mode of ["default", "stdio"] as const) {
    expect(ServerProcess.trustOptions(mode, {})).toEqual({ implicit: false })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "true" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "TRUE" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "0" })).toEqual({ implicit: false })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "" })).toEqual({ implicit: false })
  }
})

test("the background service never takes its trust from the environment, which belongs to its first client", () => {
  expect(ServerProcess.trustOptions("service", {})).toEqual({ implicit: false })
  expect(ServerProcess.trustOptions("service", { ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: false })
  expect(ServerProcess.trustOptions("service", { ORBIT_TRUST_PROJECT: "true" })).toEqual({ implicit: false })
})

// foundations-19: the reference's bare runs do no housekeeping, so the private server of `orb run --bare` and
// `orb -p --bare` removes no sessions (class 12: the bare entry point is held to the same switch as the server).
test("a bare run's private server schedules no session retention, and the background service ignores the switch", () => {
  for (const mode of ["default", "stdio"] as const) {
    expect(ServerProcess.retentionOption(mode, {})).toBe(true)
    expect(ServerProcess.retentionOption(mode, bareEnvironment)).toBe(false)
    expect(ServerProcess.retentionOption(mode, { ORBIT_DISABLE_RETENTION: "true" })).toBe(false)
    expect(ServerProcess.retentionOption(mode, { ORBIT_DISABLE_RETENTION: "0" })).toBe(true)
  }
  expect(ServerProcess.retentionOption("service", bareEnvironment)).toBe(true)
})

test("a server that orb starts puts the managed env into its own environment, and reads the folder the environment names", () => {
  expect(ServerProcess.managedOptions({})).toEqual({ directory: undefined, applyEnv: true })
  expect(ServerProcess.managedOptions({ ORBIT_MANAGED_DIR: "" })).toEqual({ directory: undefined, applyEnv: true })
  expect(ServerProcess.managedOptions({ ORBIT_MANAGED_DIR: "/etc/orbit" })).toEqual({
    directory: "/etc/orbit",
    applyEnv: true,
  })
})

// The CLI hands a private server its run-scoped config in a file. The shared service must never take it, and no server
// leaves the variable in the environment of the processes it starts.
test("a private server reads the overlay file once, deletes it, and removes the variable from its environment", async () => {
  const written = await ConfigOverlay.write({ content: '{"agents":{}}' })
  try {
    for (const mode of ["default", "stdio"] as const) {
      const again = await ConfigOverlay.write({ content: '{"agents":{}}' })
      const env: Record<string, string | undefined> = { ORBIT_CONFIG_CONTENT_FILE: again.file }

      expect(await ServerProcess.takeOverlay(mode, env)).toEqual({ content: '{"agents":{}}', file: undefined })
      expect(env).toEqual({})
      expect(await Bun.file(again.file).exists()).toBe(false)
      await again.remove()
    }
  } finally {
    await written.remove()
  }
})

test("the background service ignores the overlay file, leaves it alone, and does not keep the variable", async () => {
  const written = await ConfigOverlay.write({ content: '{"agents":{"leaked":{"system":"x"}}}' })
  try {
    const env: Record<string, string | undefined> = { ORBIT_CONFIG_CONTENT_FILE: written.file }

    expect(await ServerProcess.takeOverlay("service", env)).toBeUndefined()
    expect(env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
    expect(await Bun.file(written.file).exists()).toBe(true)
  } finally {
    await written.remove()
  }
})

test("a server started without an overlay file takes none", async () => {
  const env: Record<string, string | undefined> = { ORBIT_CONFIG_CONTENT: "{}" }

  expect(await ServerProcess.takeOverlay("default", env)).toBeUndefined()
  expect(env).toEqual({ ORBIT_CONFIG_CONTENT: "{}" })
})

// foundations-19, S7 (class 12): `orb run --bare` and `orb -p --bare` put the switch into this process's environment
// before the private server starts, and that server, built from the environment the way every `orb` server is, forks
// no retention schedule; one started without the switch does. Both servers get flag config that does not parse, so a
// pass that comes due only logs that it skips and never touches the data folder these tests share.
const withEnvironment = <A, E, R>(values: Record<string, string>, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
      Object.assign(process.env, values)
      return saved
    }),
    () => body,
    (saved) =>
      Effect.sync(() =>
        Object.entries(saved).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )

const headless = {
  server: Option.none<string>(),
  standalone: false,
  trust: false,
  bare: false,
  settings: [],
  mcpConfig: [],
  agents: Option.none<string>(),
  message: ["hello"],
  continue: false,
  session: Option.none<string>(),
  resume: Option.none<string>(),
  fork: false,
  model: Option.none<string>(),
  agent: Option.none<string>(),
  format: "default" as const,
  jsonSchema: Option.none<string>(),
  file: [],
  inputFormat: Option.none<"text" | "stream-json">(),
  title: Option.none<string>(),
  thinking: false,
  maxSteps: Option.none<number>(),
  maxCost: Option.none<number>(),
  maxTokens: Option.none<number>(),
  fallbackModel: Option.none<string>(),
  auto: false,
  yolo: false,
  dangerouslySkipPermissions: false,
}

test("a bare run leaves the retention switch for its private server in this process's environment", async () => {
  const exitCode = process.exitCode
  const unset = { ORBIT_DISABLE_PROJECT_CONFIG: "0", ORBIT_DISABLE_INSTRUCTIONS: "0", ORBIT_DISABLE_RETENTION: "0" }
  const seen = (bare: boolean) =>
    Effect.runPromise(
      withEnvironment(
        unset,
        Effect.gen(function* () {
          // --settings with --server is refused right after the switch is set, before any server is reached.
          yield* headlessInput({ ...headless, bare, server: Option.some("http://127.0.0.1:9"), settings: ["{}"] })
          return Object.fromEntries(Object.keys(bareEnvironment).map((key) => [key, process.env[key]]))
        }).pipe(Effect.scoped),
      ).pipe(Effect.provide(LayerNode.compile(Global.node)), Effect.provide(NodeServices.layer)),
    )
  try {
    expect(await seen(false)).toEqual(unset)
    expect(await seen(true)).toEqual(bareEnvironment)
    expect(bareEnvironment.ORBIT_DISABLE_RETENTION).toBe("1")
    expect(process.exitCode).toBe(1)
  } finally {
    // The refusal set the exit code of this test process; the runner reads it at the end.
    process.exitCode = exitCode ?? 0
  }
})

it.effect(
  "a private server started with the retention switch forks no schedule, and one without it does",
  () =>
    Effect.gen(function* () {
      const managed = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "orbit-retention-managed-")))
      const config = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "orbit-retention-config-")))
      const passes = (disabled: boolean, attempts: number) =>
        Effect.gen(function* () {
          const logged: string[] = []
          const tries = yield* withEnvironment(
            {
              ORBIT_DB: ":memory:",
              ORBIT_CONFIG_CONTENT: "{",
              ORBIT_CONFIG_DIR: config,
              ORBIT_MANAGED_DIR: managed,
              ORBIT_PASSWORD: "secret",
              ORBIT_DISABLE_PROJECT_CONFIG: "1",
              ORBIT_DISABLE_MODELS_FETCH: "1",
              ORBIT_DISABLE_FILEWATCHER: "1",
              ORBIT_DISABLE_RETENTION: disabled ? "1" : "0",
            },
            Effect.gen(function* () {
              const server = yield* ServerProcess.run({ mode: "default", hostname: "127.0.0.1", port: 0 }).pipe(
                Effect.forkScoped,
              )
              // The schedule is forked once the server has booted: keep moving the clock until a pass is due.
              let moved = 0
              for (; moved < attempts && logged.length === 0; moved++) {
                yield* TestClock.adjust("10 minutes")
                yield* Effect.promise(() => Bun.sleep(20))
              }
              yield* Fiber.interrupt(server)
              return moved
            }).pipe(Effect.scoped),
          ).pipe(
            Effect.provideService(
              Logger.CurrentLoggers,
              new Set([
                Logger.make((entry) => {
                  const message = [entry.message].flat()[0]
                  if (typeof message === "string" && message.startsWith("session retention")) logged.push(message)
                }),
              ]),
            ),
          )
          return { logged, tries }
        })

      const enabled = yield* passes(false, 250)
      expect(enabled.logged).toEqual(["session retention skipped: a config file does not parse"])
      // The same server with the switch, given three times as many clock moves as the one without it needed.
      expect((yield* passes(true, Math.max(30, enabled.tries * 3))).logged).toEqual([])
      yield* Effect.promise(() =>
        Promise.all([managed, config].map((folder) => fs.rm(folder, { recursive: true, force: true }))),
      )
    }),
  60_000,
)
