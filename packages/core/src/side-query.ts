export * as SideQuery from "./side-query.js"

import { LLMClient, LLMRequest, Message, SystemPart, Tool, ToolChoice, toDefinitions } from "@orbit/ai"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { Agent } from "./agent.js"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { Instance } from "./instance/service.js"
import type { Model } from "./model.js"
import { Plugin } from "./plugin/service.js"
import { SessionContext } from "./session/context.js"
import { SessionEvent } from "./session/event.js"
import { SessionGenerate } from "./session/generate.js"
import type { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { SessionUsage } from "./session/usage.js"
import { llmClient } from "./effect/app-node-platform.js"

/**
 * What a side query is for. It annotates the span and the usage event, and callers add their own literal when they
 * start using the service.
 */
export type Purpose =
  | "webfetch.summarize"
  | "permission.classify"
  | "permission.explain"
  | "hook.prompt"
  | "memory.recall"
  | "memory.extract"
  | "session.away_summary"

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("SideQuery.UnavailableError", {
  message: Schema.String,
}) {}

export class InvalidOutputError extends Schema.TaggedError<InvalidOutputError>()("SideQuery.InvalidOutputError", {
  message: Schema.String,
}) {}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()("SideQuery.TimeoutError", {
  message: Schema.String,
}) {}

/** A side query never fails its Session; callers degrade on any of these. */
export type Error = UnavailableError | InvalidOutputError | TimeoutError

export interface TextInput {
  readonly sessionID: SessionSchema.ID
  readonly purpose: Purpose
  /** Instructions for the model. With `history`, they follow the Session's own system prompt. */
  readonly system: string
  readonly prompt: string
  /** `small` (default) prefers the small model of the Session's provider; `primary` uses the Session's model. */
  readonly model?: "small" | "primary"
  /** Sends the Session's settled transcript before the prompt. Off by default. */
  readonly history?: boolean
  /** Defaults to 30 seconds. */
  readonly timeout?: Duration.Duration
}

export interface ObjectInput<S extends Tool.ToolSchema<any>> extends TextInput {
  readonly schema: S
}

export interface Interface {
  /** Runs one non-streaming call and returns its text. */
  readonly text: (input: TextInput) => Effect.Effect<{ readonly text: string; readonly model: Model.Ref }, Error>
  /**
   * Runs one non-streaming call that must answer through a single forced tool call, decoded with `schema`. The call
   * is never executed. A missing or undecodable call is an `InvalidOutputError`.
   */
  readonly object: <S extends Tool.ToolSchema<any>>(
    input: ObjectInput<S>,
  ) => Effect.Effect<{ readonly value: Schema.Schema.Type<S>; readonly model: Model.Ref }, Error>
}

/**
 * Session-attributed one-shot model calls. Unlike `Generate`, which is sessionless and location-scoped, the model
 * follows the Session's provider, the transcript is optional, the output may be structured, and the usage lands on
 * the Session. Plugin `generate` hooks scoped to the `side` agent see these requests.
 */
export class Service extends Context.Service<Service, Interface>()("@orbit/SideQuery") {}

const SIDE = Agent.ID.make("side")
const RESULT_TOOL = "side_query_result"
const DEFAULT_TIMEOUT = Duration.seconds(30)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const database = yield* Database.Service
    const instances = yield* Instance.Service
    const llm = yield* LLMClient.Service
    const store = yield* SessionStore.Service

    const send = Effect.fn("SideQuery.send")(function* (input: TextInput, tool: Tool.AnyTool | undefined) {
      yield* Effect.annotateCurrentSpan({ "side_query.purpose": input.purpose, "session.id": input.sessionID })
      const session = yield* store.get(input.sessionID)
      if (!session) return yield* new UnavailableError({ message: `Session not found: ${input.sessionID}` })
      const timeout = input.timeout ?? DEFAULT_TIMEOUT
      return yield* Effect.gen(function* () {
        yield* Plugin.awaitActivation
        const context = yield* SessionContext.Service
        const auxiliary = yield* context.selectAuxiliary(session, SIDE)
        const model = input.model === "primary" ? auxiliary?.primary : auxiliary?.selected
        if (!model) return yield* new UnavailableError({ message: "No model is available for a side query" })
        const history = input.history
          ? yield* SessionGenerate.transcript(yield* context.select(session.id), model)
          : undefined
        const prepared = yield* context.request.generate({
          session,
          agent: SIDE,
          model,
          system: [...(history?.system ?? []), ...(input.system ? [SystemPart.make(input.system)] : [])],
          messages: [...(history?.messages ?? []), Message.user(input.prompt)],
        })
        const request = tool
          ? LLMRequest.update(prepared.request, {
              tools: toDefinitions({ [RESULT_TOOL]: tool }),
              toolChoice: ToolChoice.named(RESULT_TOOL),
            })
          : prepared.request
        const response = yield* llm.generate(request, prepared.options).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new TimeoutError({
                  message: `Side query ${input.purpose} timed out after ${Duration.format(timeout)}`,
                }),
              ),
          }),
        )
        // Recorded before the output is decoded: the provider billed the call whether or not it is usable.
        const usage = SessionUsage.record(response.usage, model.cost)
        yield* bus.publish(SessionEvent.SideQueryRecorded, {
          sessionID: session.id,
          purpose: input.purpose,
          ...usage,
        })
        return { response, model: model.ref }
      }).pipe(
        instances.provide(session),
        Effect.provideService(Database.Service, database),
        // Whatever else goes wrong, the caller can only degrade, so it sees one error.
        Effect.mapError((error) =>
          error instanceof UnavailableError || error instanceof TimeoutError
            ? error
            : new UnavailableError({ message: error.message }),
        ),
      )
    })

    const text: Interface["text"] = Effect.fn("SideQuery.text")(function* (input) {
      const result = yield* send(input, undefined)
      return { text: result.response.text, model: result.model }
    })

    const object: Interface["object"] = Effect.fn("SideQuery.object")(function* (input) {
      const tool = Tool.make({
        description: "Return the structured result by calling this tool.",
        parameters: input.schema,
        success: Schema.Unknown,
      })
      const result = yield* send(input, tool)
      const call = result.response.toolCalls.find((event) => event.name === RESULT_TOOL)
      if (!call) return yield* new InvalidOutputError({ message: `Model did not call the ${RESULT_TOOL} tool` })
      const value = yield* tool
        ._decode(call.input)
        .pipe(
          Effect.mapError(
            (error) => new InvalidOutputError({ message: `Tool input failed schema decode: ${error.message}` }),
          ),
        )
      return { value, model: result.model }
    })

    return Service.of({ text, object })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, Instance.node, SessionStore.node, llmClient],
})
