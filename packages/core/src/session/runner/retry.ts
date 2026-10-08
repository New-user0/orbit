/**
 * Decides whether a failed model request is sent again, and after how long.
 *
 * Only foreground work retries an overload: a runner step (a subagent's child session included) and compaction. Both
 * go through this policy before every resend, and a plugin's `retry` hook can override each decision.
 *
 * Background calls make exactly one request: session titles (`SessionTitle`), `SideQuery` and
 * `SessionGenerate.generate`, with whatever is built on it, keep-alive warming among them. None is the step of a
 * session that a person is watching, and a resend would add load to a provider that is already shedding it. If a background call ever retries other failures, it must still
 * leave overloads out; `isOverloaded` from `@orbit/ai` tells them apart.
 */
export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@orbit/ai"
import { Agent } from "@orbit/schema/agent"
import { Model } from "@orbit/schema/model"
import { SessionError } from "@orbit/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a session for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

const retryAfter = (input: Input) => {
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  return undefined
}

// Exponential from 500ms capped at 32s per gap, for 10 retries: 0.5, 1, 2, 4, 8, 16, then 32 × 4, about 160s of
// waiting when every attempt fails (128–191s with jitter). `min` takes the faster schedule, so the
// cap applies per gap; `max` with `recurs` bounds the count.
const schedule = Schedule.max([
  Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("32 seconds")]),
  Schedule.recurs(10),
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  Schedule.modifyDelay(({ input, duration: delay }) => {
    const minimum = retryAfter(input)
    const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
    return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
  }),
)

// A timed-out attempt has already waited out a watchdog (`headerTimeout` or `chunkTimeout`) before it failed: 5 minutes
// on HTTP routes and 30 on WebSocket routes unless the provider sets its own, and as little as 90 seconds where the
// provider sends keepalives. The general allowance would let a dead provider hold a step for close to an hour at the
// 5-minute end, so cap those attempts well below it.
const MAX_TIMEOUT_RETRIES = 3

// The HTTP routes report their header, idle and whole-request limits as "Timeout" and the WebSocket route reports its
// idle limit as "idle-timeout"; the AI SDK path maps its own watchdogs to "Timeout" (`networkFailure` in aisdk.ts).
const isTimeout = (error: AIError) =>
  error.reason._tag === "Transport" && (error.reason.code === "Timeout" || error.reason.code === "idle-timeout")

export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    let attempt = 1
    let timeouts = 0
    return (input: Input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        if (isTimeout(input.cause)) timeouts++
        const delay = Math.ceil(Duration.toMillis(duration))
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          decision: input.retry && timeouts <= MAX_TIMEOUT_RETRIES ? { retry: true, delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0 ? Math.ceil(event.decision.delay) : delay
        return { retry: true as const, attempt, delay: normalized }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
