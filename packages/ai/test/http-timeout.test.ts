import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { type AIError, HttpOptions, LLM, LanguageModel, type LLMRequest, mergeHttpOptions } from "../src/index.js"
import { LLMClient } from "../src/route.js"
import { configure } from "../src/providers/openai.js"
import { Anthropic } from "../src/providers.js"
import { dynamicResponse } from "./lib/http.js"
import { deltaChunk, finishChunk } from "./lib/openai-chunks.js"
import { sseEvents, sseNamedEvent, sseRaw } from "./lib/sse.js"
import { it } from "./lib/effect.js"

const model = configure({ baseURL: "https://api.openai.test/v1/", apiKey: "test" }).chat("gpt-4.1-mini")
const SSE = { headers: { "content-type": "text/event-stream" } }

const silentServer = dynamicResponse(() => Effect.never)

const slowHeadersServer = dynamicResponse((input) =>
  Effect.sleep("10 minutes").pipe(
    Effect.as(input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hi" }), finishChunk("stop")), SSE)),
  ),
)

// Sends one chunk, then stalls until `resume` releases the rest of the body.
const stalledAfter = (first: string) =>
  Effect.gen(function* () {
    const stalled = yield* Deferred.make<void>()
    let resume = () => {}
    const released = new Promise<void>((resolve) => {
      resume = resolve
    })
    const encoder = new TextEncoder()
    const layer = dynamicResponse((input) =>
      Effect.sync(() =>
        input.respond(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(first))
            },
            async pull(controller) {
              Deferred.doneUnsafe(stalled, Effect.void)
              await released
              controller.enqueue(encoder.encode(sseEvents(finishChunk("stop"))))
              controller.close()
            },
          }),
          SSE,
        ),
      ),
    )
    return { layer, stalled, resume: () => resume() }
  })

const stalledServer = stalledAfter(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: "Hi" }))}`))
// A keepalive is the first frame of a first-party stream, so it is a valid frame that carries no content.
const stalledAfterPing = stalledAfter(sseRaw(sseNamedEvent("ping", { type: "ping" })))

// Starts a request that the stalled server leaves silent, and returns once the transport is waiting for more data.
const startStalled = (server: Effect.Success<typeof stalledServer>, request: LLMRequest) =>
  Effect.gen(function* () {
    const fiber = yield* LLMClient.generate(request).pipe(
      Effect.provide(server.layer),
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    )
    yield* Deferred.await(server.stalled)
    yield* Effect.yieldNow
    return fiber
  })

// The stream survives until the last millisecond before `limit` and fails with a read timeout at `limit`.
const failsAt = (fiber: Fiber.Fiber<AIError, unknown>, limit: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(limit - 1)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(1)
    const error = yield* Fiber.join(fiber)

    expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })
    expect(error.reason.http).toMatchObject({ status: 200 })
  })

describe("HTTP transport timeouts", () => {
  it.effect("fails when response headers take longer than five minutes", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(silentServer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust("5 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({
        _tag: "Transport",
        transport: "http",
        operation: "request",
        code: "Timeout",
      })
    }),
  )

  it.effect("fails when the response body stalls for five minutes", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
        Effect.provide(server.layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("5 minutes")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", transport: "http", operation: "read", code: "Timeout" })
      expect(error.reason.http).toMatchObject({ status: 200 })
    }),
  )

  it.effect("applies a configured header timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { headerTimeout: 1_000 } }),
      ).pipe(Effect.provide(silentServer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("disables the header timeout with false", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { headerTimeout: false } }),
      ).pipe(Effect.provide(slowHeadersServer), Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("10 minutes")
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("disables the chunk timeout with false", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { chunkTimeout: false } }),
      ).pipe(Effect.provide(server.layer), Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("10 minutes")
      server.resume()
      const response = yield* Fiber.join(fiber)

      expect(response.text).toBe("Hi")
    }),
  )

  it.effect("applies a whole-request timeout while the body is still streaming", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { timeout: 60_000, chunkTimeout: false } }),
      ).pipe(Effect.provide(server.layer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(server.stalled)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 minute")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "read", code: "Timeout" })
    }),
  )

  it.effect("bounds the header wait by a shorter whole-request timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Hello", http: { timeout: 1_000, headerTimeout: false } }),
      ).pipe(Effect.provide(silentServer), Effect.flip, Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)

      expect(error.reason).toMatchObject({ _tag: "Transport", operation: "request", code: "Timeout" })
    }),
  )

  it.effect("merges timeouts with later values winning", () =>
    Effect.sync(() => {
      const merged = mergeHttpOptions(
        new HttpOptions({ timeout: 5_000, headerTimeout: 1_000, chunkTimeout: 2_000 }),
        new HttpOptions({ headers: { a: "b" } }),
        new HttpOptions({ chunkTimeout: false }),
      )

      expect(merged).toMatchObject({ headers: { a: "b" }, timeout: 5_000, headerTimeout: 1_000, chunkTimeout: false })
      expect(mergeHttpOptions(new HttpOptions({}), undefined)).toBeUndefined()
    }),
  )
})

describe("route-level chunk timeout default", () => {
  const routeModel = configure({
    baseURL: "https://api.openai.test/v1/",
    apiKey: "test",
    http: { chunkTimeout: 90_000 },
  }).chat("gpt-4.1-mini")

  it.effect("applies when the request leaves it unset, and fails the stream with a read timeout", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const fiber = yield* startStalled(server, LLM.request({ model: routeModel, prompt: "Hello" }))

      yield* failsAt(fiber, 90_000)
    }),
  )

  const replacements: ReadonlyArray<{
    readonly name: string
    readonly limit: number
    readonly model?: HttpOptions.Input
    readonly request?: HttpOptions.Input
  }> = [
    { name: "a request-level limit", limit: 120_000, request: { chunkTimeout: 120_000 } },
    { name: "a model-level limit", limit: 600_000, model: { chunkTimeout: 600_000 } },
    {
      name: "a request-level limit over a model-level one",
      limit: 120_000,
      model: { chunkTimeout: 600_000 },
      request: { chunkTimeout: 120_000 },
    },
  ]
  for (const replacement of replacements)
    it.effect(`yields to ${replacement.name}`, () =>
      Effect.gen(function* () {
        const server = yield* stalledServer
        const model =
          replacement.model === undefined
            ? routeModel
            : LanguageModel.update(routeModel, { defaults: { http: replacement.model } })
        const fiber = yield* startStalled(server, LLM.request({ model, prompt: "Hello", http: replacement.request }))

        yield* failsAt(fiber, replacement.limit)
      }),
    )

  it.effect("yields to false, which turns the limit off", () =>
    Effect.gen(function* () {
      const server = yield* stalledServer
      const stalled = yield* startStalled(
        server,
        LLM.request({ model: routeModel, prompt: "Hello", http: { chunkTimeout: false } }),
      )
      yield* TestClock.adjust("10 minutes")
      expect(stalled.pollUnsafe()).toBeUndefined()
      server.resume()
      yield* Fiber.interrupt(stalled)
    }),
  )
})

describe("first-party stream idle limit", () => {
  const model = (baseURL?: string) => Anthropic.configure({ apiKey: "test", baseURL }).model("claude-sonnet-4-6")

  it.effect("fails a stream that stays silent for 90 seconds on the default endpoint", () =>
    Effect.gen(function* () {
      const server = yield* stalledAfterPing
      const fiber = yield* startStalled(server, LLM.request({ model: model(), prompt: "Hello" }))

      yield* failsAt(fiber, 90_000)
    }),
  )

  it.effect("keeps the 300 second default behind a custom baseURL", () =>
    Effect.gen(function* () {
      const server = yield* stalledAfterPing
      const fiber = yield* startStalled(
        server,
        LLM.request({ model: model("https://gateway.example.test/v1"), prompt: "Hello" }),
      )

      yield* failsAt(fiber, 300_000)
    }),
  )
})
