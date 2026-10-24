import { createMemo } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect } from "../../ui/dialog-select"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { DialogFork } from "./dialog-fork"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  /** Rewinds to before this prompt: at once when nothing would be lost, otherwise through the picker's confirm step. */
  onRewind: (messageID: string) => unknown
}) {
  const data = useData()
  const clipboard = useClipboard()
  const toast = useToast()
  const message = createMemo(() => data.session.message.get(props.sessionID, props.messageID))

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Jump to",
          value: "message.jump",
          description: "view message in session",
          onSelect: (dialog) => dialog.clear(),
        },
        {
          title: "Rewind",
          value: "session.rewind",
          description: "code and/or conversation to before this prompt",
          onSelect: () => {
            if (message()?.type !== "user") return
            void props.onRewind(props.messageID)
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const value = message()
            if (!value) return
            const text =
              value.type === "user"
                ? value.text
                : value.type === "assistant"
                  ? value.content
                      .filter((content) => content.type === "text")
                      .map((content) => content.text)
                      .join("\n")
                  : "text" in value
                    ? value.text
                    : ""
            try {
              await clipboard.write(text)
              dialog.clear()
            } catch (error) {
              toast.error(error)
            }
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: (dialog) => {
            const value = message()
            if (!value || value.type !== "user") return
            dialog.replace(() => <DialogFork sessionID={props.sessionID} messageID={props.messageID} />)
          },
        },
      ]}
    />
  )
}
