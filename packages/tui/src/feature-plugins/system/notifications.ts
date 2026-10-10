import { plain } from "@orbit/flow/plain"
import { Plugin } from "@orbit/plugin/tui"
import type { AttentionSoundName } from "@orbit/plugin/tui/context"

function notify(
  context: Plugin.Context,
  sessionID: string | undefined,
  message: string,
  sound: AttentionSoundName,
  title?: string,
) {
  const session = sessionID ? context.data.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void context.attention.notify({
    title: title ?? (session?.title ? plain(session.title) : undefined),
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

export default Plugin.define({
  id: "orbit.notifications",
  setup(context) {
    const errored = new Set<string>()
    const terminal = new Set<string>()
    const forms = new Set<string>()
    const permissions = new Set<string>()
    let reminder: ReturnType<typeof setTimeout> | undefined

    const cancelReminder = () => {
      clearTimeout(reminder)
      reminder = undefined
    }
    // One reminder per idle period: a keypress, a new execution or a pending request ends the period.
    const scheduleReminder = (sessionID: string) => {
      cancelReminder()
      const seconds = context.attention.idleReminder ?? 0
      if (seconds <= 0 || context.data.session.get(sessionID)?.parentID !== undefined) return
      if (forms.size + permissions.size > 0) return
      reminder = setTimeout(() => {
        reminder = undefined
        void context.attention.notify({
          title: "Orbit",
          message: "Orbit is waiting for your input",
          notification: { when: "blurred" },
          sound: { name: "default", when: "blurred" },
        })
      }, seconds * 1000)
    }
    context.renderer.keyInput.on("keypress", cancelReminder)

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
      const session = context.data.session.get(sessionID)
      notify(context, sessionID, "Session done", session?.parentID ? "subagent_done" : "done")
    }

    const dispose = [
      context.data.on("form.created", (event) => {
        if (forms.has(event.data.form.id)) return
        forms.add(event.data.form.id)
        cancelReminder()
        notify(context, event.data.form.sessionID, "Input needs response", "question", event.data.form.title)
      }),
      context.data.on("form.replied", (event) => forms.delete(event.data.id)),
      context.data.on("form.cancelled", (event) => forms.delete(event.data.id)),
      context.data.on("permission.asked", (event) => {
        if (permissions.has(event.data.id)) return
        permissions.add(event.data.id)
        cancelReminder()
        notify(context, event.data.sessionID, "Permission needs input", "permission")
      }),
      context.data.on("permission.replied", (event) => permissions.delete(event.data.requestID)),
      context.data.on("session.execution.started", (event) => started(event.data.sessionID)),
      context.data.on("session.execution.succeeded", (event) => ended(event.data.sessionID)),
      context.data.on("session.execution.interrupted", (event) => ended(event.data.sessionID)),
      context.data.on("session.execution.failed", (event) => {
        const sessionID = event.data.sessionID
        if (terminal.has(sessionID)) return
        if (errored.has(sessionID)) {
          ended(sessionID)
          return
        }
        errored.add(sessionID)
        notify(context, sessionID, event.data.error.message, "error")
        context.ui.toast.show({ sessionID, title: "Session failed", message: event.data.error.message, variant: "error" })
        ended(sessionID)
      }),
    ]

    return () => {
      cancelReminder()
      context.renderer.keyInput.off("keypress", cancelReminder)
      dispose.reverse().forEach((cleanup) => cleanup())
    }
  },
})
