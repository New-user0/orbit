import { Effect, Option, Ref, Stream } from "effect"
import { AIError, LLMEvent, type ProviderMetadata, type ToolCall } from "../../schema/index.js"
import { eventError, parseToolInput, type ToolAccumulator } from "../shared.js"
import { parse } from "./partial-json.js"

type StreamKey = string | number
const parsePartialInput = Option.liftThrowable(parse)

/**
 * One pending streamed tool call. Providers emit the tool identity and JSON
 * argument text across separate chunks; `input` is the raw JSON string collected
 * so far, not the parsed object.
 */
export interface PendingTool extends ToolAccumulator {
  readonly providerExecuted?: boolean
  readonly providerMetadata?: ProviderMetadata
}

/**
 * Sparse parser state keyed by the provider's stream-local tool identifier.
 *
 * This key is not the final tool-call id (`call_...`). It is the id/index the
 * provider uses while streaming a partial call: OpenAI Chat / Anthropic /
 * Bedrock use numeric content indexes, while OpenAI Responses uses string
 * `item_id`s. The generic keeps each protocol internally consistent.
 */
export type State<K extends StreamKey> = Partial<Record<K, PendingTool>>

/**
 * Result of adding argument text to one pending tool call. It returns both the
 * next `tools` state and the updated `tool` because parsers often need the
 * current id/name immediately. `events` contains lifecycle and delta events
 * produced by the append; metadata-only deltas update identity without output.
 */
export interface AppendOutcome<K extends StreamKey> {
  readonly tools: State<K>
  readonly tool: PendingTool
  readonly events: ReadonlyArray<LLMEvent>
}

/** Create empty accumulator state for one provider stream. */
export const empty = <K extends StreamKey>(): State<K> => ({})

const withTool = <K extends StreamKey>(tools: State<K>, key: K, tool: PendingTool): State<K> => {
  return { ...tools, [key]: tool }
}

const withoutTool = <K extends StreamKey>(tools: State<K>, key: K): State<K> => {
  const next = { ...tools }
  delete next[key]
  return next
}

const inputStart = (tool: PendingTool) =>
  LLMEvent.toolInputStart({
    id: tool.id,
    name: tool.name,
    namespace: tool.namespace,
    providerExecuted: tool.providerExecuted ? true : undefined,
    providerMetadata: tool.providerMetadata,
  })

const inputDelta = (tool: PendingTool, text: string) =>
  LLMEvent.toolInputDelta({
    id: tool.id,
    name: tool.name,
    namespace: tool.namespace,
    text,
    input: Option.getOrElse(parsePartialInput(tool.input), () => ({})),
  })

const toolCall = (route: string, tool: PendingTool, inputOverride?: string, emptyIsComplete = false) => {
  const raw = inputOverride ?? tool.input
  const call = (input: unknown, partialInput?: true) =>
    LLMEvent.toolCall({
      id: tool.id,
      name: tool.name,
      namespace: tool.namespace,
      input,
      providerExecuted: tool.providerExecuted ? true : undefined,
      providerMetadata: tool.providerMetadata,
      ...(partialInput ? { partialInput } : {}),
    })
  // Empty input parses as `{}`, and a call cut off before its first argument token looks exactly like a call to a tool
  // that takes no arguments (some providers stream `""` for those). Marked, so it waits for the finish: `tool-calls` or
  // `stop` releases it with `{}`, any other finish drops it.
  return parseToolInput(route, tool.name, raw).pipe(
    Effect.map((input) => (raw.trim() === "" && !tool.providerExecuted && !emptyIsComplete ? call(input, true) : call(input))),
    Effect.catch((error) =>
      tool.providerExecuted
        ? Effect.fail(error)
        : // Marked, because input rebuilt from incomplete JSON must not run unless the response finished cleanly.
          Effect.succeed(
            call(
              Option.getOrElse(
                Option.map(parsePartialInput(raw), (input) => input ?? {}),
                () => ({}),
              ),
              true,
            ),
          ),
    ),
  )
}

const finishEvents = (tool: PendingTool, event: ToolCall): ReadonlyArray<LLMEvent> => [
  LLMEvent.toolInputEnd({
    id: tool.id,
    name: tool.name,
    namespace: tool.namespace,
    providerMetadata: tool.providerMetadata,
  }),
  event,
]

/** Store the updated tool and produce the optional public delta event. */
const appendTool = <K extends StreamKey>(
  tools: State<K>,
  key: K,
  tool: PendingTool,
  text: string,
): AppendOutcome<K> => {
  const events: LLMEvent[] = []
  if (!tools[key]) events.push(inputStart(tool))
  if (text.length > 0) events.push(inputDelta(tool, text))
  return {
    tools: withTool(tools, key, tool),
    tool,
    events,
  }
}

export const isError = <K extends StreamKey>(result: AppendOutcome<K> | AIError): result is AIError =>
  result instanceof AIError

/**
 * Register a tool call whose start event arrived before any argument deltas.
 * Used by Anthropic `content_block_start`, Bedrock `contentBlockStart`, and
 * OpenAI Responses `response.output_item.added`.
 */
export const start = <K extends StreamKey>(
  tools: State<K>,
  key: K,
  tool: Omit<PendingTool, "input"> & { readonly input?: string },
) => withTool(tools, key, { ...tool, input: tool.input ?? "" })

/**
 * Append a streamed argument delta, starting the tool if this provider encodes
 * identity on the first delta instead of a separate start event. OpenAI Chat has
 * this shape: `tool_calls[].index` is the stream key, and `id` / `name` may only
 * appear on the first delta for that index.
 */
export const appendOrStart = <K extends StreamKey>(
  route: string,
  tools: State<K>,
  key: K,
  delta: {
    readonly id?: string
    readonly name?: string
    readonly text: string
    readonly providerMetadata?: ProviderMetadata
  },
  missingToolMessage: string,
): AppendOutcome<K> | AIError => {
  const current = tools[key]
  const id = current?.id ?? delta.id
  const name = current?.name ?? delta.name
  if (!id || !name) return eventError(route, missingToolMessage)

  const tool = {
    id,
    name,
    namespace: current?.namespace,
    input: `${current?.input ?? ""}${delta.text}`,
    providerExecuted: current?.providerExecuted,
    providerMetadata: current?.providerMetadata ?? delta.providerMetadata,
  }
  if (current && delta.text.length === 0 && current.id === id && current.name === name)
    return { tools, tool: current, events: [] }
  return appendTool(tools, key, tool, delta.text)
}

/**
 * Append argument text to a started tool. Returns `undefined` when no tool is
 * open under `key`, for protocols that ignore deltas without a matching block.
 */
export const append = <K extends StreamKey>(tools: State<K>, key: K, text: string): AppendOutcome<K> | undefined => {
  const current = tools[key]
  if (!current) return undefined
  if (text.length === 0) return { tools, tool: current, events: [] }
  return appendTool(tools, key, { ...current, input: `${current.input}${text}` }, text)
}

/**
 * Append argument text to a tool that must already have been started. This keeps
 * protocols honest when their stream grammar promises a start event before any
 * argument delta.
 */
export const appendExisting = <K extends StreamKey>(
  route: string,
  tools: State<K>,
  key: K,
  text: string,
  missingToolMessage: string,
): AppendOutcome<K> | AIError => append(tools, key, text) ?? eventError(route, missingToolMessage)

/**
 * Finalize one pending tool call: parse the accumulated raw JSON, remove it
 * from state, and recover incomplete local arguments when needed.
 * Missing keys are a no-op because some providers emit stop events for
 * non-tool content blocks.
 */
export const finish = <K extends StreamKey>(route: string, tools: State<K>, key: K) =>
  Effect.gen(function* () {
    const tool = tools[key]
    if (!tool) return { tools }
    return {
      tools: withoutTool(tools, key),
      events: finishEvents(tool, yield* toolCall(route, tool)),
    }
  })

/**
 * Finalize one pending tool call with an authoritative final input string.
 * OpenAI Responses can send accumulated deltas and then repeat the completed
 * arguments on `response.output_item.done`; the final value wins.
 */
export const finishWithInput = <K extends StreamKey>(route: string, tools: State<K>, key: K, input: string) =>
  Effect.gen(function* () {
    const tool = tools[key]
    if (!tool) return { tools }
    return {
      tools: withoutTool(tools, key),
      events: finishEvents(tool, yield* toolCall(route, tool, input)),
    }
  })

/**
 * Finalize every pending tool call at once. OpenAI Chat has this shape: it does
 * not emit per-tool stop events, so all accumulated calls finish independently
 * when the choice receives a terminal `finish_reason`.
 */
export const finishAll = <K extends StreamKey>(
  route: string,
  tools: State<K>,
  /** The stream ended with no finish reason to vouch either way: a call with no argument text is a no-argument call. */
  options?: { readonly emptyIsComplete?: boolean },
) =>
  Effect.gen(function* () {
    const pending = Object.values<PendingTool | undefined>(tools).filter(
      (tool): tool is PendingTool => tool !== undefined,
    )
    return {
      tools: empty<K>(),
      events: yield* Effect.forEach(pending, (tool) =>
        toolCall(route, tool, undefined, options?.emptyIsComplete).pipe(Effect.map((event) => finishEvents(tool, event))),
      ).pipe(Effect.map((events) => events.flat())),
    }
  })

interface Held {
  readonly event: ToolCall
  /** Still waiting for the finish. A call behind a held one is queued with `hold: false` only to keep provider order. */
  readonly hold: boolean
}

interface Gate {
  /** The oldest held call and every tool call that arrived after it, in arrival order. */
  readonly queue: ReadonlyArray<Held>
  /**
   * The latest finish since the current step started was `tool-calls` or `stop`, so a marked call that arrives now has
   * nothing left to wait for.
   */
  readonly released: boolean
  /** Ids of the blocks (tool input, text, reasoning) the provider started in this step, in order. */
  readonly starts: ReadonlyArray<string>
  /** Ids of tool inputs that streamed at least one argument character. */
  readonly streamed: ReadonlySet<string>
}

/**
 * Hold calls rebuilt from incomplete JSON or from no argument text (`partialInput`) until the response says how it
 * ended. A `tool-calls` or `stop` finish releases them just before it. Any other finish drops them, and so does a
 * stream that ends or fails without one, so a response cut off by an output limit does not run a call whose arguments
 * were half written. The `tool-input-*` events of a dropped call still pass, which leaves an input that was started and
 * never called for the consumer to settle.
 *
 * Provider order is kept: every tool call that arrives behind a held one waits in the same queue and leaves with it.
 * A call that streamed no argument text is also released as soon as the provider starts another block after it, since
 * only the last block of a response can be cut off by an output limit. A finish that drops held calls still emits the
 * calls queued behind them.
 * A marked call that arrives after a releasing finish passes straight through until the next step starts: each step is
 * decided by its own finish.
 */
export const gateOnFinish = <E, R>(events: Stream.Stream<LLMEvent, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const state = yield* Ref.make<Gate>({ queue: [], released: false, starts: [], streamed: new Set() })
      // A stream that ends or fails without a finish drops the held calls, and passes the ones queued behind them.
      const unheld = Effect.map(Ref.get(state), (current) =>
        Stream.fromIterable(current.queue.filter((item) => !item.hold).map((item) => item.event)),
      )
      return events.pipe(
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            const [next, out] = yield* gate(yield* Ref.get(state), event)
            yield* Ref.set(state, next)
            return out
          }),
        ),
        Stream.flattenIterable,
        Stream.catch((error) => Stream.unwrap(unheld).pipe(Stream.concat(Stream.fail(error)))),
        Stream.concat(Stream.unwrap(unheld)),
      )
    }),
  )

const gate = (state: Gate, event: LLMEvent): Effect.Effect<readonly [Gate, ReadonlyArray<LLMEvent>]> => {
  // An earlier step's clean finish does not vouch for a call from this one.
  if (LLMEvent.is.stepStart(event))
    return Effect.succeed([{ ...state, released: false, starts: [], streamed: new Set() }, [event]])
  if (LLMEvent.is.toolInputDelta(event))
    return Effect.succeed([event.text === "" ? state : { ...state, streamed: new Set(state.streamed).add(event.id) }, [event]])
  if (LLMEvent.is.toolInputStart(event) || LLMEvent.is.textStart(event) || LLMEvent.is.reasoningStart(event)) {
    // A new block proves every earlier no-argument call was complete: release them and the calls queued behind them.
    const next = { ...state, starts: [...state.starts, event.id] }
    const queue = next.queue.map((item) => (item.hold && isComplete(next, item.event) ? { ...item, hold: false } : item))
    const flushed = queue.findIndex((item) => item.hold)
    const out = (flushed === -1 ? queue : queue.slice(0, flushed)).map((item) => item.event)
    return Effect.succeed([{ ...next, queue: flushed === -1 ? [] : queue.slice(flushed) }, [...out, event]])
  }
  if (LLMEvent.is.toolCall(event)) {
    if (state.queue.length > 0) {
      const held = event.partialInput === true && !isComplete(state, event)
      return Effect.succeed([{ ...state, queue: [...state.queue, { event, hold: held }] }, []])
    }
    if (event.partialInput !== true || state.released || isComplete(state, event)) return Effect.succeed([state, [event]])
    return Effect.succeed([{ ...state, queue: [{ event, hold: true }] }, []])
  }
  if (!LLMEvent.is.stepFinish(event) && !LLMEvent.is.finish(event)) return Effect.succeed([state, [event]])
  const released = event.reason.normalized === "tool-calls" || event.reason.normalized === "stop"
  const dropped = released ? 0 : state.queue.filter((item) => item.hold).length
  const calls = state.queue.filter((item) => released || !item.hold).map((item) => item.event)
  const next = [{ ...state, queue: [], released }, [...calls, event]] as const
  if (dropped === 0) return Effect.succeed(next)
  return Effect.logWarning(
    `Dropped ${dropped} tool call(s) rebuilt from incomplete input: the response finished with "${event.reason.normalized}"`,
  ).pipe(Effect.as(next))
}

// A call that streamed no argument text is complete once the provider has started another block after it.
const isComplete = (state: Gate, call: ToolCall) => {
  const at = state.starts.lastIndexOf(call.id)
  return at !== -1 && at < state.starts.length - 1 && !state.streamed.has(call.id)
}

export * as ToolStream from "./tool-stream.js"
