import { plain } from "@orbit/flow/plain"
import type { Attention, AttentionSoundName } from "@orbit/plugin/tui/context"

/** The events that can need a person, as the TUI and Mini both receive them. */
export type AttentionEvent =
  | { type: "permission.asked"; data: { id: string; sessionID: string } }
  | { type: "permission.replied"; data: { requestID: string } }
  | { type: "form.created"; data: { form: { id: string; sessionID: string; title?: string } } }
  | { type: "form.replied" | "form.cancelled"; data: { id: string } }
  | { type: "session.execution.started" | "session.execution.succeeded" | "session.execution.interrupted"; data: { sessionID: string } }
  | { type: "session.execution.failed"; data: { sessionID: string; error: { message: string } } }

const TYPES = new Set<string>([
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
])

/** Narrows a stream of every event to the ones `createAttentionEvents` reads. */
export function isAttentionEvent(event: { type: string }): event is AttentionEvent {
  return TYPES.has(event.type)
}

/**
 * Turns session events into attention requests: an ask or a form needs input, an execution that ends is done or failed,
 * and a finished root session starts the idle reminder. The TUI and Mini share it so they notify the same way.
 */
export function createAttentionEvents(input: {
  attention: Pick<Attention, "notify" | "idleReminder">
  /** What is known of a session: a subagent has a parent, and a title names the session in the notification. */
  session: (sessionID: string) => { title?: string; parentID?: string } | undefined
  /** Mini has no toasts. */
  toast?: (toast: { sessionID: string; title: string; message: string; variant: "error" }) => void
}) {
  const errored = new Set<string>()
  const terminal = new Set<string>()
  const forms = new Set<string>()
  const permissions = new Set<string>()
  let reminder: ReturnType<typeof setTimeout> | undefined

  const cancelReminder = () => {
    clearTimeout(reminder)
    reminder = undefined
  }

  // Every string that came from a session, a form or an error goes through `plain`: it leaves the terminal here.
  const notify = (sessionID: string, message: string, sound: AttentionSoundName, title?: string) => {
    const session = input.session(sessionID)
    void input.attention.notify({
      title: title ?? (session?.title ? plain(session.title) : undefined),
      message,
      // A subagent's ask needs a person like a root's does; its completion says nothing the person must act on.
      notification: session?.parentID !== undefined && (sound === "done" || sound === "subagent_done" || sound === "error")
        ? false
        : { when: "blurred" },
      sound: { name: sound, when: "always" },
    })
  }

  // One reminder per idle period: a keypress, a new execution or a pending request ends the period.
  const scheduleReminder = (sessionID: string) => {
    // A subagent finishing says nothing about whether the person is idle, so it leaves a root's reminder alone.
    if (input.session(sessionID)?.parentID !== undefined) return
    cancelReminder()
    const seconds = input.attention.idleReminder ?? 0
    if (seconds <= 0) return
    if (forms.size + permissions.size > 0) return
    reminder = setTimeout(() => {
      reminder = undefined
      void input.attention.notify({
        title: "Orbit",
        message: "Orbit is waiting for your input",
        notification: { when: "blurred" },
        sound: { name: "default", when: "blurred" },
        bell: { when: "blurred" },
      })
    }, seconds * 1000)
  }

  const started = (sessionID: string) => {
    errored.delete(sessionID)
    terminal.delete(sessionID)
    cancelReminder()
  }
  const ended = (sessionID: string) => {
    if (terminal.has(sessionID)) return
    terminal.add(sessionID)
    scheduleReminder(sessionID)
    if (errored.has(sessionID)) {
      errored.delete(sessionID)
      return
    }
    notify(sessionID, "Session done", input.session(sessionID)?.parentID ? "subagent_done" : "done")
  }

  return {
    handle(event: AttentionEvent) {
      switch (event.type) {
        case "form.created": {
          if (forms.has(event.data.form.id)) return
          forms.add(event.data.form.id)
          cancelReminder()
          notify(
            event.data.form.sessionID,
            "Input needs response",
            "question",
            event.data.form.title ? plain(event.data.form.title) : undefined,
          )
          return
        }
        case "form.replied":
        case "form.cancelled":
          forms.delete(event.data.id)
          return
        case "permission.asked": {
          if (permissions.has(event.data.id)) return
          permissions.add(event.data.id)
          cancelReminder()
          notify(event.data.sessionID, "Permission needs input", "permission")
          return
        }
        case "permission.replied":
          permissions.delete(event.data.requestID)
          return
        case "session.execution.started":
          started(event.data.sessionID)
          return
        case "session.execution.succeeded":
        case "session.execution.interrupted":
          ended(event.data.sessionID)
          return
        case "session.execution.failed": {
          const sessionID = event.data.sessionID
          if (terminal.has(sessionID)) return
          if (errored.has(sessionID)) {
            ended(sessionID)
            return
          }
          errored.add(sessionID)
          const message = plain(event.data.error.message)
          notify(sessionID, message, "error")
          input.toast?.({ sessionID, title: "Session failed", message, variant: "error" })
          ended(sessionID)
          return
        }
      }
    },
    /** Any key the person presses ends the idle period. */
    keypress: cancelReminder,
    dispose: cancelReminder,
  }
}
