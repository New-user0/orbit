// The away summary's trigger, shared by the full TUI and Mini. After the terminal has been unfocused for the configured
// minutes, the session asks its server for one recap. A turn in progress defers the request to the turn's end, coming
// back cancels the timer and drops a request in flight, and a terminal that never reports focus never asks. The server
// decides whether a recap is due and records it; a refusal or a failure is silent.

type FocusHost = {
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
}

export function createRecapTrigger(input: {
  renderer: FocusHost
  /** `session.recap.after_minutes`; 0 turns the recap off. */
  afterMinutes: () => number
  /** Whether the session is running a turn. */
  busy: () => boolean
  /** Whether a recap may be due; the full TUI checks the transcript it holds, so a blur after a recap sends nothing. */
  due?: () => boolean
  /** Asks the server for a recap. The signal aborts when the person comes back. */
  request: (signal: AbortSignal) => Promise<unknown>
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The delay ended during a turn, so the request waits for the turn's end.
  let deferred = false
  let inflight: AbortController | undefined

  const ask = () => {
    if (inflight || input.due?.() === false) return
    const controller = new AbortController()
    inflight = controller
    void input
      .request(controller.signal)
      .catch(() => {})
      .finally(() => {
        if (inflight === controller) inflight = undefined
      })
  }

  const onBlur = () => {
    const minutes = input.afterMinutes()
    if (minutes <= 0) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (input.busy()) {
        deferred = true
        return
      }
      ask()
    }, minutes * 60_000)
  }

  const onFocus = () => {
    clearTimeout(timer)
    deferred = false
    // A request the server is still answering is dropped, and the next blur may ask again at once.
    inflight?.abort()
    inflight = undefined
  }

  input.renderer.on("blur", onBlur)
  input.renderer.on("focus", onFocus)

  return {
    /** The session's turn ended: a deferred request goes out now. Coming back has already cleared one. */
    idle() {
      if (!deferred) return
      deferred = false
      ask()
    },
    dispose() {
      input.renderer.off("blur", onBlur)
      input.renderer.off("focus", onFocus)
      onFocus()
    },
  }
}
