export * as SessionCompaction from "./compaction.js"

import {
  AIError,
  type ContentPart,
  GenerationOptions,
  InvalidProviderOutputError,
  InvalidRequestError,
  isContextOverflowFailure,
  LLMClient,
  LLMEvent,
  LLMRequest,
  Message,
  SystemPart,
  type ToolEntry,
  UnknownProviderError,
  type Usage,
} from "@orbit/ai"
import type { StreamOptions } from "@orbit/ai/route"
import type { SessionCompactionResult } from "@orbit/plugin/effect/session"
import type { SessionError } from "@orbit/schema/session-error"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, Effect, Layer, Result, Stream } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { State } from "../state.js"
import { Token } from "../util/token.js"
import type { SessionContext } from "./context.js"
import { SessionContextWindow } from "./context-window.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionReminders } from "./reminders.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionRunnerRetry } from "./runner/retry.js"
import { toLLMMessages, withoutReplaced } from "./runner/to-llm-message.js"
import { isReminder } from "./reminder-text.js"
import { toSessionError } from "./to-session-error.js"
import { SessionUsage } from "./usage.js"
import { ToolOutput } from "../tool-output.js"
import COMPACTION_PROMPT from "./runner/prompt/compaction.txt"
import COMPACTION_REMINDER from "./runner/prompt/compaction-reminder.txt"

export type Settings = {
  auto: boolean
  /** Tokens kept free below the effective window before compacting. Unset keeps 13,000 free. */
  buffer?: number
  /** Tokens of the newest user messages that a native compaction keeps beside the provider's window. */
  keep: number
}

export type Editor = {
  configure: (settings: Partial<Settings>) => void
}

export type Trigger =
  /** `overflow`: the provider just rejected this context as too long. */
  | { readonly reason: "auto" | "overflow"; readonly context: SessionContext.Loaded }
  /** `inputID` is the `/compact` inbox item, whose message shows the outcome. */
  | {
      readonly reason: "manual"
      readonly context: SessionContext.Loaded
      readonly inputID: SessionMessage.ID
      /** Text from the person, added to the summary prompt. Blank counts as none. */
      readonly instructions?: string
    }

export type Outcome =
  /** Only `auto` skips: the context fits, or automatic compaction is off. */
  | { readonly status: "skipped" }
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: SessionError.Error }

export interface Interface extends State.Transformable<Editor> {
  readonly compact: (trigger: Trigger) => Effect.Effect<Outcome>
  /** Whether automatic compaction is on, and where the loaded model's thresholds sit (undefined for an unknown window). */
  readonly thresholds: (context: SessionContext.Loaded) => {
    readonly auto: boolean
    readonly thresholds: SessionContextWindow.Thresholds | undefined
  }
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionCompaction") {}

/** A summary fills `text`; a native compaction fills `providerContext`. `recent` is text kept by checkpoints stored earlier. */
type Result = {
  readonly text: string
  readonly recent: string
  // todo: consolidate these 2
  readonly providerState?: SessionMessage.ProviderState
  readonly providerContext?: SessionProviderContext.Info
  readonly metadata?: Record<string, unknown>
}

type Failure = {
  readonly error: SessionError.Error
}

type Prepared = Effect.Success<ReturnType<SessionModelRequest.Interface["compaction"]>>

type Streamed = {
  readonly text: string
  readonly providerState?: SessionMessage.ProviderState
}

const NOTHING_TO_COMPACT: Failure = { error: { type: "compaction.unavailable", message: "Nothing to compact yet" } }
/** After each "too long" rejection of a native compaction, the next attempt aims at this share of the first rejected request's size. */
const SHRINK_STEPS = [0.7, 0.5, 0.35]
/** A common window size, assumed for the compaction request when the model's window is unknown. */
const UNKNOWN_WINDOW = 200_000
const TOOL_OUTPUT_MAX_CHARS = 1_250
const IMAGE_TOKEN_ESTIMATE = 1_500
const PDF_TOKEN_ESTIMATE = 2_000

/** The text a summary compaction asks for, and the line that closes the request. */
const PROMPT = COMPACTION_PROMPT.trim()
const REMINDER = COMPACTION_REMINDER.trim()
const FALLBACK_SYSTEM = "You write summaries of conversations so that the work in them can continue."
const LEFT_OUT = "[Earlier messages were left out so that this summary request fits.]"
const TOO_LONG = "The conversation is too long to compact. Go back a few messages and try again."
const NO_SUMMARY: Failure = { error: { type: "compaction.failed", message: "Compaction produced no summary" } }
/** How often a rejected summary request is shortened and sent again. */
const MAX_DROPS = 3
const FALLBACK_OUTPUT_MAX = 20_000

/** The summary prompt. Instructions from the person sit in a block of their own, before the closing reminder. */
export const buildPrompt = (instructions?: string) => {
  const extra = instructions?.trim()
  return [PROMPT, ...(extra ? [`Additional instructions for this handoff:\n${extra}`] : []), REMINDER].join("\n\n")
}

/**
 * What is stored from a reply: the drafting block never, the handoff block under a "Summary:" heading. A handoff that
 * was cut off before its closing tag stays as written.
 */
export const formatSummary = (raw: string) =>
  raw
    .replace(/<analysis>[\s\S]*?<\/analysis>/g, "")
    .replace(/<analysis>[\s\S]*$/, "")
    .replace(/<handoff>([\s\S]*?)<\/handoff>/, (_, inner: string) => `Summary:\n${inner.trim()}`)
    .replace(/(?:\r?\n){2,}/g, "\n\n")
    .trim()

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const db = (yield* Database.Service).db
    const requests = yield* SessionModelRequest.Service
    const reminders = yield* SessionReminders.Service
    const toolOutput = yield* ToolOutput.Service

    const state = State.create<Settings, Editor>({
      name: "session-compaction",
      initial: () => ({ auto: true, keep: 15_000 }),
      editor: (settings) => ({
        configure: (update) => {
          Object.assign(settings, update)
        },
      }),
    })

    const compact = Effect.fn("SessionCompaction.compact")(function* (trigger: Trigger): Effect.fn.Return<Outcome> {
      const settings = state.get()
      const context = trigger.context

      // Only the user compacts when automatic compaction is off, overflow included.
      if (trigger.reason !== "manual" && !settings.auto) return { status: "skipped" }
      const found = thresholds(context, settings)
      if (trigger.reason === "auto" && !(found && due(context, found.threshold))) return { status: "skipped" }
      // An unknown window never triggers auto compaction, but the compaction request still needs a size to aim for.
      // The request may fill the effective window, which leaves the summary exactly its reserve for output.
      const cap =
        found?.effective ?? UNKNOWN_WINDOW - SessionContextWindow.reserve(context.model.limit, context.outputTokenCap)
      // The provider just rejected this context, so the estimate ran low; the first attempt already aims below it.
      const budget =
        trigger.reason === "overflow" ? Math.min(cap, Math.floor(estimateContext(context, reminders.minimal, toolOutput.root) * SHRINK_STEPS[0])) : cap

      const compaction =
        context.model.compaction?.type === "native"
          ? compactNatively(trigger, budget, settings.keep)
          : summarize(trigger, budget)
      return yield* compaction.pipe(
        Effect.matchEffect({
          onSuccess: (result) => publish(trigger, result),
          onFailure: (failure) => publish(trigger, failure),
        }),
      )
    })

    const thresholds = (context: SessionContext.Loaded, settings: Settings) =>
      SessionContextWindow.thresholds({
        limit: context.model.limit,
        outputTokenCap: context.outputTokenCap,
        buffer: settings.buffer,
      })

    const due = (context: SessionContext.Loaded, ceiling: number) => {
      const messages = context.messages
      // A compaction just completed; let the runner rebuild the request from it first.
      const last = messages.at(-1)
      if (last?.type === "compaction" && last.status === "completed") return false
      // An encrypted native window estimates as nothing, so wait for a response to measure it.
      const measured = messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
      if (measured < messages.findLastIndex(SessionProviderContext.isCheckpoint)) return false
      return estimateContext(context, reminders.minimal, toolOutput.root) >= ceiling
    }

    /**
     *   first:  [E1 … E8][E9 E10]               →  [S1]
     *   again:  [S1][E11 … E18][E19]            →  [S2]      S2 covers S1 and everything after it
     *
     * The model is sent everything since the newest checkpoint, then the summary prompt:
     *
     *   [system][S1][E11 … E18][E19][prompt]
     *
     * Later requests open with the checkpoint as one user message, followed by the new messages.
     *
     * E = one exchange: a user message and the replies to it. S = a summary.
     *
     * The first request shares the main request's system prompt, tools and settings. Its reply decides by its text
     * alone: a tool call is never run. When that request yields no text, or fails, one fallback request is made with
     * a one-line system prompt, no media, no reasoning and the read tool only. A rejection of the fallback as too long
     * drops the oldest round groups of the history and starts again, at most three times.
     */
    const summarize = Effect.fnUntraced(function* (trigger: Trigger, budget: number): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      const messages = compactable(context.messages)
      if (!messages.some(covered)) return yield* Effect.fail(NOTHING_TO_COMPACT)

      const prepared = yield* prepare(context, messages, budget)
      // The runner opened the manual compaction's message when it delivered the `/compact` item.
      if (trigger.reason !== "manual") {
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: context.session.id, reason: "auto", recent: "" })
      }
      if (prepared.event.result) {
        const supplied = formatSummary(prepared.event.result.summary)
        if (!supplied) return yield* Effect.fail(NO_SUMMARY)
        return yield* fromHook(context, { ...prepared.event.result, summary: supplied })
      }

      const policy = yield* SessionRunnerRetry.policy(context.session.id)
      // Hooks saw the request without the summary prompt, so it is appended here.
      const prompt = Message.user(buildPrompt(trigger.reason === "manual" ? trigger.instructions : undefined))
      const outputMax = Math.min(FALLBACK_OUTPUT_MAX, context.model.limit.output || FALLBACK_OUTPUT_MAX)

      // One call, resent under the session's retry policy. A rejection as too long is left to the caller.
      const call = Effect.fnUntraced(function* (request: LLMRequest): Effect.fn.Return<Streamed, AIError | Failure> {
        while (true) {
          const attempt = yield* Effect.result(stream(context, request, prepared.options))
          if (Result.isSuccess(attempt)) return attempt.success
          const cause = attempt.failure
          if (!(cause instanceof AIError) || isContextOverflowFailure(cause)) return yield* Effect.fail(cause)
          const decision = yield* policy({
            cause,
            error: toSessionError(cause),
            agent: context.agent.id,
            model: context.model.ref,
            hook: prepared.retry,
            retry: SessionRunnerRetry.isRetryable(cause),
          })
          if (!decision.retry) return yield* Effect.fail(cause)
          yield* Effect.sleep(decision.delay)
        }
      })

      const finish = (reply: Streamed) => {
        const text = formatSummary(reply.text)
        if (!text) return Effect.fail(NO_SUMMARY)
        return Effect.succeed<Result>({ text, recent: "", providerState: reply.providerState })
      }

      let history = prepared.request.messages
      let drops = 0
      while (true) {
        const request = LLMRequest.update(prepared.request, {
          messages: [...(history[0]?.role === "assistant" ? [Message.user(LEFT_OUT)] : []), ...history, prompt],
        })
        const first = yield* Effect.result(call(request))
        if (Result.isSuccess(first) && first.success.text.trim()) return yield* finish(first.success)

        const second = yield* Effect.result(call(fallbackRequest(request, outputMax)))
        if (Result.isSuccess(second)) return yield* finish(second.success)
        const cause = second.failure
        if (!(cause instanceof AIError)) return yield* Effect.fail(cause)
        if (!isContextOverflowFailure(cause)) return yield* Effect.fail<Failure>({ error: toSessionError(cause) })

        const shorter = drops < MAX_DROPS ? dropOldestGroups(history, toSessionError(cause).message) : undefined
        if (!shorter) return yield* Effect.fail<Failure>({ error: { type: "compaction.failed", message: TOO_LONG } })
        history = shorter
        drops++
      }
    })

    /**
     *   endpoint:  [window]                      →  [U U][item]    the provider picks which messages to keep
     *   trigger:   [window][compaction_trigger]  →  [item]
     *                                            →  [U U][item]    we add the newest user messages within `keep`
     *
     * Later requests open with that replacement window in place of the history it covers:
     *
     *   [U U][item][new messages…]
     *
     * window = the previous compaction and everything since. item = one encrypted compaction item, which only
     * replays on the endpoint that made it. U = a user message as typed.
     */
    const compactNatively = Effect.fnUntraced(function* (
      trigger: Trigger,
      budget: number,
      keep: number,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      if (!compactable(context.messages).some(covered)) return yield* Effect.fail(NOTHING_TO_COMPACT)
      const unsupported = (message: string) =>
        Effect.fail<Failure>({ error: { type: "provider.unsupported-operation", message } })
      const prepared = yield* prepare(context, compactable(context.messages), budget, "session")

      // History is selected before request hooks, so a hook that reroutes the request cannot be honored here.
      const provenance = SessionProviderContext.provenance(context.model)
      if (!provenance) return yield* unsupported("Provider compaction requires a stable, configured endpoint")
      const routed = SessionProviderContext.provenance({ model: prepared.request.model, ref: context.model.ref })
      if (!SessionProviderContext.compatible(provenance, routed)) {
        return yield* unsupported(
          "Provider compaction requires the endpoint in provider/model settings, not a model.request rewrite",
        )
      }

      // A call that completed without reporting usage records zeros, which a turn limit reads as unknown, never as free.
      const toResult = (window: ReadonlyArray<Message>, usage: Usage | undefined) =>
        spend(context.session.id, SessionUsage.record(usage, context.model.cost)).pipe(
          Effect.as<Result>({
            text: "",
            recent: "",
            providerContext: SessionProviderContext.encode(provenance, window),
          }),
        )

      const send = (request: LLMRequest) => {
        // A call that fails or is interrupted after the provider began to answer was probably billed, though its usage
        // never arrived: an estimate keeps it from reading as free. A request the provider refused billed nothing.
        let answered = false
        const onResponse = () => {
          answered = true
        }
        const estimated = <A, E>(call: Effect.Effect<A, E>) =>
          call.pipe(
            Effect.onError(() =>
              Effect.suspend(() =>
                answered
                  ? spend(
                      context.session.id,
                      SessionUsage.estimate(context.model.cost, { input: estimateRequest(request), output: 0 }),
                    )
                  : Effect.void,
              ),
            ),
          )
        if (LLMClient.canCompact(request, { mechanism: "trigger" })) {
          return Effect.gen(function* () {
            const history = yield* SessionHistory.load(db, context.session.id, "local").pipe(Effect.orDie)
            const retained = recentUserMessages(history, context.model, keep)
            const response = yield* llm
              .compact(request, { ...prepared.options, mechanism: "trigger", onResponse })
              .pipe(estimated)
            return yield* toResult([...retained, Message.assistant(response.checkpoint)], response.usage)
          })
        }
        if (LLMClient.canCompact(request)) {
          return llm
            .compact(request, { mechanism: "endpoint", http: prepared.options.http, onResponse })
            .pipe(
              estimated,
              Effect.flatMap((response) => toResult(response.replacement, response.usage)),
            )
        }
        return unsupported(`Native compaction is not supported for ${request.model.provider}/${request.model.route.id}`)
      }

      return yield* deliver(trigger, prepared, budget, send)
    })

    /**
     * Sends the request as-is if it is estimated to fit `target`, and as text otherwise (see `flattenAndDropOldest`).
     * Limits and estimates can be wrong, so until the provider rejects something as too long, a request that cannot
     * be made to fit is sent whole: unchanged, or as text once its media has to go. A "too long" rejection means the
     * estimate ran low, so the next attempts aim at 70%, 50%, then 35% of the first rejected request's estimate, and a
     * rejection after those gives up. A "payload too large" rejection is about bytes, which inline media almost always
     * accounts for, so one on the unchanged request resends it as text, which carries no media, without counting; one
     * on text counts as "too long". Other provider errors resend the same request under the session's retry policy. A
     * `Failure` from `send` is a reply that cannot be used, and is never retried.
     */
    const deliver = Effect.fnUntraced(function* (
      trigger: Trigger,
      prepared: Prepared,
      target: number,
      send: (request: LLMRequest) => Effect.Effect<Result, AIError | Failure>,
    ): Effect.fn.Return<Result, Failure> {
      const context = trigger.context
      // The runner opened the manual compaction's message when it delivered the `/compact` item.
      if (trigger.reason !== "manual") {
        yield* bus.publish(SessionEvent.Compaction.Started, { sessionID: context.session.id, reason: "auto", recent: "" })
      }
      if (prepared.event.result) return yield* fromHook(context, prepared.event.result)

      const policy = yield* SessionRunnerRetry.policy(context.session.id)
      let rejections = 0
      let rejected: number | undefined
      let asText = false

      while (true) {
        const fits = !asText && estimateRequest(prepared.request) <= target
        const request = fits
          ? prepared.request
          : (flattenAndDropOldest(prepared.request, context, target) ??
            (rejections > 0
              ? undefined
              : asText
                ? flattenAndDropOldest(prepared.request, context, Number.POSITIVE_INFINITY)
                : prepared.request))
        if (!request) {
          return yield* Effect.fail<Failure>({
            error: {
              type: "compaction.failed",
              message:
                "The compaction request cannot be reduced further without losing the latest exchange or checkpoint",
            },
          })
        }

        const attempt = yield* Effect.result(send(request))
        if (Result.isSuccess(attempt)) return attempt.success
        const cause = attempt.failure
        if (!(cause instanceof AIError)) return yield* Effect.fail(cause)
        const error = toSessionError(cause)
        const tooLarge = cause.reason._tag === "InvalidRequest" && cause.reason.classification === "payload-too-large"

        if (tooLarge && request === prepared.request) {
          asText = true
          continue
        }

        if (tooLarge || isContextOverflowFailure(cause)) {
          const step = SHRINK_STEPS[rejections]
          if (step === undefined) return yield* Effect.fail<Failure>({ error })
          rejected ??= estimateRequest(request)
          target = Math.floor(rejected * step)
          rejections++
          continue
        }

        const decision = yield* policy({
          cause,
          error,
          agent: context.agent.id,
          model: context.model.ref,
          hook: prepared.retry,
          retry: SessionRunnerRetry.isRetryable(cause),
        })
        if (!decision.retry) return yield* Effect.fail<Failure>({ error })
        yield* Effect.sleep(decision.delay)
      }
    })

    /**
     * History that has to change is sent as text rather than as edited messages: `[previous compaction][transcript]`,
     * the conversation since that compaction as one text message. A previous summary always stays in front, while
     * its verbatim recent part becomes the oldest transcript entry; a previous native window stays exactly as the
     * provider made it. The transcript leaves out reasoning, media, and instruction updates, and cuts long tool
     * outputs. Only if it still does not fit are whole exchanges dropped, oldest first. Undefined when even the
     * newest exchange does not fit.
     */
    const flattenAndDropOldest = (request: LLMRequest, context: SessionContext.Loaded, target: number) => {
      const previous = previousCompaction(context.messages)
      const end =
        request.messages.findLastIndex(
          (message) =>
            (previous !== undefined && message.id === previous.id) ||
            message.content.some((part) => part.type === "compaction"),
        ) + 1
      const summary = previous !== undefined && !SessionProviderContext.isCheckpoint(previous) ? previous : undefined
      // TODO: Read the previous summary from the hooked request once it no longer merges summary and recent into one
      // message. Until then it is rebuilt from storage, which drops a compaction hook's edits to that message.
      const lead = summary
        ? toLLMMessages([{ ...summary, recent: "" }], context.model.ref)
        : request.messages.slice(0, end)

      // A user message and everything after it, up to the next one, is one exchange: kept or dropped whole.
      const exchanges = request.messages.slice(end).reduce<string[]>(
        (groups, message) => {
          const text = flattenMessage(message)
          if (!text) return groups
          if (message.role === "user" || groups.length === 0) groups.push(text)
          else groups[groups.length - 1] += `\n${text}`
          return groups
        },
        summary?.recent ? [summary.recent] : [],
      )

      const note = (omitted: number) =>
        omitted ? `[${omitted} older ${omitted === 1 ? "exchange" : "exchanges"} omitted]\n\n` : ""
      // Room for the longest possible note is set aside before choosing what to keep.
      const room =
        target -
        estimateRequest({ system: request.system, tools: request.tools, messages: lead }) -
        Token.estimate(note(exchanges.length))
      const kept = exchanges.slice(oldestToDrop(exchanges, (text) => Token.estimate(text) + 1, room))
      if (kept.length === 0) return undefined
      return LLMRequest.update(request, {
        messages: [...lead, Message.user(note(exchanges.length - kept.length) + kept.join("\n\n"))],
      })
    }

    const stream = (context: SessionContext.Loaded, request: LLMRequest, options: StreamOptions) => {
      const sessionID = context.session.id
      const metadataKey = context.model.model.route.providerMetadataKey ?? context.model.model.provider
      const unusable = (error: SessionError.Error) => Effect.fail<Failure>({ error })
      // A call that failed or was interrupted after the response began was probably billed, though its usage never
      // arrived: an estimate keeps it from reading as free. A request the provider refused outright billed nothing.
      let observed = false
      let reported = false
      let streamedLength = 0

      return llm.stream(request, options).pipe(
        Stream.runFoldEffect(
          (): Streamed => ({ text: "" }),
          (streamed, event): Effect.Effect<Streamed, AIError | Failure> => {
            if (!LLMEvent.is.providerError(event)) observed = true
            if (LLMEvent.is.textDelta(event) || LLMEvent.is.reasoningDelta(event)) streamedLength += event.text.length
            if (LLMEvent.is.stepFinish(event)) reported = true
            if (LLMEvent.is.providerError(event)) {
              if (event.classification === undefined)
                return unusable({ type: "provider.error", message: event.message })
              return Effect.fail(
                new AIError({
                  reason: new InvalidRequestError({ message: event.message, classification: event.classification }),
                }),
              )
            }

            if (LLMEvent.is.textDelta(event)) {
              return bus
                .publish(SessionEvent.Compaction.Delta, { sessionID, text: event.text })
                .pipe(Effect.as({ ...streamed, text: streamed.text + event.text }))
            }

            if (LLMEvent.is.stepFinish(event)) {
              return spend(sessionID, SessionUsage.record(event.usage, context.model.cost)).pipe(
                Effect.as({ ...streamed, providerState: event.providerMetadata?.[metadataKey] }),
              )
            }

            if (!LLMEvent.is.finish(event)) return Effect.succeed(streamed)
            switch (event.reason.normalized) {
              case "unknown":
                return Effect.fail(
                  new AIError({
                    reason: new InvalidProviderOutputError({
                      message: "The provider response ended with an unknown finish reason.",
                      classification: "incomplete-stream",
                    }),
                  }),
                )
              case "error":
                return Effect.fail(
                  new AIError({ reason: new UnknownProviderError({ message: "Compaction generation failed" }) }),
                )
              case "content-filter":
                return unusable({
                  type: "provider.content-filter",
                  message: "Compaction summary was blocked by the provider",
                })
              default:
                return Effect.succeed(streamed)
            }
          },
        ),
        Effect.onError(() =>
          Effect.suspend(() =>
            observed && !reported
              ? spend(
                  sessionID,
                  SessionUsage.estimate(context.model.cost, {
                    input: estimateRequest(request),
                    output: Token.estimateLength(streamedLength),
                  }),
                )
              : Effect.void,
          ),
        ),
      )
    }

    /**
     * The conversation as the runner would send it, after request hooks.
     *
     * The output limit leaves room for `budget`, the most `deliver` sends. The request prepared here can be larger
     * when the conversation overshot the threshold, and is only shrunk to fit after hooks have seen it, so sizing the
     * output to it would leave next to no room. A prompt the estimate undersells is rejected and shrunk like any
     * other.
     */
    const prepare = (
      context: SessionContext.Loaded,
      messages: ReadonlyArray<SessionMessage.Info>,
      budget: number,
      webSocket?: "session",
    ) => {
      // Hints and the editor note belong to the request they were written for; the summary request lowers prompts the way the main request does on this instance.
      const base = transcript(context, messages, reminders.minimal, toolOutput.root)
      return requests.compaction({
        session: context.session,
        agent: context.agent.id,
        model: context.model,
        tools: context.tools,
        system: base.system,
        messages: base.messages,
        webSocket,
        inputTokens: { measured: budget, estimated: 0 },
      })
    }

    /** A request hook supplied the summary itself, so no model call happens. */
    const fromHook = (context: SessionContext.Loaded, supplied: SessionCompactionResult) => {
      const reported = supplied.tokens && {
        tokens: supplied.tokens,
        cost: SessionUsage.calculateCost(context.model.cost, supplied.tokens),
      }
      // A hook that reports no tokens ran no model, so there is nothing to record: a record of zero tokens would read
      // as spend the provider failed to report.
      const usage = reported && SessionUsage.hasTokens(reported) ? reported : undefined
      return spend(context.session.id, usage).pipe(
        Effect.as<Result>({
          text: supplied.summary,
          recent: "",
          providerState: supplied.providerState,
          metadata: supplied.metadata,
        }),
      )
    }

    /**
     * A call that completes is billed when it finishes, and one that fails or is interrupted after the provider began
     * to answer is billed by estimate; a request the provider refused before any response costs nothing. The
     * compaction's message shows the total across all of its calls. A session never runs two compactions at once.
     */
    const spent = new Map<SessionContext.Loaded["session"]["id"], SessionUsage.Recorded>()
    const spend = (sessionID: SessionContext.Loaded["session"]["id"], usage: SessionUsage.Recorded | undefined) =>
      Effect.gen(function* () {
        if (!usage) return
        const total = spent.get(sessionID)
        spent.set(sessionID, total ? SessionUsage.add(total, usage) : usage)
        yield* bus.publish(SessionEvent.UsageRecorded, { sessionID, source: "compaction", ...usage })
      })

    const publish = Effect.fnUntraced(function* (
      trigger: Trigger,
      outcome: Result | Failure,
    ): Effect.fn.Return<Outcome> {
      const context = trigger.context
      const sessionID = context.session.id
      const reason = trigger.reason === "manual" ? "manual" : "auto"
      const usage = spent.get(sessionID)

      if ("error" in outcome) {
        yield* bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason,
          inputID: trigger.reason === "manual" ? trigger.inputID : undefined,
          error: outcome.error,
          ...usage,
        })
        return { status: "failed", error: outcome.error }
      }

      yield* bus.publish(
        SessionEvent.Compaction.Ended,
        {
          sessionID,
          reason,
          model: context.model.ref,
          providerState: outcome.providerState,
          providerContext: outcome.providerContext,
          text: outcome.text,
          recent: outcome.recent,
          ...usage,
        },
        { metadata: outcome.metadata },
      )
      return { status: "completed" }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      // A manual compaction settles through its `/compact` inbox item, which the runner owns.
      thresholds: (context) => ({ auto: state.get().auto, thresholds: thresholds(context, state.get()) }),
      compact: (trigger) =>
        compact(trigger).pipe(
          Effect.onInterrupt(() =>
            trigger.reason === "manual"
              ? Effect.void
              : publish(trigger, { error: { type: "compaction.interrupted", message: "Compaction was interrupted" } }),
          ),
          Effect.ensuring(Effect.sync(() => spent.delete(trigger.context.session.id))),
        ),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, llmClient, SessionModelRequest.node, SessionReminders.node, ToolOutput.node],
})

/** What a compaction reads: no replaced attempts and no reminder rows, which are collected again after the checkpoint. */
const compactable = (messages: ReadonlyArray<SessionMessage.Info>) =>
  withoutReplaced(messages).filter((message) => !isReminder(message))

/** History loads from the latest completed compaction, so a previous one is always the first message. */
const previousCompaction = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const [first] = messages
  return first?.type === "compaction" && first.status === "completed" ? first : undefined
}

const transcript = (
  context: SessionContext.Loaded,
  messages: ReadonlyArray<SessionMessage.Info>,
  minimal?: boolean,
  toolOutput?: string,
) =>
  SessionModelRequest.baseTranscript({
    agent: context.agent.info,
    model: context.model,
    tools: context.tools,
    initial: context.initial,
    messages,
    minimal,
    toolOutput,
  })

/**
 * The same request for a reply that the first one did not give: a one-line system prompt, no media, no reasoning, and
 * only the read tool so that tool calls in the history stay valid. It is never run.
 */
const fallbackRequest = (request: LLMRequest, outputMax: number) =>
  LLMRequest.update(request, {
    system: [SystemPart.make(FALLBACK_SYSTEM)],
    messages: request.messages.flatMap(withoutMedia),
    tools: request.tools.filter((tool) => tool.name === "Read"),
    generation: GenerationOptions.make({ maxTokens: outputMax }),
    providerOptions: undefined,
  })

const placeholder = (mime: string) => (mime.toLowerCase().startsWith("image/") ? "[image]" : "[document]")

/** The message with media as bracketed text and reasoning effort notes left out; nothing when no content is left. */
const withoutMedia = (message: Message) => {
  const content = message.content.flatMap((part): ContentPart[] => {
    if (part.type === "effort") return []
    if (part.type === "media") return [{ type: "text", text: placeholder(part.media.mediaType) }]
    if (part.type !== "tool-result" || part.result.type !== "content") return [part]
    return [
      {
        ...part,
        result: {
          type: "content",
          value: part.result.value.map((item) =>
            item.type === "text" ? item : { type: "text", text: placeholder(item.mime) },
          ),
        },
      },
    ]
  })
  return content.length === 0 ? [] : [Message.make({ ...message, content })]
}

/**
 * Drops the oldest round groups, each starting at an assistant message, until they cover the gap the provider reported
 * (a fifth of the groups when it gave none). One group always stays. Undefined when nothing can be dropped.
 */
const dropOldestGroups = (messages: ReadonlyArray<Message>, rejection: string) => {
  const groups = messages.reduce<Message[][]>((all, message) => {
    if (message.role === "assistant" || all.length === 0) all.push([message])
    else all[all.length - 1].push(message)
    return all
  }, [])
  if (groups.length < 2) return undefined

  const reported = /prompt is too long[^0-9]*([\d,]+)\s*tokens?\s*>\s*([\d,]+)/i.exec(rejection)
  const gap = reported ? Number(reported[1].replaceAll(",", "")) - Number(reported[2].replaceAll(",", "")) : 0
  const count =
    gap > 0
      ? groups.slice(0, -1).reduce(
          (state, group) => {
            if (state.covered >= gap) return state
            return {
              covered: state.covered + group.reduce((sum, message) => sum + estimateMessage(message), 0),
              count: state.count + 1,
            }
          },
          { covered: 0, count: 0 },
        ).count
      : Math.max(1, Math.floor(groups.length * 0.2))
  return groups.slice(Math.min(count, groups.length - 1)).flat()
}

const oldestToDrop = <T>(items: ReadonlyArray<T>, size: (item: T) => number, budget: number) => {
  let total = 0
  let start = items.length
  while (start > 0) {
    const next = total + size(items[start - 1])
    if (next > budget) break
    total = next
    start--
  }
  return start
}

/** Whether a message holds conversation that a compaction can cover. Checkpoints and instruction updates do not. */
const covered = (message: SessionMessage.Info) => {
  switch (message.type) {
    case "user":
    case "location-switched":
    case "skill":
      return true
    case "assistant":
      return message.content.some((part) => part.type !== "reasoning" || part.text)
    // Reminders are collected again after the checkpoint, so none is summarized.
    case "synthetic":
      return !isReminder(message)
    case "shell":
      return message.metadata?.background !== true
    default:
      return false
  }
}

const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value

  // Count code points so a surrogate pair is never split.
  let end = 0
  let kept = 0
  for (const char of value) {
    if (kept === TOOL_OUTPUT_MAX_CHARS) break
    end += char.length
    kept++
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

/** One request message as a flattened transcript line. Empty for what the transcript leaves out. */
const flattenMessage = (message: Message) => {
  if (message.role === "system") return ""
  return message.content
    .flatMap((part) => {
      if (part.type === "text")
        return part.text ? [`[${message.role === "user" ? "User" : "Assistant"}]: ${part.text}`] : []
      if (part.type === "media") return [`[${part.media.mediaType} omitted]`]
      if (part.type === "tool-call") return [`[Assistant tool call]: ${part.name}(${JSON.stringify(part.input) ?? ""})`]
      if (part.type !== "tool-result") return []
      const result = part.result
      const output =
        result.type === "content"
          ? serializeToolContent(result.value)
          : typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value) ?? "")
      const label = result.type === "error" ? "Tool error" : "Tool result"
      return [`[${label}]: ${truncateToolOutput(output)}`]
    })
    .join("\n")
}

const serializeToolContent = (content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>) =>
  content
    .map((item) => {
      if (item.type === "text") return item.text
      return `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`
    })
    .join("\n")

/** The newest whole, real user messages within `keep` tokens: no synthetic guidance, no half of an attachment. */
export const recentUserMessages = (
  messages: ReadonlyArray<SessionMessage.Info>,
  model: Pick<SessionContext.Loaded["model"], "ref" | "capabilities">,
  keep: number,
) => {
  const users = messages
    .filter((message) => message.type === "user")
    .map((message) => ({ ...message, skills: undefined, agents: undefined, editor: undefined }))
  const sendable = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(toLLMMessages(users, model.ref), model.capabilities),
  )
  return sendable.slice(oldestToDrop(sendable, estimateMessage, keep))
}

export const estimateContext = (context: SessionContext.Loaded, minimal?: boolean, toolOutput?: string) => {
  const prompt = estimatePrompt(context, minimal, toolOutput)
  return prompt.measured + prompt.estimated
}

/** The prompt size: `measured` is what the provider reported at the latest response, `estimated` is the text since. */
export const estimatePrompt = (context: SessionContext.Loaded, minimal?: boolean, toolOutput?: string) => {
  const messages = withoutReplaced(context.messages)
  const anchorIndex = messages.findLastIndex((message) => hasMeasuredPrompt(message, context.model.ref))
  const anchor = messages[anchorIndex]
  const base = transcript(context, messages.slice(Math.max(0, anchorIndex)), minimal, toolOutput)
  // TODO: Pass compaction history the runner has already shaped. This and `recentUserMessages` repeat the
  // runner's unsupported-media and image-budget passes; here the image budget only sees images since the anchor,
  // so image-heavy sessions can estimate high.
  const sent = SessionModelRequest.boundImages(
    SessionModelRequest.unsupportedParts(base.messages, context.model.capabilities),
  )
  // The anchor's usage covers its own output, but not its local tool results, which the provider never saw.
  const unmeasured = sent.filter((message) => message.role !== "assistant" || message.id !== anchor?.id)

  if (anchor?.type !== "assistant" || !anchor.tokens)
    return {
      measured: 0,
      estimated: estimateRequest({ system: base.system, tools: context.tools.definitions, messages: unmeasured }),
    }

  const tokens = anchor.tokens
  return {
    measured: tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning,
    estimated: unmeasured.reduce((sum, message) => sum + estimateMessage(message), 0),
  }
}

/**
 * Another provider's count may describe a native window this model cannot replay. History then holds the original
 * messages that window stood for, which the count leaves out, so only the current provider's counts are trusted.
 */
const hasMeasuredPrompt = (message: SessionMessage.Info, model: SessionContext.Loaded["model"]["ref"]) =>
  message.type === "assistant" &&
  message.model.providerID === model.providerID &&
  !message.error &&
  message.tokens !== undefined &&
  message.tokens.input + message.tokens.cache.read + message.tokens.cache.write > 0

export const estimateRequest = (request: Pick<LLMRequest, "system" | "tools" | "messages">) =>
  request.system.reduce((sum, part) => sum + Token.estimate(part.text), 0) +
  request.tools.reduce((sum, tool) => sum + estimateTool(tool), 0) +
  request.messages.reduce((sum, message) => sum + estimateMessage(message), 0)

/** Only what providers receive; `metadata` and `native` stay local. */
const estimateTool = (tool: ToolEntry): number => {
  if (tool.type === "tool") return Token.estimate(tool.name + tool.description + JSON.stringify(tool.inputSchema))
  return (
    Token.estimate(tool.name + (tool.description ?? "")) +
    tool.tools.reduce((sum, entry) => sum + estimateTool(entry), 0)
  )
}

const estimateMessage = (message: Message) => message.content.reduce((sum, part) => sum + estimatePart(part), 0)

const estimatePart = (part: ContentPart): number => {
  // An encrypted native compaction has no locally measurable size.
  if (part.type === "compaction") return Token.estimate(part.text ?? "")
  if (part.type === "effort") return 0
  if (part.type === "text" || part.type === "reasoning") return Token.estimate(part.text)
  if (part.type === "media") return estimateMedia(part.media.mediaType)
  if (part.type === "tool-call") return Token.estimate(part.name + (JSON.stringify(part.input) ?? ""))

  if (part.result.type === "content")
    return part.result.value.reduce(
      (sum, content) => sum + (content.type === "text" ? Token.estimate(content.text) : estimateMedia(content.mime)),
      0,
    )
  const value = part.result.value
  return Token.estimate(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
}

const estimateMedia = (mime: string) => {
  const type = mime.toLowerCase()
  if (type.startsWith("image/")) return IMAGE_TOKEN_ESTIMATE
  if (type === "application/pdf") return PDF_TOKEN_ESTIMATE
  return 0
}
