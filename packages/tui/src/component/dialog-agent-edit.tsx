import { plain } from "@orbit/util/plain"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

/** An agent as the edit list needs it. */
export type EditableAgent = {
  id: string
  description?: string
  source?: { scope: string; path?: string; plugin?: string }
}

/**
 * The agents whose definition is a file of the person's or the project's. A managed, plugin, command-line or remote
 * definition, and an agent that Orbit ships, are not files to edit here.
 */
export function editable<T extends EditableAgent>(agents: readonly T[]) {
  return agents.filter(
    (agent) =>
      agent.source?.path !== undefined &&
      agent.source.plugin === undefined &&
      ["user", "project", "local"].includes(agent.source.scope),
  )
}

/** `/agents` > Edit: picks an agent file and opens it in the person's editor. */
export function DialogAgentEdit(props: {
  agents: readonly EditableAgent[]
  open: (file: string) => Promise<unknown>
  notify: (paths: string[]) => Promise<unknown>
  onBack: () => void
}) {
  const dialog = useDialog()
  const toast = useToast()
  return (
    <DialogSelect
      title="Edit an agent file"
      options={editable(props.agents).map((agent) => ({
        value: agent.source!.path!,
        title: plain(agent.id),
        description: plain(agent.source!.path!),
      }))}
      emptyView={<text>No agent here is a file you can edit.</text>}
      onSelect={async (option) => {
        const file = option.value
        dialog.clear()
        await props.open(file).then(
          async () => {
            await props.notify([file]).catch(() => undefined)
            toast.show({
              variant: "info",
              message: `Opened ${plain(file)}. The agent list refreshes once the file is saved.`,
            })
          },
          (error: unknown) =>
            toast.show({
              variant: "warning",
              message: `Could not open ${plain(file)}: ${plain(error instanceof Error ? error.message : String(error))}`,
            }),
        )
      }}
      onCancel={props.onBack}
    />
  )
}
