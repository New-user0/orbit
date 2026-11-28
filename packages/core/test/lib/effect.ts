import { test, type TestOptions } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, type Scope } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { processMemoMap } from "../fixture/native-watcher"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"])

// Core is env-free, so nothing tells the default node graph to stay offline;
// a test that boots it would phone home through FetchHttpClient. Every
// FetchHttpClient reads this reference at request time, so refusing here covers
// each node that shares the default client, while an explicit HttpClient
// replacement never reaches it. Callers such as ModelsDev swallow request
// failures, so the harness also records the attempt and fails the test itself.
export const refuseNetwork = (violations: string[]): typeof fetch =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (loopback.has(new URL(url).hostname)) return fetch(input, init)
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      const message = `test attempted network request: ${method} ${url} — provide an explicit HttpClient or disable the fetch`
      violations.push(message)
      return Promise.reject(new Error(message))
    },
    { preconnect: fetch.preconnect },
  )

// Bun fails a row that passes its time limit but cannot stop the Effect behind it, which goes on running into the next
// rows: a timed-out ShellTool row added its permission question to what the next row read (FU-M4-235). Each row first
// stops whatever an earlier row left running, so what a row reads is only its own.
const unfinished = new Set<Fiber.Fiber<unknown, unknown>>()

const run = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) => {
  const leftover = [...unfinished]
  unfinished.clear()
  leftover.forEach((fiber) => stopped.add(fiber))
  return Effect.runPromise(
    Effect.forEach(leftover, (fiber) => Fiber.interrupt(fiber).pipe(Effect.timeoutOption("5 seconds")), {
      concurrency: "unbounded",
      discard: true,
    }),
  ).then(() => {
    const fiber = Effect.runFork(row(value, layer))
    unfinished.add(fiber)
    return Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      unfinished.delete(fiber)
      // Bun has already reported a row that was stopped here as timed out, and nothing waits for its answer.
      if (stopped.delete(fiber)) return undefined
      return Effect.runPromise(exit)
    })
  })
}
const stopped = new Set<Fiber.Fiber<unknown, unknown>>()

const row = <A, E, R, E2>(value: Body<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) =>
  Effect.gen(function* () {
    const violations: string[] = []
    const exit = yield* body(value).pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.Fetch, refuseNetwork(violations)),
      // Every runtime a row builds, here or in its own Effect.provide, takes the process's native watches, so no row
      // ends a live Windows directory watch when it closes (test/fixture/native-watcher.ts).
      Effect.provideService(Layer.CurrentMemoMap, processMemoMap),
      Effect.exit,
    )
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    if (violations.length > 0) return yield* Effect.fail(new Error(violations.join("\n")))
    return yield* exit
  })

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, testLayer), opts)

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, testLayer), opts)

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, testLayer), opts)

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test(name, () => run(value, liveLayer), opts)

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.only(name, () => run(value, liveLayer), opts)

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) =>
    test.skip(name, () => run(value, liveLayer), opts)

  return { effect, live }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make(testEnv, liveEnv)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))
