import { Plugin } from "@orbit/plugin/tui"
import { createAttentionEvents } from "../../attention-events"

export default Plugin.define({
  id: "orbit.notifications",
  setup(context) {
    const events = createAttentionEvents({
      attention: context.attention,
      session: (sessionID) => context.data.session.get(sessionID),
      // The store's lists of open requests, which are read again after a reconnect.
      pending: (sessionID) =>
        context.data.session
          .family(context.data.session.root(sessionID))
          .some(
            (id) =>
              (context.data.session.permission.list(id)?.length ?? 0) + (context.data.session.form.list(id)?.length ?? 0) > 0,
          ),
      toast: (toast) => context.ui.toast.show(toast),
    })
    context.renderer.keyInput.on("keypress", events.keypress)

    const dispose = [
      context.data.on("form.created", events.handle),
      context.data.on("form.replied", events.handle),
      context.data.on("form.cancelled", events.handle),
      context.data.on("permission.asked", events.handle),
      context.data.on("permission.replied", events.handle),
      context.data.on("session.execution.started", events.handle),
      context.data.on("session.execution.succeeded", events.handle),
      context.data.on("session.execution.interrupted", events.handle),
      context.data.on("session.execution.failed", events.handle),
    ]

    return () => {
      events.dispose()
      context.renderer.keyInput.off("keypress", events.keypress)
      dispose.reverse().forEach((cleanup) => cleanup())
    }
  },
})
