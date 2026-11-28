import { createMemo, onCleanup } from "solid-js"
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
    // The main conversation of the session in view: that session, or the root a subagent's session in view runs under.
    // Undefined while a session on the way up is not known.
    const rootOf = (sessionID: string): ReturnType<typeof data.session.get> => {
      const session = data.session.get(sessionID)
      return session?.parentID ? rootOf(session.parentID) : session
    }
    const root = createMemo(() => (route.data.type === "session" ? rootOf(route.data.sessionID) : undefined))
    // The root's own folder, which is not always the folder in view: a subagent's session may run in another one.
    const rootTrusted = trust.folder(() => root()?.location.directory ?? data.location.default().directory)
    // Only the main conversation of the session in view is asked about, also while one of its subagents' sessions is in
    // view, so that it is drawn on the way back; a subagent's turn is not the person's. The ask is a spend choice, so it
    // needs prompt.suggestions on in the person's own cli.json (class 8), and it sends the root's conversation to a
    // model, so the root's own folder must be trusted (classes 1, 3 and 12). The server refuses an untrusted folder too.
    const asks = (sessionID: string) => {
      if (config.prompt?.suggestions !== true) return false
      if (root()?.id !== sessionID) return false
      return rootTrusted()
    }
    const subscriptions = [
      data.on("session.execution.succeeded", (event) => {
        if (asks(event.data.sessionID)) suggestions.ended(event.data.sessionID)
      }),
      data.on("session.execution.started", (event) => suggestions.started(event.data.sessionID)),
      // A busy period asks only when the model replied in it, so a /compact or a redo's wake asks nothing.
      data.on("session.step.ended", (event) => suggestions.replied(event.data.sessionID)),
      // A rewind of the conversation, from any client, takes away the turns the suggestion was written for.
      data.on("session.revert.staged", (event) => suggestions.started(event.data.sessionID)),
    ]
    onCleanup(() => {
      subscriptions.forEach((unsubscribe) => unsubscribe())
      suggestions.dispose()
    })
    return suggestions
  },
})
