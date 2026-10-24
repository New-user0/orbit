import { Plugin } from "@orbit/plugin/tui"
import { onCleanup } from "solid-js"
import { useConfig } from "../../config"
import { createRecapTrigger } from "../../recap"

// The away summary for the session in view. Once focus has been gone for session.recap.after_minutes, the session asks
// its server for one recap, which arrives as a `recap` message and is drawn in the transcript.
export default Plugin.define({
  id: "orbit.recap",
  setup(context) {
    // Only the main conversation is recapped, as in the reference: a subagent's session in view asks for nothing.
    const current = () => {
      const route = context.ui.router.current()
      if (route.type !== "session") return undefined
      return context.data.session.get(route.sessionID)?.parentID ? undefined : route.sessionID
    }

    context.ui.slot({
      append: "app",
      render() {
        const config = useConfig().data
        const trigger = createRecapTrigger({
          renderer: context.renderer,
          afterMinutes: () => config.session.recap.after_minutes,
          busy: () => {
            const sessionID = current()
            return sessionID !== undefined && context.data.session.status(sessionID) === "running"
          },
          // At most one recap per turn of the person's input: a recap after their last prompt or `!` command means
          // none is due, so a blur after it sends nothing. The store holds only the newest page of messages, so when
          // that page has none of these the server decides; it holds the same rule for every client.
          due: () => {
            const sessionID = current()
            if (!sessionID) return false
            return (
              context.data.session.message
                .list(sessionID)
                .findLast((message) => message.type === "user" || message.type === "shell" || message.type === "recap")
                ?.type !== "recap"
            )
          },
          request: async (signal) => {
            const sessionID = current()
            if (sessionID) await context.client.session.recap({ sessionID }, { signal })
          },
        })
        const ended = (event: { data: { sessionID: string } }) => {
          if (event.data.sessionID === current()) trigger.idle()
        }
        const subscriptions = [
          context.data.on("session.execution.succeeded", ended),
          context.data.on("session.execution.failed", ended),
          context.data.on("session.execution.interrupted", ended),
        ]
        onCleanup(() => {
          subscriptions.forEach((unsubscribe) => unsubscribe())
          trigger.dispose()
        })
        return null
      },
    })
  },
})
