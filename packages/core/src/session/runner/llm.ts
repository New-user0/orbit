export * as SessionRunnerLLM from "./llm.js"

import { Message } from "@orbit/ai"
import { Model } from "@orbit/schema/model"
import { DEFAULT_OUTPUT_ATTEMPTS } from "@orbit/schema/session-turn"
import { plain } from "@orbit/util/plain"
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm"
import { Cause, Effect, Exit, FiberMap, Layer } from "effect"
import { Database } from "../../database/database.js"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { LocationLifecycle } from "../../location-lifecycle.js"
import { InstructionState } from "../instruction-state.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import { SessionInbox } from "../inbox.js"
import { SessionHistory } from "../history.js"
import { SessionProviderContext } from "../provider-context.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionModelTransport } from "../model-transport.js"
import { SessionOutput } from "../output.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"
import { SessionScratchpad } from "../scratchpad.js"
import { SessionStore } from "../store.js"
import { SessionMessageTable } from "../sql.js"
import { SessionTitle } from "../title.js"
import { SessionTurn } from "../turn.js"
import { SessionTurnEnd } from "../turn-end.js"
import { toSessionError } from "../to-session-error.js"
import { DrainResult, Service, type Interface } from "./index.js"
import { Snapshot } from "../../snapshot.js"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { llmClient } from "../../effect/app-node-platform.js"
import { StepFailedError } from "../error.js"
import { SessionRunnerRetry } from "./retry.js"
import { SessionStep } from "./step.js"
import { ToolOutput } from "../../tool-output.js"
import { Plugin } from "../../plugin.js"
import { ToolNames } from "../../tool/names.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const RESUME_AFTER_OUTPUT_LIMIT =
  "Your last response stopped because it reached the output limit. Resume exactly where it stopped, without repeating what you already wrote. If you were writing a tool call, issue it again in full."
const MAX_OUTPUT_RECOVERIES = 3
// Never sent to the model: the notice and the attempt it replaces are left out of every request.
const ESCALATE_OUTPUT_LIMIT =
  "The previous response reached the output cap, so the request is repeated with a larger one."

/**
 * The resume and escalation notices since the last response that ended normally (a user message, an idle marker or a
 * response that finished with `stop` or `tool-calls`). A failed or interrupted response does not end the stretch, so
 * one logical step cannot resume or escalate without bound. Read from the durable rows rather than the runner's
 * history, which starts at the latest compaction: a compaction between resumes would otherwise reset both counts.
 */
const outputRecovery = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const notice = sql`json_extract(${SessionMessageTable.data}, '$.metadata.notice')`
  const normalEnd = db
    .select({ seq: sql<number>`coalesce(max(${SessionMessageTable.seq}), -1)` })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        or(
          inArray(SessionMessageTable.type, ["user", "idle"]),
          and(
            eq(SessionMessageTable.type, "assistant"),
            sql`json_extract(${SessionMessageTable.data}, '$.finish') in ('stop', 'tool-calls')`,
          ),
        ),
      ),
    )
  const row = yield* db
    .select({
      streak: sql<number>`coalesce(sum(${notice} = 'output-limit'), 0)`,
      escalations: sql<number>`coalesce(sum(${notice} = 'output-escalation'), 0)`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "synthetic"),
        gt(SessionMessageTable.seq, sql`(${normalEnd})`),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  // The maximum lasts until a response ends normally.
  return { streak: row?.streak ?? 0, escalated: (row?.escalations ?? 0) > 0 }
})

/** Consecutive overloads on one model before the step moves to the turn's fallback model. */
const FALLBACK_AFTER_OVERLOADS = 3

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lifecycle = yield* LocationLifecycle.Service
    const store = yield* SessionStore.Service
    const context = yield* SessionContext.Service
    const modelTransport = yield* SessionModelTransport.Service
    const db = (yield* Database.Service).db
    const compaction = yield* SessionCompaction.Service
    const plugins = yield* Plugin.Service
    const scratchpad = yield* SessionScratchpad.Service
    const title = yield* SessionTitle.Service
    const turnEnd = yield* SessionTurnEnd.Service
    const steps = yield* SessionStep.make
    // Title generation starts once input is visible and must not delay model execution.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("SessionRunner.drain")(function* (input: Parameters<Interface["drain"]>[0]) {
      const sessionID = input.sessionID
      let force = input.force
      let continuing = input.continuation !== undefined
      let step = input.continuation?.step ?? 1
      let entering = true
      const promotable = input.promotable ?? "input"
      if (!force && !continuing) {
        const pending = yield* SessionInbox.nextPromotable(db, sessionID, "input")
        if (!pending) return DrainResult.Complete()
        const control = pending.type === "compaction" || pending.type === "move"
        if (promotable === "steer" && pending.delivery === "queue" && !control) return DrainResult.Complete()
      }
      yield* plugins.awaitActivation
      yield* settleStaleCompactions(sessionID)
      yield* settleStaleToolCalls(sessionID)
      // Once, before the first step, so the folder that the baseline names is there when the model first writes to it.
      const session = yield* store.get(sessionID)
      if (session) yield* scratchpad.ensure(session)

      const advanceToStep = Effect.fn("SessionRunner.advanceToStep")(() =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              if (lifecycle.isClosed()) {
                yield* restore(modelTransport.close(sessionID))
                return DrainResult.Reloaded({ force, continuation: continuing ? { step } : undefined })
              }
              // Location entry and idle boundaries allow queued controls, not necessarily queued prompts.
              const pending = yield* SessionInbox.serialized(
                sessionID,
                Effect.gen(function* () {
                  const next = yield* SessionInbox.nextPromotable(
                    db,
                    sessionID,
                    entering || !continuing ? "input" : "steer",
                  )
                  if (next?.type === "compaction")
                    yield* bus.publishAll([
                      [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                      [SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID: next.id }],
                    ])
                  if (next?.type === "move")
                    yield* restore(
                      Effect.gen(function* () {
                        yield* modelTransport.close(sessionID)
                        yield* bus.publishAll([
                          [SessionEvent.InboxDelivered, { sessionID, inboxID: next.id }],
                          [SessionEvent.Moved, { sessionID, ...next.payload }],
                        ])
                      }),
                    )
                  return next
                }),
              )
              if (!continuing && pending?.delivery !== "steer") {
                entering = true
                step = 1
              }
              if (pending?.type === "move")
                return DrainResult.Moved({ continuation: continuing ? { step } : undefined })
              if (pending?.type === "compaction") {
                const compacted = yield* restore(
                  Effect.gen(function* () {
                    const selected = yield* context.select(sessionID)
                    const model = yield* context.resolveModel(selected.session)
                    // Preview updates without admitting them after the already-delivered compaction marker.
                    const history = yield* SessionHistory.preview(
                      db,
                      sessionID,
                      selected.instructions,
                      SessionProviderContext.provenance(model) ?? "local",
                    )
                    return yield* compaction.compact({
                      reason: "manual",
                      inputID: pending.id,
                      context: {
                        session: selected.session,
                        agent: selected.agent,
                        tools: selected.tools,
                        model,
                        initial: history.initial,
                        messages: history.messages,
                      },
                    })
                  }).pipe(
                    Effect.catch((error) =>
                      bus.publish(SessionEvent.Compaction.Failed, {
                        sessionID,
                        reason: "manual",
                        inputID: pending.id,
                        error: toSessionError(error),
                      }),
                    ),
                  ),
                ).pipe(Effect.exit)
                if (Exit.isFailure(compacted)) {
                  yield* bus.publish(SessionEvent.Compaction.Failed, {
                    sessionID,
                    reason: "manual",
                    error: Cause.hasInterruptsOnly(compacted.cause)
                      ? { type: "aborted", message: "Compaction cancelled" }
                      : { type: "compaction.failed", message: Cause.pretty(compacted.cause) },
                    inputID: pending.id,
                  })
                  return yield* Effect.failCause(compacted.cause)
                }
                force = false
                continue
              }
              if (!force && !continuing && (!pending || (pending.delivery === "queue" && promotable === "steer")))
                return DrainResult.Complete()
              const ready = yield* restore(
                Effect.gen(function* () {
                  const selected = yield* prepareContext(sessionID)
                  const promoted = yield* SessionInbox.promote(
                    db,
                    bus,
                    sessionID,
                    entering && !continuing ? promotable : "steer",
                  )
                  // A control admitted during context preparation owns this boundary.
                  if (promoted === undefined) return undefined
                  if (promoted > 0 && !selected.session.parentID && SessionTitle.isUntitled(selected.session))
                    yield* FiberMap.run(titles, sessionID, title.generate(sessionID), {
                      onlyIfMissing: true,
                    })
                  if (promoted > 0) step = 1
                  return {
                    _tag: "Ready" as const,
                    context: yield* loadSelected(selected, (yield* SessionTurn.current(db, sessionID)).fallback),
                  }
                }),
              )
              if (ready) return ready
            }
          }),
        ),
      )

      while (true) {
        const next = yield* advanceToStep()
        if (next._tag !== "Ready") return next
        const stopped = yield* runStep(next.context, step)
        // A turn that stops at the agent's step allowance never reaches the turn-end checks, so it is checked here.
        if (stopped === "limited") yield* requireOutput(next.context, yield* SessionTurn.current(db, sessionID))
        continuing = stopped === "continue" || (stopped === "ended" && (yield* endTurn(next.context)))
        step++
        force = false
        entering = false
      }
    })

    // The checks run only for a turn that ended on its own: not at a limit, and not while steered input waits, since
    // that would continue the turn itself. A queued prompt starts the next turn, so it does not skip them. A
    // continuation adds its notice and the drain takes another step, so the busy period still ends in one terminal.
    const endTurn = Effect.fn("SessionRunner.endTurn")(function* (loaded: SessionContext.Loaded) {
      const sessionID = loaded.session.id
      if (
        (yield* SessionInbox.list(db, sessionID)).some(
          (item) => item.delivery === "steer" && item.type !== "compaction" && item.type !== "move",
        )
      )
        return false
      const current = yield* SessionTurn.current(db, sessionID)
      // No step can follow a spent turn limit, and a notice left behind would reach the next prompt's request. A turn
      // that still owes its structured answer fails with the limit instead of ending as if it had finished.
      const limit = yield* turnLimit(loaded, current.options)
      if (limit) {
        yield* requireOutput(loaded, current, limit)
        return false
      }
      const continuation = yield* turnEnd.run({ sessionID, turn: current })
      if (!continuation) {
        yield* requireOutput(loaded, current)
        return false
      }
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: continuation.text,
        description: continuation.description === undefined ? undefined : plain(continuation.description),
        metadata: { notice: SessionTurnEnd.NOTICE, check: continuation.check },
      })
      return true
    })

    /**
     * Fails a turn that asked for a structured answer and ends without an accepted one: with the limit that ended it, or
     * `output.missing` when it ended on its own. The failure is recorded, so every client reads the same terminal.
     */
    const requireOutput = Effect.fnUntraced(function* (
      loaded: SessionContext.Loaded,
      current: SessionTurn.Current,
      limit?: { readonly type: string; readonly message: string },
    ) {
      if (!current.options?.output) return
      if ((yield* SessionOutput.progress(db, loaded.session.id, current.options.seq)).latest === "accepted") return
      return yield* new StepFailedError({
        error: limit ?? {
          type: "output.missing",
          message: `The turn ended without handing in an answer that follows the schema through ${SessionOutput.NAME}.`,
        },
      })
    })

    /**
     * The validator for the turn's structured answer, or undefined when it asked for none. The schema was checked at
     * admission, but a stored row may be older or edited, so it is compiled again and never run unchecked.
     */
    const outputFor = Effect.fnUntraced(function* (loaded: SessionContext.Loaded, current: SessionTurn.Current) {
      const output = current.options?.output
      if (!output) return undefined
      const failed = (type: string, message: string) => new StepFailedError({ error: { type, message } })
      if (!loaded.model.capabilities.tools)
        return yield* failed(
          "output.unsupported-model",
          "The model cannot call tools, so it cannot hand in a structured answer.",
        )
      const compiled = SessionOutput.compile(output.schema)
      if (!compiled.ok) {
        yield* Effect.logWarning("The stored output schema no longer compiles, so the turn is stopped").pipe(
          Effect.annotateLogs({ sessionID: loaded.session.id, problem: compiled.message }),
        )
        return yield* failed(
          "output.schema-invalid",
          `The turn's output schema cannot be enforced: ${compiled.message}`,
        )
      }
      const attempts = output.attempts ?? DEFAULT_OUTPUT_ATTEMPTS
      const progress = yield* SessionOutput.progress(db, loaded.session.id, current.options.seq)
      if (progress.latest === "rejected" && progress.rejected >= attempts)
        return yield* failed(
          "limit.structured-output",
          `The model did not hand in an answer that follows the schema within ${attempts} ${attempts === 1 ? "attempt" : "attempts"}.`,
        )
      return { validator: compiled.validator, schema: output.schema, accepted: progress.latest === "accepted" }
    })

    const prepareContext = Effect.fn("SessionRunner.prepareContext")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })

    const turnLimit = Effect.fnUntraced(function* (
      loaded: SessionContext.Loaded,
      turn: SessionTurn.Current["options"],
    ) {
      // A catalog entry with no price is a tier-less $0, which would let the turn spend without bound.
      const priced = loaded.model.cost.some((cost) => cost.tier === undefined && (cost.input > 0 || cost.output > 0))
      const own =
        !turn || (turn.maxSteps === undefined && turn.maxCost === undefined && turn.maxTokens === undefined)
          ? undefined
          : SessionTurn.exceeded(turn, yield* SessionTurn.usage(db, loaded.session.id, turn), priced)
      // A subagent carries no turn options of its own, so the turn it works for limits it too.
      return own ?? (yield* SessionTurn.ancestorLimit(db, loaded.session.id, priced))
    })

    // The turn's fallback model, once a notice has named one, replaces the Session's model for every load.
    const loadSelected = (selected: SessionContext.Selection, fallback: Model.Ref | undefined) =>
      context.load(fallback ? { ...selected, session: { ...selected.session, model: fallback } } : selected)

    /** Owns logical Step policy; each attempt owns its streaming, tools, and durable settlement. */
    const runStep = Effect.fn("SessionRunner.runStep")(function* (first: SessionContext.Loaded, step: number) {
      const sessionID = first.session.id
      let assistantMessageID = SessionMessage.ID.create()
      let retry = yield* SessionRunnerRetry.make(bus, sessionID)
      let overloads = 0
      let initial: SessionContext.Loaded | undefined = first
      let recoverOverflow = true
      let recoverContinuation = true
      // The notice is the durable record that the turn moved, so a drain that reloads or restarts keeps the fallback.
      const switchToFallback = Effect.fnUntraced(function* (
        outcome: { readonly overloaded: boolean },
        loaded: SessionContext.Loaded,
        current: SessionTurn.Current,
      ) {
        overloads = outcome.overloaded ? overloads + 1 : 0
        if (overloads < FALLBACK_AFTER_OVERLOADS || current.fallback) return false
        const fallback = yield* context.resolveFallback(loaded.session, current.options?.fallbackModel)
        if (!fallback) return false
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID,
          text: "The previous model was overloaded, so this turn continues on a different model.",
          description: `Switched from ${modelName(loaded.model.ref)} to ${modelName(fallback.ref)} after repeated overloads`,
          metadata: { notice: "fallback", model: fallback.ref, previous: loaded.model.ref },
        })
        yield* modelTransport.close(sessionID)
        retry = yield* SessionRunnerRetry.make(bus, sessionID)
        overloads = 0
        return true
      })
      while (true) {
        const current = yield* SessionTurn.current(db, sessionID)
        // Reuse boundary preparation once; retries refresh context without delivering more input.
        const loaded =
          initial ??
          (yield* prepareContext(sessionID).pipe(
            Effect.flatMap((selected) => loadSelected(selected, current.fallback)),
          ))
        initial = undefined
        // Before compaction, so no compaction or request starts once the turn is over a limit it set.
        const limit = yield* turnLimit(loaded, current.options)
        if (limit) return yield* new StepFailedError({ error: limit })
        const output = yield* outputFor(loaded, current)
        const compacted = yield* compaction.compact({ reason: "auto", context: loaded })
        if (compacted.status === "failed") return yield* new StepFailedError({ error: compacted.error })
        if (compacted.status === "completed") {
          assistantMessageID = SessionMessage.ID.create()
          continue
        }
        const recovery = yield* outputRecovery(db, sessionID)
        const stepLimitReached = loaded.agent.info.steps !== undefined && step >= loaded.agent.info.steps
        // The allowance turns tools off for the last step, which would make an answer impossible: until one is accepted,
        // that step offers the hand-in alone and asks for it by name.
        const handInOnly = stepLimitReached && output !== undefined && !output.accepted
        const transcript = SessionModelRequest.baseTranscript({
          agent: loaded.agent.info,
          model: loaded.model,
          tools: loaded.tools,
          initial: loaded.initial,
          messages: loaded.messages,
        })
        const prepared = yield* context.request.primary({
          session: loaded.session,
          agent: loaded.agent.id,
          model: loaded.model,
          tools: loaded.tools,
          system: transcript.system,
          messages:
            stepLimitReached && !handInOnly
              ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
              : transcript.messages,
          // Keep tool definitions on the final Step to preserve the provider's cached prefix.
          toolChoice: handInOnly ? { type: "tool", name: SessionOutput.NAME } : stepLimitReached ? "none" : undefined,
          output: output && { validator: output.validator, schema: output.schema, only: handInOnly },
          webSocket: "session",
          inputTokens: SessionCompaction.estimatePrompt(loaded),
          outputTokenCap: loaded.outputTokenCap,
          outputEscalated: recovery.escalated,
        })
        const outcome = yield* steps.attempt({
          isLocationClosed: lifecycle.isClosed,
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared,
          retry: (cause, error, proposed) =>
            retry.decide({
              cause,
              error,
              agent: loaded.agent.id,
              model: loaded.model.ref,
              hook: prepared.retry,
              retry: proposed,
            }),
          recoverContinuation,
          recoverOverflow: Effect.suspend(() =>
            recoverOverflow
              ? compaction
                  .compact({ reason: "overflow", context: loaded })
                  .pipe(Effect.map((result) => result.status === "completed"))
              : Effect.succeed(false),
          ),
        })
        const completed = yield* SessionStep.Outcome.$match(outcome, {
          Completed: (outcome) =>
            Effect.succeed(
              outcome.needsContinuation
                ? ("continue" as const)
                : stepLimitReached
                  ? ("limited" as const)
                  : ("ended" as const),
            ),
          OutputLimited: Effect.fnUntraced(function* (outcome) {
            // A finished response is not an overload, so it restarts the count of overloads in a row.
            overloads = 0
            // Fail with the limit now, also at the cap; a note left behind would reach the next prompt's request.
            const limit = yield* turnLimit(loaded, current.options)
            if (limit) return yield* new StepFailedError({ error: limit })
            // At the cap no path starts another request (a tool that ran, a swept input or a text-only stop).
            if (recovery.streak >= MAX_OUTPUT_RECOVERIES) return "limited" as const
            // A text-only resume never reaches the step boundary, so a waiting steered message would sit behind up to
            // three requests. Return now: the boundary delivers it and its user message starts a fresh streak.
            if (
              !outcome.needsContinuation &&
              (yield* SessionInbox.list(db, sessionID)).some(
                (item) => item.type === "user" && item.delivery === "steer",
              )
            )
              return "ended" as const
            // The first cut-off of a reply that ran no tool, under the runner's own lowered cap, retries the same
            // request at the model's maximum before any resume. A hosted tool call counts: repeating it reruns and
            // rebills it. The notice replaces the cut-off attempt, which later requests leave out.
            if (!outcome.toolCalled && prepared.escalation && recovery.streak === 0 && !recovery.escalated) {
              yield* bus.publish(SessionEvent.Synthetic, {
                sessionID,
                text: ESCALATE_OUTPUT_LIMIT,
                metadata: { notice: "output-escalation", replaces: assistantMessageID },
              })
              assistantMessageID = SessionMessage.ID.create()
              return undefined
            }
            yield* bus.publish(SessionEvent.Synthetic, {
              sessionID,
              text: RESUME_AFTER_OUTPUT_LIMIT,
              metadata: { notice: "output-limit" },
            })
            if (outcome.needsContinuation) return "continue" as const
            assistantMessageID = SessionMessage.ID.create()
          }),
          Retry: Effect.fnUntraced(function* (outcome) {
            if (yield* switchToFallback(outcome, loaded, current)) {
              // The draft from the failed attempt sits before the notice; a new one keeps the notice ahead of the fallback's answer.
              assistantMessageID = SessionMessage.ID.create()
              return undefined
            }
            yield* retry.wait({ decision: outcome.decision, error: outcome.error, assistantMessageID })
          }),
          Continue: Effect.fnUntraced(function* (outcome) {
            if (!(yield* switchToFallback(outcome, loaded, current)))
              yield* retry.wait({ decision: outcome.decision, error: outcome.error, assistantMessageID })
            yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            assistantMessageID = SessionMessage.ID.create()
          }),
          Compacted: Effect.fnUntraced(function* () {
            recoverOverflow = false
            assistantMessageID = SessionMessage.ID.create()
          }),
          RecoverFull: Effect.fnUntraced(function* () {
            recoverContinuation = false
          }),
        })
        if (completed !== undefined) return completed
      }
    })

    const settleStaleCompactions = Effect.fn("SessionRunner.settleStaleCompactions")(function* (
      sessionID: SessionSchema.ID,
    ) {
      // A process death skips compaction finalizers. Include orphans behind a
      // completed checkpoint, and settle newest first to match event projection.
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const message = yield* SessionHistory.decodeMessageRow(row)
        if (message.type !== "compaction") continue
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        })
      }
    })

    const settleStaleToolCalls = Effect.fn("SessionRunner.settleStaleToolCalls")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* store.context(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "streaming" && tool.state.status !== "running")) continue
          const metadata = tool.state.status === "running" ? tool.state.metadata : undefined
          const childID =
            ToolNames.canonical(tool.name) === "Agent" && typeof metadata?.sessionID === "string"
              ? metadata.sessionID
              : undefined
          yield* bus.publish(SessionEvent.Tool.Failed, {
            sessionID,
            assistantMessageID: message.id,
            id: tool.id,
            error: {
              type: "aborted",
              message: `Tool execution interrupted: ${tool.name}${childID ? ` (sessionID: ${childID})` : ""}`,
            },
            ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
            executed: tool.executed === true,
          })
        }
      }
    })

    return Service.of({ drain })
  }),
)

const modelName = (ref: Model.Ref) => `${ref.providerID}/${ref.id}`

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Config.node,
    LocationLifecycle.node,
    llmClient,
    SessionContext.node,
    SessionModelTransport.node,
    SessionStore.node,
    SessionCompaction.node,
    Plugin.node,
    SessionScratchpad.node,
    SessionTitle.node,
    SessionTurnEnd.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})
