// The next-prompt suggestion, shared by the full TUI and Mini. When a turn of a session ends well, the client asks its
// server what the person might type next and holds the answer for that session, to be drawn dimmed in its empty prompt.
// At most one request is out per session. Typing cancels a request that is out, a turn starting in the session or a
// prompt sent from it ends the suggestion, and an answer that cannot be drawn when it comes is dropped, as the
// reference drops one it has not shown. The server decides whether a suggestion is due; a refusal, a failure or an
// answer of another shape holds nothing and writes one log line (class 7).
import { SessionAssist } from "@orbit/schema/session-assist"
import { Option, Schema } from "effect"
import { createSignal } from "solid-js"

const decode = Schema.decodeUnknownOption(SessionAssist.Suggestion)

/** One session's suggestion, as a prompt sees it. */
export type PromptSuggestion = {
  /** The held suggestion as the model wrote it; whoever draws or takes it escapes it first (class 9). */
  text: () => string | undefined
  /** The input changed: a request that is out is cancelled, and a held suggestion stays. */
  changed: () => void
  /** A prompt was sent: the held suggestion ends. */
  submitted: () => void
  /**
   * Registers whether the prompt could draw a suggestion now. An answer that comes while it could not is dropped; a
   * session with no prompt in view keeps its answer for when one returns.
   */
  watch?: (drawable: () => boolean) => () => void
}

export function createPromptSuggestions(input: {
  /** Asks the server for the session's suggestion. The signal aborts when the request is cancelled. */
  request: (sessionID: string, signal: AbortSignal) => Promise<unknown>
  log?: (message: string, extra: Record<string, unknown>) => void
}) {
  const [held, setHeld] = createSignal<Readonly<Record<string, string>>>({})
  const inflight = new Map<string, AbortController>()
  const prompts = new Map<string, () => boolean>()

  const cancel = (sessionID: string) => {
    inflight.get(sessionID)?.abort()
    inflight.delete(sessionID)
  }
  const clear = (sessionID: string) => {
    if (held()[sessionID] === undefined) return
    setHeld((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== sessionID)))
  }
  const settle = (sessionID: string, controller: AbortController, answer: unknown) => {
    if (inflight.get(sessionID) !== controller) return
    inflight.delete(sessionID)
    const decoded = decode(answer)
    if (Option.isNone(decoded)) return input.log?.("the suggestion answer has another shape", { sessionID })
    const text = decoded.value.suggestion
    if (text === null) return input.log?.("no suggestion", { sessionID, reason: decoded.value.reason })
    if (prompts.get(sessionID)?.() === false)
      return input.log?.("the suggestion came when it could not be drawn", { sessionID })
    setHeld((previous) => ({ ...previous, [sessionID]: text }))
  }

  return {
    /** A turn of the session ended well: ask again, cancelling a request still out. */
    ended(sessionID: string) {
      cancel(sessionID)
      const controller = new AbortController()
      inflight.set(sessionID, controller)
      void input.request(sessionID, controller.signal).then(
        (answer) => settle(sessionID, controller, answer),
        (error: unknown) => {
          if (inflight.get(sessionID) !== controller) return
          inflight.delete(sessionID)
          input.log?.("the suggestion request failed", { sessionID, error })
        },
      )
    },
    /** A turn started in the session: its suggestion ends, and so does a request that is out. */
    started(sessionID: string) {
      cancel(sessionID)
      clear(sessionID)
    },
    session(sessionID: string) {
      return {
        text: () => held()[sessionID],
        changed: () => cancel(sessionID),
        submitted: () => clear(sessionID),
        watch(drawable: () => boolean) {
          prompts.set(sessionID, drawable)
          return () => {
            if (prompts.get(sessionID) === drawable) prompts.delete(sessionID)
          }
        },
      }
    },
    dispose() {
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
    },
  }
}
