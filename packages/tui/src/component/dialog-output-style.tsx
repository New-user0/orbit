import { createMemo } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

const BUILT_IN = [
  { value: "default", title: "Default", description: "Concise answers focused on the task" },
  { value: "explanatory", title: "Explanatory", description: "Adds short design notes about the codebase and choices" },
  { value: "learning", title: "Learning", description: "Leaves small ORBIT:YOURS pieces for you to write" },
]

/** The output style that a location's config sets, or undefined when it sets none. */
export function configuredOutputStyle(
  data: ReturnType<typeof useData>,
  ref: Parameters<ReturnType<typeof useData>["location"]["config"]["list"]>[0],
) {
  const entry = data.location.config
    .list(ref)
    ?.findLast((item) => item.type === "document" && item.info.output_style !== undefined)
  return entry?.type === "document" ? (entry.info.output_style ?? undefined) : undefined
}

/** /output-style: choose how the agent communicates. Saved to the global Orbit config as output_style. */
export function DialogOutputStyle() {
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const dialog = useDialog()
  const toast = useToast()
  const current = createMemo(() => configuredOutputStyle(data, location.ref) ?? "default")
  // A custom style set in config stays selectable even though only the built-ins are listed by default.
  const options = createMemo(() =>
    BUILT_IN.some((style) => style.value === current())
      ? BUILT_IN
      : [...BUILT_IN, { value: current(), title: current(), description: "From your output-styles directory" }],
  )

  return (
    <DialogSelect
      title="Output style"
      placeholder="How the agent communicates"
      current={current()}
      options={options()}
      onSelect={(option) => {
        dialog.clear()
        void client.api.config
          .update({ output_style: option.value === "default" ? null : option.value })
          .then(() => toast.show({ message: `Output style: ${option.title}`, variant: "success" }))
          .catch(toast.error)
      }}
    />
  )
}
