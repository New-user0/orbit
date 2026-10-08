import { describe, expect } from "bun:test"
import { AIError, ProviderInternalError, RateLimitError, TransportError } from "@orbit/ai"
import { Agent } from "@orbit/schema/agent"
import { Model } from "@orbit/schema/model"
import { Provider } from "@orbit/core/provider"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionRunnerRetry } from "@orbit/core/session/runner/retry"
import { toSessionError } from "@orbit/core/session/to-session-error"
import { Effect, Random } from "effect"
import { it } from "./lib/effect"
import { overloaded } from "./lib/provider-failure"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
// What the WebSocket route reports when no frame arrives within its idle limit (`model-transport.ts`).
const idleTimeout = new AIError({
  reason: new TransportError({
    message: "Timed out waiting for WebSocket data",
    transport: "websocket",
    operation: "read",
    code: "idle-timeout",
    phase: "receive",
    delivery: "ambiguous",
  }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })

// Nominal gap before each of the ten retries: 500ms doubling up to 32s, then held there.
const GAPS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000, 32_000]

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for consecutive failures within one step.
const decisions = (causes: ReadonlyArray<AIError>) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    return yield* Effect.forEach(causes, (cause) => policy(input(cause)))
  })

const repeated = (cause: AIError, count: number) => Array.from({ length: count }, () => cause)
const granted = (results: Effect.Success<ReturnType<typeof decisions>>) => results.map((result) => result.retry)
// The delay of each retry that was granted; a refused one leaves a hole that the assertions on the delays catch.
const delays = (results: Effect.Success<ReturnType<typeof decisions>>) =>
  results.map((result) => (result.retry ? result.delay : undefined))

// Fixes the jitter draw, which the schedule scales between 0.8 and 1.2 times the gap.
const draw = (value: number) =>
  Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => value })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(granted(yield* decisions(repeated(timeout, 4)))).toEqual([true, true, true, false])
    }),
  )

  it.effect("stops retrying WebSocket idle timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(granted(yield* decisions(repeated(idleTimeout, 4)))).toEqual([true, true, true, false])
    }),
  )

  it.effect("counts both kinds of timeout toward the same cap", () =>
    Effect.gen(function* () {
      expect(granted(yield* decisions([timeout, idleTimeout, timeout, idleTimeout]))).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(granted(yield* decisions(repeated(internal, 10)))).toEqual(Array(10).fill(true))
    }),
  )

  it.effect("retries an overloaded provider", () =>
    Effect.gen(function* () {
      const failure = overloaded()
      expect(failure.reason._tag).toBe("ProviderInternal")
      expect(SessionRunnerRetry.isRetryable(failure)).toBe(true)
      expect(granted(yield* decisions([failure]))).toEqual([true])
    }),
  )

  for (const [name, failure] of [
    ["an internal error", internal],
    ["an overload", overloaded()],
  ] as const) {
    it.effect(`spaces ten retries from 0.5 to 32 seconds apart after ${name}, then stops`, () =>
      Effect.gen(function* () {
        const results = yield* decisions(repeated(failure, 11))
        const waits = delays(results)

        expect(results.slice(0, 10).map((result) => result.retry && result.attempt)).toEqual(
          GAPS.map((_, index) => index + 2),
        )
        for (const [index, gap] of GAPS.entries()) {
          expect(waits[index]).toBeGreaterThanOrEqual(gap * 0.8)
          expect(waits[index]).toBeLessThanOrEqual(Math.ceil(gap * 1.2))
        }
        expect(results[10]).toEqual({ retry: false })
      }),
    )
  }

  // The bounds themselves: a draw of 0 and one just under 1 are the shortest and longest delays a gap can get.
  for (const [name, value, factor] of [
    ["shortest", 0, 0.8],
    ["longest", 1 - Number.EPSILON, 1.2],
  ] as const) {
    it.effect(`jitters each gap by 20 percent at the ${name} draw`, () =>
      Effect.gen(function* () {
        const waits = delays(yield* decisions(repeated(internal, 10)).pipe(draw(value)))

        for (const [index, gap] of GAPS.entries()) {
          expect(Math.abs((waits[index] ?? Number.NaN) - gap * factor)).toBeLessThanOrEqual(1)
        }
      }),
    )
  }

  // The provider's retry-after is a floor under the gap, and a bounded one.
  for (const [name, failure] of [
    [
      "a rate limit",
      (retryAfterMs: number) => new AIError({ reason: new RateLimitError({ message: "Slow down", retryAfterMs }) }),
    ],
    [
      "an overload",
      (retryAfterMs: number) =>
        new AIError({ reason: new ProviderInternalError({ message: "Overloaded", retryAfterMs }) }),
    ],
  ] as const) {
    it.effect(`uses the larger of the gap and the retry-after of ${name}`, () =>
      Effect.gen(function* () {
        const [larger] = delays(yield* decisions([failure(5_000)]))
        const [smaller] = delays(yield* decisions([failure(100)]))
        const [excessive] = delays(yield* decisions([failure(3_600_000)]))

        expect(larger).toBe(5_000)
        expect(smaller).toBeGreaterThanOrEqual(GAPS[0] * 0.8)
        expect(smaller).toBeLessThanOrEqual(GAPS[0] * 1.2)
        // An hour is more than a session should wait on a provider's say-so; fifteen minutes is the most.
        expect(excessive).toBe(900_000)
      }),
    )
  }

  it.effect("reads the retry-after header of an overloaded reply", () =>
    Effect.gen(function* () {
      expect(delays(yield* decisions([overloaded({ "retry-after": "7" })]))).toEqual([7_000])
    }),
  )
})
