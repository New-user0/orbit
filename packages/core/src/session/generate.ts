export * as SessionGenerate from "./generate.js"

import { LLMClient, Message, type AIError } from "@orbit/ai"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionContext } from "./context.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionModelRequest } from "./model-request.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionEvent } from "./event.js"
import type { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"

export type Error = AgentNotFoundError | Instructions.InitializationBlocked | SessionRunnerModel.Error | AIError

/**
 * The settled Session history as the start of a request for `model`, without mutating the Session. Generation and
 * side queries share it, so both see the same transcript and pending instruction update.
 */
export const transcript = Effect.fn("SessionGenerate.transcript")(function* (
  selection: SessionContext.Selection,
  model: SessionRunnerModel.Resolved,
) {
  const database = yield* Database.Service
  const history = yield* SessionHistory.preview(
    database.db,
    selection.session.id,
    selection.instructions,
    SessionProviderContext.provenance(model) ?? "local",
  )
  const base = SessionModelRequest.baseTranscript({
    agent: selection.agent.info,
    model,
    tools: selection.tools,
    initial: history.initial,
    messages: history.messages,
  })
  return {
    system: base.system,
    messages: [...base.messages, ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : [])],
  }
})

/** Generates text from current Session context without mutating the Session. */
export const generate = Effect.fn("SessionGenerate.generate")(function* (input: {
  session: SessionSchema.Info
  prompt: string
}) {
  const bus = yield* Bus.Service
  const instances = yield* Instance.Service
  const llm = yield* LLMClient.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const context = yield* SessionContext.Service
    const selection = yield* context.select(input.session.id)
    const model = yield* context.resolveModel(selection.session)
    const history = yield* transcript(selection, model)
    const prepared = yield* context.request.generate({
      session: selection.session,
      agent: selection.agent.id,
      model,
      tools: selection.tools,
      system: history.system,
      messages: [...history.messages, Message.user(input.prompt)],
    })
    yield* Effect.logInfo("sending session generation request", {
      sessionID: selection.session.id,
      providerID: model.ref.providerID,
      modelID: model.ref.id,
    })
    const response = yield* llm.generate(prepared.request, prepared.options)
    yield* Effect.logInfo("session generation usage diagnostic", { usage: response.usage })
    // The provider billed the call, so it lands on the Session before the text is returned and counts toward the
    // limits of the turn it runs in.
    yield* bus
      .publish(SessionEvent.SideQueryRecorded, {
        sessionID: selection.session.id,
        purpose: "session.generate",
        ...SessionUsage.record(response.usage, model.cost),
      })
      .pipe(Effect.uninterruptible)
    return response.text
  }).pipe(instances.provide(input.session))
})
