import { describe, expect } from "bun:test"
import { SessionRehydration } from "@orbit/core/session/rehydration"
import { FileLedger } from "@orbit/core/file-ledger"
import { LanguageModel, LLMClient, LLMEvent } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigCompactionPlugin } from "@orbit/core/config/plugin/compaction"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { SessionContextWindow } from "@orbit/core/session/context-window"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { SessionCompaction } from "@orbit/core/session/compaction"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionModelRequest } from "@orbit/core/session/model-request"
import { SessionReminders } from "@orbit/core/session/reminders"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { Session } from "@orbit/core/session"
import { Agent } from "@orbit/core/agent"
import { Location } from "@orbit/core/location"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { ConfigCompaction } from "@orbit/schema/config/compaction"
import { Document, Event, Info } from "@orbit/schema/config"
import { Money } from "@orbit/schema/money"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { stubSnapshot } from "../lib/tool"
import { host } from "../plugin/host"

const model = LanguageModel.make({
  id: "test-model",
  provider: "test-provider",
  route: OpenAIChat.route,
})
const limit = { context: 100_000, output: 1_000 }
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit,
})
const config = Config.testLayer()
const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(LayerNode.group([SessionCompaction.node, SessionModelRequest.node, Config.node, Bus.node]), [
      llmClient.replace(
        Layer.mock(LLMClient.Service)({
          stream: () => Stream.make(LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summary" })),
        }),
      ),
      Config.node.replace(config),
      SessionReminders.node.replace(SessionReminders.configured(SessionReminders.production)),

      // No files, jobs or plan to restore here; session-rehydration.test.ts covers them.

      SessionRehydration.node.replace(SessionRehydration.noopLayer),

      FileLedger.node.replace(FileLedger.permissiveLayer),
    ]),
  ),
)
describe("ConfigCompactionPlugin.Plugin", () => {
  it.live("merges settings and reloads changed config", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      // An automatic compaction that is not due is skipped.
      const due = (input: typeof nearInput) =>
        compaction
          .compact({ reason: "auto", context: input.context })
          .pipe(Effect.map((outcome) => outcome.status !== "skipped"))
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: false, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              buffer: 10_000,
              keep: new ConfigCompaction.Keep({ tokens: 0 }),
            }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      expect(yield* due(nearInput)).toBe(false)
      const ended = yield* bus
        .subscribe(SessionEvent.Compaction.Ended)
        .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      const messages = [
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Older context",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        SessionMessage.User.make({
          id: SessionMessage.ID.create(),
          type: "user",
          text: "Recent context",
          time: { created: DateTime.makeUnsafe(1) },
        }),
      ]
      expect(
        yield* compaction.compact({
          reason: "manual",
          context: { ...nearInput.context, messages },
          inputID: SessionMessage.ID.make("msg_compaction_manual"),
        }),
      ).toEqual({ status: "completed" })
      // A summary keeps no recent text; `keep` shapes native compaction only.
      expect(Option.getOrThrow(yield* Fiber.join(ended)).data.recent).toBe("")

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ buffer: 10_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (yield* due(nearInput)) return
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
      })
      expect(yield* due(bufferedInput)).toBe(false)

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* due(bufferedInput)) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
    }),
  )
})

// context-memory-3 (class 7): a file's compaction.clear is decoded where it enters, and a malformed value costs only itself.
describe("compaction.clear", () => {
  const options = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
  const document = (raw: unknown) => {
    const normalized = ConfigNormalize.normalize(raw)
    if (normalized.type !== "normalized") throw new Error("expected a normalized config")
    return {
      diagnostics: normalized.diagnostics.map((item) => [item.kind, item.path]),
      entry: new Document({ type: "document", info: Schema.decodeUnknownSync(Info, options)(normalized.encoded) }),
    }
  }
  const applied = (settings: () => ReturnType<SessionCompaction.Interface["thresholds"]>, expected: boolean) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (settings().clear === expected) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
    })

  it.live("decodes compaction.clear and lets a malformed value cost only itself", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      const context = nearInput.context
      const settings = () => compaction.thresholds(context)
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))
      // Left alone, clearing is on.
      expect(settings().clear).toBe(true)

      const off = document({ compaction: { clear: false } })
      expect(off.diagnostics).toEqual([])
      yield* config.setEntries([off.entry])
      yield* bus.publish(Event.Updated, {})
      yield* applied(settings, false)

      const malformed = document({ compaction: { clear: "no", buffer: 2_000 } })
      expect(malformed.diagnostics).toEqual([["invalid", ["compaction", "clear"]]])
      yield* config.setEntries([malformed.entry])
      yield* bus.publish(Event.Updated, {})
      yield* applied(settings, true)
      // The buffer beside it still applied.
      expect(settings().thresholds?.threshold).toBe(
        SessionContextWindow.thresholds({
          limit: context.model.limit,
          outputTokenCap: undefined,
          buffer: 2_000,
        })?.threshold,
      )
    }),
  )
})

const session = Session.Info.make({
  id: Session.ID.make("ses_compaction_config"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})
const input = (tokens: number) => {
  const messages = [
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.make("msg_compaction_config"),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "test-model", providerID: "test-provider" },
      content: [],
      tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    }),
  ]
  return {
    session,
    resolved,
    messages,
    context: {
      session,
      model: resolved,
      messages,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      initial: "",
      tools: stubSnapshot({ definitions: [], execute: () => Effect.die("unused") }),
    },
  }
}
const bufferedInput = input(85_000)
const nearInput = input(95_000)
