import { describe, expect, test } from "bun:test"
import { SessionRehydration } from "@orbit/core/session/rehydration"
import { FileLedger } from "@orbit/core/file-ledger"
import { LanguageModel, LLMClient, LLMEvent } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { Location } from "@orbit/core/location"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionCompaction } from "@orbit/core/session/compaction"
import { SessionContextWindow } from "@orbit/core/session/context-window"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionModelRequest } from "@orbit/core/session/model-request"
import { SessionReminders } from "@orbit/core/session/reminders"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { Money } from "@orbit/schema/money"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { stubSnapshot } from "./lib/tool"

// context-memory-1: automatic compaction starts at the effective window (the window less the summary's output room,
// the smaller of the output cap and 20,000) less the buffer (13,000 unless configured), and never below half the window.
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

const model = LanguageModel.make({ id: "window-model", provider: "test-provider", route: OpenAIChat.route })
const session = Session.Info.make({
  id: Session.ID.make("ses_context_window"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})

type Limit = { readonly context: number; readonly input?: number; readonly output: number }

/** A context whose latest response reported `tokens` of prompt. */
const loaded = (limit: Limit, tokens: number, outputTokenCap?: number) => ({
  session,
  model: SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit,
  }),
  messages: [
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.make("msg_context_window"),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "window-model", providerID: "test-provider" },
      content: [],
      tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    }),
  ],
  agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
  initial: "",
  tools: stubSnapshot({ definitions: [], execute: () => Effect.die("unused") }),
  outputTokenCap,
})

const window200k = { context: 200_000, output: 32_000 }

describe("automatic compaction threshold", () => {
  for (const row of [
    { name: "keeps 20,000 for the summary and compacts 13,000 below that", limit: window200k, threshold: 167_000 },
    { name: "uses the configured buffer in place of 13,000", limit: window200k, buffer: 3_000, threshold: 177_000 },
    { name: "keeps only the output cap free when the cap is lower", limit: window200k, cap: 8_000, threshold: 179_000 },
    { name: "keeps a small output limit free", limit: { context: 200_000, output: 4_096 }, threshold: 182_904 },
    {
      name: "keeps 20,000 free when the output limit is unknown",
      limit: { context: 200_000, output: 0 },
      threshold: 167_000,
    },
    {
      name: "measures the input limit when the model has one",
      limit: { context: 400_000, input: 272_000, output: 128_000 },
      threshold: 239_000,
    },
    {
      name: "never compacts a 40,000-token window below half of it",
      limit: { context: 40_000, output: 32_000 },
      threshold: 20_000,
    },
    {
      name: "keeps half of a window whose output limit fills it",
      limit: { context: 16_384, output: 16_384 },
      threshold: 8_192,
    },
    {
      name: "keeps half of a small window whose output limit is unknown",
      limit: { context: 16_384, output: 0 },
      threshold: 8_192,
    },
    {
      name: "keeps half of an 8,192-token window whose output limit is unknown",
      limit: { context: 8_192, output: 0 },
      threshold: 4_096,
    },
    {
      name: "floors a buffer that would compact below half the window",
      limit: window200k,
      buffer: 150_000,
      threshold: 100_000,
    },
  ])
    it.live(`${row.name}: ${row.threshold}`, () =>
      Effect.gen(function* () {
        const compaction = yield* SessionCompaction.Service
        // Set on every row, so a buffer one row configured never reaches the next.
        yield* compaction.transform((editor) => editor.configure({ buffer: row.buffer }))
        // What the local estimate adds to the reported usage, so the rows below sit exactly on the threshold.
        const extra = SessionCompaction.estimateContext(loaded(row.limit, 1, row.cap)) - 1
        const due = (tokens: number) =>
          compaction
            .compact({ reason: "auto", context: loaded(row.limit, tokens - extra, row.cap) })
            .pipe(Effect.map((outcome) => outcome.status !== "skipped"))

        expect(yield* due(row.threshold - 1)).toBe(false)
        expect(yield* due(row.threshold)).toBe(true)
      }),
    )

  it.live("never compacts automatically when the window is unknown", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      expect(
        yield* compaction.compact({ reason: "auto", context: loaded({ context: 0, output: 32_000 }, 1_000_000) }),
      ).toEqual({ status: "skipped" })
    }),
  )
})

describe("context state", () => {
  const found = SessionContextWindow.thresholds({ limit: { context: 200_000, output: 32_000 } })
  if (!found) throw new Error("a 200,000-token window has thresholds")

  // The warning band starts exactly 20,000 below the point the percentage counts down to.
  for (const [used, auto, percentLeft, state] of [
    [146_999, true, 12, "ok"],
    [147_000, true, 12, "error"],
    [159_999, false, 11, "ok"],
    [160_000, false, 11, "error"],
    // Past the point, the indicator stops at zero rather than going negative.
    [250_000, true, 0, "error"],
  ] as const)
    test(`${used} used with automatic compaction ${auto} is ${state}`, () => {
      expect(SessionContextWindow.state(used, found, auto)).toEqual({ percentLeft, state })
    })

  // The target a compaction aims at must stay positive and no smaller than the threshold floor, or a small window would
  // leave the summary the whole window and the indicator a negative size.
  for (const [limit, effective] of [
    [{ context: 16_384, output: 16_384 }, 8_192],
    [{ context: 16_384, output: 0 }, 8_192],
    [{ context: 8_192, output: 0 }, 4_096],
    // The half-window bound follows the input limit, not the larger context window.
    [{ context: 100_000, input: 16_384, output: 0 }, 8_192],
  ] as const)
    test(`keeps the effective window of ${limit.context} tokens with an output limit of ${limit.output} at ${effective}`, () => {
      expect(SessionContextWindow.thresholds({ limit })?.effective).toBe(effective)
    })

  test("refuses a request no earlier than the compaction threshold", () => {
    expect(SessionContextWindow.thresholds({ limit: { context: 40_000, output: 32_000 } })).toEqual({
      window: 40_000,
      effective: 20_000,
      threshold: 20_000,
      blocking: 20_000,
    })
    expect(found.blocking).toBe(177_000)
  })
})
