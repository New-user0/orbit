import { Effect } from "effect"
import { Bus } from "@orbit/core/bus"
import { Agent } from "@orbit/core/agent"
import { Model } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionMessage } from "@orbit/core/session/message"
import type { Content } from "@orbit/schema/tool"
import { Money } from "@orbit/schema/money"

/** One tool call of a seeded step. By default it completes with `text`. */
export interface SeededCall {
  readonly id: string
  readonly name: string
  readonly text?: string
  readonly content?: readonly [Content, ...Content[]]
  /** Fails with this message instead of completing. */
  readonly error?: string
  /** A provider-run call, as a hosted web search is. */
  readonly hosted?: boolean
  /** Left running: the call has no result yet. */
  readonly running?: boolean
}

export const fakeModel = { id: Model.ID.make("fake-model"), providerID: Provider.ID.make("fake") }

/**
 * Grows a session's history by publishing the durable events of one step the way the runner does: the assistant message,
 * each call with its result, and the step's end. The step ends at the clock's current time.
 */
export const seedStep = (
  bus: Bus.Interface,
  sessionID: Session.ID,
  input: {
    readonly id: string
    readonly calls: ReadonlyArray<SeededCall>
    /** The prompt tokens the provider reports for the step. */
    readonly inputTokens?: number
    readonly model?: typeof fakeModel
    /** How the step ended; a step that made calls ends with `tool-calls`. */
    readonly finish?: "stop" | "tool-calls"
  },
) =>
  Effect.gen(function* () {
    const assistantMessageID = SessionMessage.ID.make(input.id)
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      agent: Agent.ID.make("build"),
      model: input.model ?? fakeModel,
      started: 0,
    })
    for (const call of input.calls) {
      const executed = call.hosted === true
      yield* bus.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        id: call.id,
        name: call.name,
      })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, { sessionID, assistantMessageID, id: call.id, text: "{}" })
      yield* bus.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, id: call.id, input: {}, executed })
      if (call.running) continue
      if (call.error !== undefined)
        yield* bus.publish(SessionEvent.Tool.Failed, {
          sessionID,
          assistantMessageID,
          id: call.id,
          error: { type: "tool.failed", message: call.error },
          executed,
        })
      else
        yield* bus.publish(SessionEvent.Tool.Success, {
          sessionID,
          assistantMessageID,
          id: call.id,
          content: call.content ?? [{ type: "text", text: call.text ?? `result of ${call.id}` }],
          executed,
        })
    }
    yield* bus.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      finish: input.finish ?? "tool-calls",
      cost: Money.USD.zero,
      tokens: {
        input: input.inputTokens ?? 100,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    })
    return assistantMessageID
  })
