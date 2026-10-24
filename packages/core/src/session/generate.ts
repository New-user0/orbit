export * as SessionGenerate from "./generate.js"

import { LLMClient, Message, type AIError } from "@orbit/ai"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import type { Instructions } from "../instructions/index.js"
import { SessionCompaction } from "./compaction.js"
import { SessionContext } from "./context.js"
import type { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionReminders } from "./reminders.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import { SessionEvent } from "./event.js"
import type { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"
import { ToolOutput } from "../tool-output.js"

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
  const reminders = yield* SessionReminders.Service
  const toolOutput = yield* ToolOutput.Service
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
    minimal: reminders.minimal,
    toolOutput: toolOutput.root,
  })
  return {
    system: base.system,
    messages: [...base.messages, ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : [])],
  }
})

/**
 * The last `count` messages of the settled Session history, lowered for `model` as the runner lowers them, with no
 * system prompt, instructions or system message. Leading assistant replies are skipped, so the window opens on its
 * first user message or tool result, and its tool calls and results are written out as text. A window of assistant
 * replies alone is empty.
 */
export const recent = Effect.fn("SessionGenerate.recent")(function* (
  sessionID: SessionSchema.ID,
  model: SessionRunnerModel.Resolved,
  count: number,
) {
  const database = yield* Database.Service
  const messages = yield* SessionHistory.load(
    database.db,
    sessionID,
    SessionProviderContext.provenance(model) ?? "local",
  )
  // An active assistant may hold a tool call that has no result yet, so only the settled prefix is sent.
  const unsettled = messages.findIndex((message) => message.type === "assistant" && message.time.completed === undefined)
  const window = toLLMMessages(
    unsettled === -1 ? messages : messages.slice(0, unsettled),
    model.ref,
    model.model.route.providerMetadataKey ?? model.model.provider,
  )
    .filter((message) => message.role !== "system")
    .slice(-count)
  // Some providers refuse a conversation that does not open with a user message (Bedrock Converse), so the cut skips
  // leading assistant replies. A tool result may open the window, even one whose call was cut off, because it goes
  // as user text below; cutting it would hide the work before a short prompt such as "continue" from the recap.
  const start = window.findIndex((message) => message.role === "user" || message.role === "tool")
  // The window goes out with no tool definitions, so its tool calls and results go as text.
  return start === -1 ? [] : window.slice(start).map(SessionCompaction.withoutToolBlocks)
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
