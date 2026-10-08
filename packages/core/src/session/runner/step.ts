export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  isOverloaded,
  type ProviderErrorEvent,
  type ToolCall,
} from "@orbit/ai"
import type { Agent } from "@orbit/schema/agent"
import { Cause, Clock, Data, Effect, Exit, Fiber, Option, Stream } from "effect"
import { SessionError } from "@orbit/schema/session-error"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { Database } from "../../database/database.js"
import { ConfigToolExecution } from "@orbit/schema/config/tool-execution"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { Tool } from "../../tool.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"
import { ToolScheduler } from "./tool-scheduler.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  /** The response stopped at the output limit; the runner decides whether to resume it. */
  OutputLimited: {
    readonly needsContinuation: boolean
    /** A tool was called before the cut-off, a provider-hosted one included; such a reply is never repeated. */
    readonly toolCalled: boolean
  }
  Retry: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
    /** Whether the provider reported it was overloaded, which counts toward the fallback switch. */
    readonly overloaded: boolean
  }
  Continue: {
    readonly error: SessionError.Error
    readonly decision: SessionRunnerRetry.Decision
    readonly overloaded: boolean
  }
  RecoverFull: {}
  Compacted: {}
}>
export const Outcome = Data.taggedEnum<Outcome>()

interface Input {
  readonly isLocationClosed: () => boolean
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: Omit<SessionModelRequest.Prepared, "event">
  readonly retry: (
    cause: AIError,
    error: SessionError.Error,
    retry: boolean,
  ) => Effect.Effect<{ readonly retry: false } | SessionRunnerRetry.Decision>
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const INPUT_TRUNCATED = {
  type: "tool.input-truncated",
  message: "The response hit its output limit before this tool call was complete, so the call did not run",
} as const
// A call the user's decline keeps from starting settles as aborted, like the declined call; one that a rejection with
// feedback keeps from starting settles as cancelled, so the model can tell it never ran and carry on.
const SKIPPED_AFTER_DECLINE = {
  type: "aborted",
  message: "Not run: the user declined an earlier tool call",
} as const
const SKIPPED_AFTER_REJECTION = {
  type: Tool.ErrorCode.Cancelled,
  message: "Not run: the user rejected an earlier tool call and gave feedback",
} as const
// A failed call whose tool asks for it keeps its siblings from finishing. Both texts name the tool only: the name is
// one the request offered, never text from the call's input or output.
const siblingsStopped = (tool: string) => ({
  running: {
    type: Tool.ErrorCode.Cancelled,
    message: `Cancelled: the ${tool} call that ran alongside this one failed`,
  },
  queued: {
    type: Tool.ErrorCode.Cancelled,
    message: `Not run: an earlier ${tool} call failed before this one could start`,
  },
})
// A new user message settles the calls that can be cancelled as cancelled, so the model sees they never finished.
const STEERED = {
  type: Tool.ErrorCode.Cancelled,
  message: "Cancelled because the user sent a new message",
} as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const config = yield* Config.Service
  const db = (yield* Database.Service).db
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const attempt = Effect.fn("SessionStep.attempt")(function* (input: Input) {
    const startSnapshot = yield* snapshots.capture()
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      snapshot: startSnapshot,
      displayName: (name) => input.prepared.describeTool(name)?.displayName,
      started: yield* Clock.currentTimeMillis,
    })
    const scheduler = ToolScheduler.make<SessionError.Error>({
      maxConcurrency:
        Config.latest(yield* config.entries(), "tool_execution")?.max_concurrency ??
        ConfigToolExecution.DEFAULT_MAX_CONCURRENCY,
      onQueued: (id) => publisher.hint(id, { queued: true }),
      onStarted: (id) => publisher.hint(id, {}),
    })
    // Queued and later calls never start; running ones are interrupted inside their race and settle as cancelled.
    const cancelSiblings = (failed: ToolCall) => {
      const messages = siblingsStopped(failed.name)
      const select = (id: string) => id !== failed.id
      return scheduler
        .cancel({ running: false, future: true, select }, messages.queued)
        .pipe(Effect.andThen(scheduler.cancel({ running: true, future: false, select }, messages.running)))
    }
    // Traits resolve after a call registers, so a steer cancels the calls whose traits are known and each later call
    // checks the flag once its own traits arrive.
    const interruptBehavior = new Map<string, Tool.ResolvedTraits["interruptBehavior"]>()
    let steered = false
    const cancelSteered = scheduler.cancel(
      { running: true, future: false, select: (id) => interruptBehavior.get(id) === "cancel" },
      STEERED,
    )
    // A steer is a user message that the next step boundary delivers; queued and synthetic input cancels nothing.
    yield* bus.subscribe([SessionEvent.InboxEnqueued, SessionEvent.InboxDeliveryChanged]).pipe(
      Stream.filter((event) => event.data.sessionID === input.sessionID),
      Stream.filterEffect((event) =>
        event.type === "session.inbox.enqueued"
          ? Effect.succeed(event.data.item.type === "user" && event.data.item.delivery === "steer")
          : event.data.delivery === "steer"
            ? // A row that is gone has already been delivered.
              SessionInbox.find(db, event.data.inboxID).pipe(Effect.map((item) => item?.type === "user"))
            : Effect.succeed(false),
      ),
      Stream.runForEach(() =>
        Effect.suspend(() => {
          steered = true
          return cancelSteered
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    const toolRuns: Array<{
      readonly call: ToolCall
      readonly fiber: Fiber.Fiber<void, Permission.DeclinedError | QuestionTool.CancelledError>
    }> = []
    const interruptTools = Effect.suspend(() => Fiber.interruptAll(toolRuns.map((run) => run.fiber)))
    const executeTool = (call: ToolCall) => {
      if (input.prepared.request.toolChoice?.type === "none")
        return Effect.fail(
          new Tool.Error({
            message: "Tools are disabled after the maximum agent steps",
            code: Tool.ErrorCode.Disabled,
          }),
        )
      return input.prepared.executeTool({
        sessionID: input.sessionID,
        agent: input.agent,
        messageID: input.assistantMessageID,
        call,
        progress: (update) => publisher.progress(call.id, update),
      })
    }

    // Provider and tool fibers retain per-source order without a shared writer queue.
    // A local execution starts only after its Tool.Called publication completes.
    let overflowFailure: ProviderErrorEvent | undefined
    // Read to the end, not just the finish event, so the next request can reuse this response.
    const providerStream = llm.stream(input.prepared.request, input.prepared.options).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (overflowFailure || publisher.hasProviderError()) return
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            return
          }
          yield* publisher.publish(event)
          if (event.type !== "tool-call" || event.providerExecuted) return
          // Registering in the same uninterruptible block as the fork keeps provider order, and no call is left
          // registered without a fiber that releases it. The scheduler starts the call once its traits allow.
          toolRuns.push({
            call: event,
            fiber: yield* Effect.uninterruptibleMask((restore) => {
              const entry = scheduler.register(event.id)
              // A forked child does not inherit the mask, so keep it: publishing the outcome must not be interrupted.
              return Effect.forkScoped(
                restore(input.prepared.toolTraits(event)).pipe(
                  Effect.tap((traits) =>
                    Effect.suspend(() => {
                      interruptBehavior.set(event.id, traits.interruptBehavior)
                      return steered ? cancelSteered : Effect.void
                    }),
                  ),
                  Effect.flatMap((traits) =>
                    restore(
                      scheduler.run(
                        entry,
                        traits,
                        executeTool(event).pipe(
                          // Only an explicit `metadata.error` on a tool that declares the trait counts as a failure.
                          Effect.tap((result) =>
                            traits.cancelSiblingsOnFailure && result.metadata?.error === true
                              ? cancelSiblings(event)
                              : Effect.void,
                          ),
                          Effect.tapError((error) =>
                            error._tag !== "Tool.Error"
                              ? scheduler.halt(SKIPPED_AFTER_DECLINE)
                              : traits.cancelSiblingsOnFailure && error.metadata?.error === true
                                ? cancelSiblings(event)
                                : Effect.void,
                          ),
                        ),
                      ),
                    ),
                  ),
                  Effect.flatMap((result) =>
                    result._tag === "Cancelled"
                      ? publisher.failTool(event.id, result.error).pipe(Effect.asVoid)
                      : toolOutput
                          .truncate(result.value)
                          .pipe(Effect.flatMap((outcome) => publisher.toolExecution(event.id, event.name, outcome))),
                  ),
                  Effect.catchTag("Tool.Error", (error) =>
                    (hasCorrection(error) ? scheduler.halt(SKIPPED_AFTER_REJECTION) : Effect.void).pipe(
                      Effect.andThen(publisher.failTool(event.id, toSessionError(error), error.metadata)),
                      Effect.asVoid,
                    ),
                  ),
                  Effect.ensuring(scheduler.release(entry)),
                ),
                { uninterruptible: "inherit" },
              )
            }),
          })
        }),
      ),
      Effect.ensuring(publisher.flush()),
    )

    // Keep the final tool and Step events uninterruptible, even when the work itself is cancelled.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stream = yield* restore(providerStream).pipe(Effect.exit)
        const streamFailure = Option.getOrUndefined(Exit.findErrorOption(stream))
        const streamInterrupted = Exit.hasInterrupts(stream)
        if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
        if (streamInterrupted) yield* interruptTools
        const joined = yield* restore(Fiber.awaitAll(toolRuns.map((run) => run.fiber))).pipe(Effect.exit)
        if (Exit.isFailure(joined)) yield* interruptTools
        const tools = classifyToolExits(joined, toolRuns)

        const overflow = overflowFailure ?? streamFailure
        if (
          !publisher.record().outputStarted &&
          isContextOverflowFailure(overflow) &&
          (yield* restore(input.recoverOverflow))
        ) {
          yield* Effect.logWarning("provider rejected the request as too long; compacting", {
            sessionID: input.sessionID,
            model: input.model.ref,
            message: overflow?.message,
          })
          return Outcome.Compacted()
        }

        if (overflowFailure) yield* publisher.publish(overflowFailure)
        const recorded = publisher.record()
        const unknownFinish =
          Exit.isSuccess(stream) && recorded.finish?.finish === "unknown"
            ? new AIError({
                reason: new InvalidProviderOutputError({
                  message: "The provider response ended with an unknown finish reason.",
                  classification: "incomplete-stream",
                }),
              })
            : undefined
        const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
        const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
        if (
          input.recoverContinuation &&
          llmFailure?.reason._tag === "Transport" &&
          (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
          !recorded.outputStarted
        )
          return Outcome.RecoverFull()
        const retry =
          llmFailure && llmError && !isContextOverflowFailure(llmFailure)
            ? yield* restore(
                input.retry(
                  llmFailure,
                  llmError,
                  SessionRunnerRetry.isRetryable(llmFailure) ||
                    (recorded.outputStarted && isInterruptedStream(llmFailure)),
                ),
              )
            : undefined
        if (llmFailure && llmError && retry?.retry && !recorded.outputStarted) {
          // Retry state projects onto the existing assistant, even before it has produced output.
          yield* publisher.startAssistant()
          return Outcome.Retry({ error: llmError, decision: retry, overloaded: isOverloaded(llmFailure) })
        }
        if (llmError) yield* publisher.failAssistant(llmError)

        for (const decline of tools.declines)
          yield* publisher.failTool(decline.call.id, {
            type: "aborted",
            message: input.isLocationClosed()
              ? "Interaction cancelled because the location shut down"
              : decline.reason._tag === "QuestionTool.CancelledError"
                ? decline.reason.message
                : "The user declined this tool call",
          })
        const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
        const toolFailure = interrupted
          ? TOOLS_INTERRUPTED
          : tools.failure !== undefined
            ? toSessionError(Cause.squash(tools.failure))
            : recorded.providerFailed
              ? TOOLS_INTERRUPTED
              : undefined
        if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
        if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

        // All local fibers have joined; only provider-hosted results can still be missing.
        if (llmError || (Exit.isSuccess(stream) && !recorded.providerFailed)) {
          const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
          if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
        }

        // Read before the sweep below: an input cut off by a length stop is settled, not run, and must not start a step.
        const before = publisher.record()
        const ran = before.needsContinuation

        // A length stop cuts inputs off before their call: settle them so nothing stays streaming and the model learns.
        if (!llmError && Exit.isSuccess(stream) && !recorded.providerFailed && recorded.finish?.finish === "length")
          yield* publisher.failUnsettledTools(INPUT_TRUNCATED, "uncalled")

        const record = publisher.record()
        if (record.finish || record.failure) {
          const snapshot = yield* snapshots.capture()
          const files =
            startSnapshot && snapshot
              ? startSnapshot === snapshot
                ? []
                : yield* snapshots
                    .files({ from: startSnapshot, to: snapshot })
                    .pipe(Effect.orElseSucceed(() => undefined))
              : undefined
          const usage = record.finish
            ? { cost: SessionUsage.calculateCost(input.model.cost, record.finish.tokens), tokens: record.finish.tokens }
            : undefined
          if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
          if (record.finish && usage && !record.failure)
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: input.sessionID,
              assistantMessageID: yield* publisher.startAssistant(),
              finish: record.finish.finish,
              rawFinish: record.finish.rawFinish,
              providerState: record.finish.providerState,
              ...usage,
              snapshot,
              files,
            })
        }

        if (
          llmFailure &&
          llmError &&
          retry?.retry &&
          record.outputStarted &&
          tools.declines.length === 0 &&
          !tools.interrupted
        )
          return Outcome.Continue({ error: llmError, decision: retry, overloaded: isOverloaded(llmFailure) })

        if (Exit.isFailure(stream)) return yield* Effect.failCause(stream.cause)
        if (tools.declines.length > 0) {
          if (input.isLocationClosed()) return Outcome.Completed({ needsContinuation: true })
          return yield* Effect.interrupt
        }
        if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
        if (tools.interrupted && Exit.isFailure(joined)) return yield* Effect.failCause(joined.cause)
        if (record.failure) return yield* new StepFailedError({ error: record.failure })
        const needsContinuation = input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation
        if (record.finish?.finish === "length") return Outcome.OutputLimited({ needsContinuation: needsContinuation && ran, toolCalled: before.toolCalled })
        return Outcome.Completed({ needsContinuation })
      }),
    )
  }, Effect.scoped)

  return { attempt }
})

/** A tool turns the user's feedback into a failure whose cause is the correction, possibly through a wrapper. */
const hasCorrection = (error: Tool.Error) => {
  for (let cause: unknown = error, depth = 0; depth < 8; depth++) {
    if (cause instanceof Permission.CorrectedError) return true
    if (!(cause instanceof Error) || !("error" in cause)) return false
    cause = cause.error
  }
  return false
}

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  settled: Exit.Exit<Array<Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>>>,
  runs: ReadonlyArray<{ readonly call: ToolCall }>,
) => {
  const exits = Exit.isSuccess(settled) ? settled.value : []
  const declines = exits.flatMap((exit, index) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: runs[index].call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = Exit.isFailure(settled)
    ? [settled.cause]
    : exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
