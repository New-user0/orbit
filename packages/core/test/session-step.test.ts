import { expect } from "bun:test"
import { LanguageModel, LLM, LLMEvent } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols/openai-chat"
import { TestLLM } from "@orbit/ai/testing"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { EventTable } from "@orbit/core/event/sql"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionStep } from "@orbit/core/session/runner/step"
import { SessionMessageTable, SessionTable } from "@orbit/core/session/sql"
import { Snapshot } from "@orbit/core/snapshot"
import { ToolOutput } from "@orbit/core/tool-output"
import { ToolTraits } from "@orbit/core/tool/traits"
import { Money } from "@orbit/schema/money"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, Bus.node, Config.node, SessionProjector.node, ToolOutput.node]),
      [Config.node.replace(Config.testLayer()), Bus.node.replace(Bus.configured({ persist: true }))],
    ),
    TestLLM.testLayer(),
  ),
)

for (const fixture of [
  { finish: "stop", toolChoice: undefined },
  { finish: "content-filter", toolChoice: undefined },
  { finish: "stop", toolChoice: "none" },
] as const) {
  it.effect(`settles ${fixture.finish} with tool choice ${fixture.toolChoice ?? "default"}`, () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const llm = yield* TestLLM.Test
      const sessionID = Session.ID.create()
      const assistantMessageID = SessionMessage.ID.create()
      const start = Snapshot.ID.make("before")
      const end = Snapshot.ID.make("after")
      const files = [RelativePath.make("changed.ts")]
      let captures = 0
      let executions = 0
      const steps = yield* SessionStep.make.pipe(
        Effect.provide(
          Layer.mock(Snapshot.Service)({
            capture: () => Effect.sync(() => (captures++ === 0 ? start : end)),
            files: (input) => {
              expect(input).toEqual({ from: start, to: end })
              return Effect.succeed(files)
            },
          }),
        ),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
        .run()
      const model = SessionRunnerModel.resolved(
        LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
        {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 100_000, output: 1_000 },
          cost: [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(2),
              cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
            },
          ],
        },
      )
      yield* llm.push(
        TestLLM.complete(
          {
            reason: { normalized: fixture.finish },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          },
          LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
        ),
      )
      const result = yield* steps
        .attempt({
          isLocationClosed: () => false,
          sessionID,
          assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            retry: () => Effect.void,
            escalation: false,
            request: LLM.request({ model: model.model, prompt: "Run one tool", toolChoice: fixture.toolChoice }),
            options: {},
            executeTool: () =>
              Effect.sync(() => {
                executions++
                return { content: [{ type: "text", text: "Completed tool" }] }
              }),
            toolTraits: () => Effect.succeed(ToolTraits.defaults),
            describeTool: () => undefined,
          },
          retry: (_cause, _error, retry) =>
            Effect.succeed(retry ? { retry: true, attempt: 2, delay: 0 } : { retry: false }),
          recoverContinuation: true,
          recoverOverflow: Effect.succeed(false),
        })
        .pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.finish === "stop")
      expect(executions).toBe(fixture.toolChoice === "none" ? 0 : 1)
      if (Exit.isSuccess(result))
        expect(result.value).toEqual(
          SessionStep.Outcome.Completed({ needsContinuation: fixture.toolChoice !== "none" }),
        )
      expect(yield* llm.requests()).toHaveLength(1)
      expect(captures).toBe(2)
      const message = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
      expect(message?.data).toMatchObject({
        finish: fixture.finish,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
        snapshot: { start, end, files },
        content: [
          {
            type: "tool",
            state:
              fixture.toolChoice === "none"
                ? {
                    status: "error",
                    error: { type: "tool.disabled", message: "Tools are disabled after the maximum agent steps" },
                  }
                : { status: "completed" },
          },
        ],
      })
      expect(message?.data).toHaveProperty("cost", expect.closeTo(0.0000233, 10))
      const events = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
      const types = events.map((event) => event.type)
      const terminal = fixture.finish === "stop" ? "session.step.ended.1" : "session.step.failed.1"
      expect(types.filter((type) => type === "session.step.streamed.1")).toHaveLength(1)
      expect(types.filter((type) => type === terminal)).toHaveLength(1)
      expect(types.indexOf("session.step.streamed.1")).toBeLessThan(types.indexOf(terminal))
      expect(
        types.indexOf(fixture.toolChoice === "none" ? "session.tool.failed.2" : "session.tool.success.2"),
      ).toBeLessThan(types.indexOf(terminal))
    }),
  )
}

const runCutOff = (finish: "length" | "unknown", calls: "input" | "partial-call") =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const llm = yield* TestLLM.Test
    const sessionID = Session.ID.create()
    const assistantMessageID = SessionMessage.ID.create()
    const steps = yield* SessionStep.make.pipe(
      Effect.provide(
        Layer.mock(Snapshot.Service)({ capture: () => Effect.succeed(undefined), files: () => Effect.succeed([]) }),
      ),
    )
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, slug: "limit", directory: "/project", version: "test" })
      .run()
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 100_000, output: 1_000 },
        cost: [],
      },
    )
    yield* llm.push(
      TestLLM.complete(
        { reason: finish === "length" ? { normalized: "length", raw: "max_tokens" } : { normalized: "unknown" } },
        LLMEvent.toolInputStart({ id: "call-cut", name: "test" }),
        LLMEvent.toolInputDelta({ id: "call-cut", name: "test", text: '{"a":' }),
        ...(calls === "partial-call"
          ? [LLMEvent.toolCall({ id: "call-cut", name: "test", input: { a: 1 }, partialInput: true })]
          : []),
      ),
    )
    let executions = 0
    const result = yield* steps.attempt({
      isLocationClosed: () => false,
      sessionID,
      assistantMessageID,
      agent: Agent.defaultID,
      model,
      prepared: {
        retry: () => Effect.void,
        escalation: false,
        request: LLM.request({ model: model.model, prompt: "Run one tool" }),
        options: {},
        executeTool: () =>
          Effect.sync(() => {
            executions++
            return { content: [{ type: "text", text: "ran" }] }
          }),
        toolTraits: () => Effect.succeed(ToolTraits.defaults),
        describeTool: () => undefined,
      },
      retry: () => Effect.succeed({ retry: false }),
      recoverContinuation: true,
      recoverOverflow: Effect.succeed(false),
    }).pipe(Effect.exit)
    const events = yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
    return { result, executions, events, types: events.map((event) => event.type) }
  })

it.effect("fails inputs that never became calls when the response stops at the output limit", () =>
  Effect.gen(function* () {
    const run = yield* runCutOff("length", "input")
    // Nothing ran, so the cut-off input alone must not start another step.
    expect(run.result).toEqual(Exit.succeed(SessionStep.Outcome.OutputLimited({ needsContinuation: false, toolCalled: false })))
    expect(run.executions).toBe(0)
    expect(run.types.indexOf("session.tool.failed.2")).toBeGreaterThan(-1)
    expect(run.types.indexOf("session.tool.failed.2")).toBeLessThan(run.types.indexOf("session.step.ended.1"))
    expect(run.events[run.types.indexOf("session.tool.failed.2")]?.data).toMatchObject({
      error: { type: "tool.input-truncated" },
      executed: false,
    })
    expect(run.events[run.types.indexOf("session.step.ended.1")]?.data).toMatchObject({ finish: "length" })
  }),
)

it.effect("drops a call rebuilt from partial input when the response finishes with an unknown reason", () =>
  Effect.gen(function* () {
    const run = yield* runCutOff("unknown", "partial-call")
    expect(run.executions).toBe(0)
    expect(run.types).not.toContain("session.tool.success.2")
    // Only an output limit is recorded as truncated; this fails with the response's own error.
    const failed = run.events[run.types.indexOf("session.tool.failed.2")]?.data
    expect(failed).toMatchObject({ executed: false })
    expect(failed).toMatchObject({ error: { type: "provider.invalid-output" } })
    expect(Exit.isFailure(run.result)).toBe(true)
  }),
)
