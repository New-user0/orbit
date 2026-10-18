export * as SessionTitle from "./title.js"

import { withoutReplaced } from "./runner/to-llm-message.js"
import { isDeepStrictEqual } from "node:util"
import { LLMClient, LLMEvent, Message, SystemPart } from "@orbit/ai"
import { Agent } from "../agent.js"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { isExactRootFallback } from "@orbit/util/session-title-fallback"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionCompaction } from "./compaction.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"
import { SessionStore } from "./store.js"
import { Token } from "../util/token.js"

const MAX_LENGTH = 100
const MAX_CONTEXT_LENGTH = 8_000
const MAX_FIRST_MESSAGE_LENGTH = 2_000
const titleChanged = Symbol("Session title changed")

export interface Interface {
  /** Generates an initial title or regenerates one from bounded conversation history. */
  readonly generate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionTitle") {}

const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)
export const isUntitled = (session: SessionSchema.Info) =>
  isExactRootFallback({
    title: session.title,
    time: { created: DateTime.toEpochMillis(session.time.created) },
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const context = yield* SessionContext.Service
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db

    const attempt = Effect.fn("SessionTitle.attempt")(function* (input: {
      readonly session: SessionSchema.Info
      readonly agent: Agent.Info
      readonly text: string
      readonly model: SessionRunnerModel.Resolved
    }) {
      const chunks: string[] = []
      let failed = false
      let usage: SessionUsage.Recorded | undefined
      let observed = false
      let streamedLength = 0
      const prepared = yield* context.request.title({
        session: input.session,
        agent: input.agent.id,
        model: input.model,
        system: input.agent.system ? [SystemPart.make(input.agent.system)] : [],
        messages: [Message.user(input.text)],
      })
      if (prepared.event.result !== undefined) return prepared.event.result
      // A call that failed or was interrupted after the response began was probably billed, though its usage never
      // arrived: an estimate keeps it from reading as free. A request the provider refused outright billed nothing.
      const recordUsage = (unfinished: boolean) =>
        Effect.suspend(() => {
          const spent =
            usage ??
            (unfinished && observed
              ? SessionUsage.estimate(input.model.cost, {
                  input: SessionCompaction.estimateRequest(prepared.request),
                  output: Token.estimateLength(streamedLength),
                })
              : undefined)
          return spent
            ? bus.publish(SessionEvent.UsageRecorded, { sessionID: input.session.id, source: "title", ...spent })
            : Effect.void
        })
      yield* llm.stream(prepared.request, prepared.options).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          else observed = true
          if (LLMEvent.is.textDelta(event)) {
            chunks.push(event.text)
            streamedLength += event.text.length
          }
          if (LLMEvent.is.stepFinish(event)) {
            const step = SessionUsage.record(event.usage, input.model.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
          }
          return Effect.void
        }),
        Effect.catchTag("AI.Error", () =>
          Effect.sync(() => {
            failed = true
          }),
        ),
        Effect.onInterrupt(() => recordUsage(true)),
      )
      yield* recordUsage(failed)
      if (failed) return
      return chunks
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
    })

    const generate = Effect.fn("SessionTitle.generate")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return
      const firstUser = yield* SessionHistory.firstUserMessage(db, session.id)
      if (!firstUser) return
      const text = !isUntitled(session)
        ? yield* store.context(session.id).pipe(
            Effect.map((messages) => {
              const original = `Original request:\n${firstUser.text.slice(0, MAX_FIRST_MESSAGE_LENGTH)}`
              const recent = withoutReplaced(messages)
                .flatMap((message) => {
                  if (message.type === "user" && message.id !== firstUser.id) return [`User: ${message.text.trim()}`]
                  if (message.type !== "assistant") return []
                  const text = message.content
                    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
                    .filter(Boolean)
                    .join("\n")
                  return text ? [`Assistant: ${text}`] : []
                })
                .join("\n\n")
              if (!recent) return original
              const prefix = `${original}\n\nRecent conversation:\n`
              return `${prefix}${recent.slice(-(MAX_CONTEXT_LENGTH - prefix.length))}`
            }),
            Effect.orElseSucceed(() => firstUser.text),
          )
        : firstUser.text
      const selection = yield* context.selectAuxiliary(session, Agent.ID.make("title"))
      if (!selection) return
      const title =
        (yield* attempt({ session, agent: selection.agent, text, model: selection.selected })) ??
        (selection.primary && !isDeepStrictEqual(selection.selected.ref, selection.primary.ref)
          ? yield* attempt({ session, agent: selection.agent, text, model: selection.primary })
          : undefined)
      if (!title) return
      const expectedSequence = (yield* Bus.latestSequence(db, sessionID)) + 1
      const current = yield* store.get(sessionID)
      if (!current || current.title !== session.title || current.title === truncate(title)) return
      yield* bus
        .publish(
          SessionEvent.Renamed,
          {
            sessionID: session.id,
            title: truncate(title),
          },
          { commit: (sequence) => (sequence === expectedSequence ? Effect.void : Effect.die(titleChanged)) },
        )
        .pipe(Effect.catchDefect((defect) => (defect === titleChanged ? Effect.void : Effect.die(defect))))
    })
    return Service.of({ generate })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, SessionContext.node, SessionStore.node, Database.node],
})
