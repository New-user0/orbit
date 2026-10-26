export * as SessionMicrocompaction from "./microcompaction.js"

import { Clock, DateTime, Effect } from "effect"
import type { Bus } from "../bus.js"
import { ToolNames } from "../tool/names.js"
import { SessionCompaction } from "./compaction.js"
import { SessionEvent } from "./event.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { clearedCalls, withoutReplaced } from "./runner/to-llm-message.js"

/** A session idle this long has a cold prompt cache, so changing the start of the request costs nothing more. */
export const IDLE_GAP_MS = 60 * 60 * 1000
/** The newest results of the tools below that are always kept. */
export const KEEP = 5

// Tools whose results are bulky and rarely needed again. Everything else (notebooks, language servers, MCP, agents,
// task output, todo lists, skills) is kept: their results cannot be read again or carry the session's own state.
const COMPACTABLE = new Set<string>([
  ToolNames.tools.read,
  ToolNames.tools.shell,
  ToolNames.powershell,
  ToolNames.tools.grep,
  ToolNames.tools.glob,
  ToolNames.tools.websearch,
  ToolNames.tools.webfetch,
  ToolNames.tools.edit,
  ToolNames.tools.write,
  ToolNames.tools.patch,
])

// Sessions migrated from the first version keep the names `bash` and `apply_patch` on their recorded calls, and the name
// table does not map them.
const MIGRATED = new Set(["bash", "apply_patch"])

/**
 * The old results to leave out of the next requests, or undefined when there are none or no reason to: the trigger is
 * `idle` when the newest assistant message's response ended an hour or more ago (time spent in its tools counts), else `pressure` when the caller says automatic
 * compaction is due. The newest `KEEP` calls of the tools above stay; an older call that has settled and that no earlier
 * clearing named goes. A hosted call never does (the provider replays its own state), and neither does a call still
 * running. `freed` is the saving of a set of calls in tokens, and a pass that saves none is not recorded.
 */
export const select = (input: {
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly now: number
  readonly pressure: boolean
  /** How many of the newest calls stay; fewer than one counts as one, so a clearing never takes everything. */
  readonly keep?: number
  readonly freed: (calls: ReadonlyMap<string, ReadonlySet<string>>) => number
}) => {
  const messages = withoutReplaced(input.messages)
  const newest = messages.findLast((message) => message.type === "assistant")
  const idle =
    newest?.type === "assistant" &&
    input.now - DateTime.toEpochMillis(newest.time.streamed ?? newest.time.completed ?? newest.time.created) >= IDLE_GAP_MS
  if (!idle && !input.pressure) return undefined

  const cleared = clearedCalls(messages)
  const calls = messages.flatMap((message) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part) =>
          part.type === "tool" && part.executed !== true && (COMPACTABLE.has(ToolNames.canonical(part.name)) || MIGRATED.has(part.name))
            ? [
                {
                  assistantMessageID: message.id,
                  id: part.id,
                  settled: part.state.status === "completed" || part.state.status === "error",
                },
              ]
            : [],
        ),
  )
  const tools = calls
    .slice(0, Math.max(0, calls.length - Math.max(1, input.keep ?? KEEP)))
    .filter((call) => call.settled && cleared.get(call.assistantMessageID)?.has(call.id) !== true)
    .map((call) => ({ assistantMessageID: call.assistantMessageID, id: call.id }))
  const [first, ...rest] = tools
  if (first === undefined) return undefined

  const named = new Map<string, Set<string>>()
  tools.forEach((tool) =>
    named.set(tool.assistantMessageID, (named.get(tool.assistantMessageID) ?? new Set()).add(tool.id)),
  )
  const freed = input.freed(named)
  if (freed <= 0) return undefined
  return { trigger: idle ? ("idle" as const) : ("pressure" as const), tools: [first, ...rest] as const, freed }
}

/**
 * Records the clearing `select` chose as one `session.context.cleared` event. The stored results are not touched:
 * lowering sends the placeholder for the calls the event names. Answers whether anything was recorded, so the caller
 * reloads the context before reading it.
 */
export const apply = Effect.fnUntraced(function* (input: {
  readonly bus: Bus.Interface
  readonly sessionID: SessionSchema.ID
  /** The history the next request is made from. */
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly model: Parameters<typeof SessionCompaction.estimateFreed>[2]
  /** Whether automatic compaction is due, which allows a clearing even when the session is not idle. */
  readonly pressure: boolean
  readonly toolOutput: string
}) {
  const selected = select({
    messages: input.messages,
    now: yield* Clock.currentTimeMillis,
    pressure: input.pressure,
    freed: (calls) =>
      SessionCompaction.estimateFreed(withoutReplaced(input.messages), calls, input.model, input.toolOutput),
  })
  if (selected === undefined) return false
  yield* input.bus.publish(SessionEvent.ContextCleared, {
    sessionID: input.sessionID,
    trigger: selected.trigger,
    tools: selected.tools,
  })
  return true
})
