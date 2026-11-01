import { onCleanup } from "solid-js"
import { useConfig } from "../config"
import { createPromptSuggestions } from "../prompt-suggestion"
import { useClient } from "./client"
import { useData } from "./data"
import { createSimpleContext } from "./helper"
import { useLog } from "./log"
import { useRoute } from "./route"
import { useTrust } from "./trust"

// The next-prompt suggestions of the full TUI, held by session for as long as it runs, so that a session's suggestion
// is drawn again when its prompt comes back into view.
export const { use: usePromptSuggestions, provider: PromptSuggestionProvider } = createSimpleContext({
  name: "PromptSuggestion",
  init: () => {
    const client = useClient()
    const data = useData()
    const route = useRoute()
    const trust = useTrust()
    const config = useConfig().data
    const log = useLog({ component: "prompt-suggestion" })
    const suggestions = createPromptSuggestions({
      request: (sessionID, signal) => client.api.session.assist.suggestion({ sessionID }, { signal }),
      log: (message, extra) => log.info(message, extra),
    })
    // Only the session in view is asked about, and only when it is a main conversation: a subagent's turn is not the
    // person's. The ask is a spend choice, so it needs prompt.suggestions on in the person's own cli.json (class 8), and
    // it sends the session's conversation to a model, so its folder must be trusted: the folder in view, which the
    // session route sets to that session's own (classes 1, 3 and 12). The server refuses an untrusted folder as well.
    const asks = (sessionID: string) => {
      if (config.prompt?.suggestions !== true) return false
      if (route.data.type !== "session" || route.data.sessionID !== sessionID) return false
      if (data.session.get(sessionID)?.parentID) return false
      return trust.status()?.trusted === true
    }
    const subscriptions = [
      data.on("session.execution.succeeded", (event) => {
        if (asks(event.data.sessionID)) suggestions.ended(event.data.sessionID)
      }),
      data.on("session.execution.started", (event) => suggestions.started(event.data.sessionID)),
    ]
    onCleanup(() => {
      subscriptions.forEach((unsubscribe) => unsubscribe())
      suggestions.dispose()
    })
    return suggestions
  },
})
