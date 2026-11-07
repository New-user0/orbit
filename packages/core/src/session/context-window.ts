export * as SessionContextWindow from "./context-window.js"

/** The most room kept free for the summary's output. */
export const SUMMARY_RESERVE_MAX = 20_000
/** Tokens kept free below the effective window before automatic compaction starts, unless `compaction.buffer` says otherwise. */
export const AUTO_BUFFER = 13_000
/** The warning and error states both start this far below the point the indicator counts down to. */
export const WARNING_BAND = 20_000
/** With automatic compaction off, a request this close to the effective window is refused before it is sent. */
export const BLOCKING_BUFFER = 3_000
/** Failed automatic compactions in a row after which the turn stops trying. */
export const BREAKER_LIMIT = 3

export type Limit = { readonly context: number; readonly input?: number; readonly output: number }

export type Thresholds = {
  /** The model's input window. */
  readonly window: number
  /** The window less the room kept for the summary's output. */
  readonly effective: number
  /** The context size at which automatic compaction starts. */
  readonly threshold: number
  /** The context size at which a request is refused when automatic compaction is off. */
  readonly blocking: number
}

/**
 * The room the summary keeps for its output: the smaller of the output cap, the model's output limit and 20,000, and
 * never more than half a known window, so a model whose output limit matches its window still has room for the request.
 */
export const reserve = (limit: Limit, outputTokenCap?: number) => {
  const window = limit.input || limit.context
  return Math.min(
    SUMMARY_RESERVE_MAX,
    limit.output > 0 ? limit.output : SUMMARY_RESERVE_MAX,
    outputTokenCap ?? SUMMARY_RESERVE_MAX,
    window > 0 ? Math.floor(window / 2) : SUMMARY_RESERVE_MAX,
  )
}

/**
 * Undefined when the model's window is unknown, which is reported as 0. The summary keeps the smaller of the output
 * cap, the model's output limit and 20,000 tokens free. Automatic compaction never starts below half the window, so a
 * small window or a large buffer cannot make every request compact.
 */
export const thresholds = (input: {
  readonly limit: Limit
  readonly outputTokenCap?: number
  readonly buffer?: number
}): Thresholds | undefined => {
  const window = input.limit.input || input.limit.context
  if (window <= 0) return undefined
  const effective = window - reserve(input.limit, input.outputTokenCap)
  const threshold = Math.max(effective - (input.buffer ?? AUTO_BUFFER), Math.floor(window / 2))
  return { window, effective, threshold, blocking: Math.max(effective - BLOCKING_BUFFER, threshold) }
}

/** `percentLeft` counts down to the threshold with automatic compaction on and to the effective window with it off. */
export const state = (used: number, found: Thresholds, auto: boolean) => {
  const point = auto ? found.threshold : found.effective
  return {
    percentLeft: Math.max(0, Math.round(((point - used) / point) * 100)),
    state: used >= point - WARNING_BAND ? ("error" as const) : ("ok" as const),
  }
}
