import { createMemo, createSignal } from "solid-js"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { searchPromptHistory, type PromptInfo } from "../../prompt/history"

/**
 * Searches the prompts that were sent before. The list narrows as the person types, puts prompts sent from `directory`
 * first, and hands the chosen one to `onSelect` to load into the composer.
 */
export function DialogHistorySearch(props: {
  entries: readonly PromptInfo[]
  directory?: string
  onSelect: (entry: PromptInfo) => void
}) {
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const options = createMemo(() =>
    searchPromptHistory(props.entries, query(), props.directory).map((entry) => {
      const lines = entry.text.split("\n")
      return {
        title: `${entry.mode === "shell" ? "! " : ""}${Locale.truncate(lines[0]?.trim() || "(empty)", 60)}`,
        value: entry,
        description: entry.time ? Locale.datetime(entry.time) : undefined,
        footer: lines.length > 1 ? `~${lines.length} lines` : undefined,
      }
    }),
  )

  return (
    <DialogSelect
      title="Search prompt history"
      placeholder="Search your earlier prompts"
      options={options()}
      skipFilter
      flat
      onFilter={setQuery}
      onSelect={(option) => {
        dialog.clear()
        props.onSelect(option.value)
      }}
    />
  )
}
