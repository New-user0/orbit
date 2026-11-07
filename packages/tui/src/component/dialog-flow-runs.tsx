import { plain } from "@orbit/flow/plain"
import { createMemo, createResource } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

// Orbit Flow runs of the current directory, their nodes, and decisions on gates waiting for one. The run store is a
// local SQLite file, so this reads it directly, once the folder is trusted; @orbit/flow loads only when the dialog opens.
//
// The store is a file in the repository, so a clone brings its own, and the renderer writes text to the terminal as it
// is. Everything the store says that the dialog shows goes through `plain`, which writes control and format characters
// out; the values that the dialog acts on, such as the ID of a gate, stay as the store has them.

const marks = { running: "…", waiting: "?", succeeded: "✓", failed: "✗" }

// The run store of the folder in view, or undefined while that folder is not trusted. The store is a file a clone ships,
// so nothing reads or writes it before the person trusts the folder (the server is asked each time, and a failed answer
// counts as no, class 7), and it is found no higher than the project's folder the server resolved, which is the folder
// that decision covers (`Git.holder`, class 3, class 12).
function useStore() {
  const location = useLocation()
  const data = useData()
  const client = useClient()
  const directory = () => location.current?.directory ?? data.location.default().directory
  return {
    directory,
    open: async (folder: string) => {
      const status = await client.api.location.trust.get({ location: { directory: folder } }).catch(() => undefined)
      if (status?.trusted !== true) return undefined
      const found = await client.api.location.get({ location: { directory: folder } }).catch(() => undefined)
      const { openStore } = await import("@orbit/flow")
      return openStore(folder, found?.project.directory ?? folder)
    },
  }
}

export function DialogFlowRuns() {
  const dialog = useDialog()
  const store = useStore()
  const [runs] = createResource(store.directory, async (folder) => {
    const opened = await store.open(folder)
    if (!opened) return []
    const list = opened.runs(50)
    opened.close()
    return list
  })
  const options = createMemo(() =>
    (runs() ?? []).map((run) => ({
      value: run.id,
      title: `${marks[run.status]} ${plain(run.workflow)}`,
      description: `${plain(run.status)} · ${new Date(run.updated).toLocaleString()}`,
      category: run.status === "waiting" ? "Waiting for a decision" : "Runs",
      searchText: run.id,
    })),
  )
  return (
    <DialogSelect
      title="Orbit Flow runs"
      placeholder={runs.loading ? "Loading runs…" : "Search runs (orb flow run <file> starts one)"}
      options={options()}
      onSelect={(option) => dialog.replace(() => <DialogFlowRun run={option.value} />)}
    />
  )
}

export function DialogFlowRun(props: { readonly run: string }) {
  const dialog = useDialog()
  const store = useStore()
  const [nodes] = createResource(store.directory, async (folder) => {
    const opened = await store.open(folder)
    if (!opened) return []
    const list = [...opened.nodes(props.run).values()]
    opened.close()
    return list
  })
  const options = createMemo(() =>
    (nodes() ?? []).map((node) => {
      const usage = node.result?.usage as { input?: number; output?: number; cost?: number } | undefined
      return {
        value: node.id,
        title: `${marks[node.status]} ${plain(node.id)}`,
        description: plain(
          [
            node.status === "waiting" ? node.message : undefined,
            usage ? `${Number(usage.input ?? 0) + Number(usage.output ?? 0)} tokens` : undefined,
            node.error ? String(node.error.message) : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        category: node.status === "waiting" ? "Waiting for a decision" : "Nodes",
      }
    }),
  )
  return (
    <DialogSelect
      title={props.run}
      placeholder="Select a waiting gate to decide it"
      options={options()}
      onCancel={() => dialog.replace(() => <DialogFlowRuns />)}
      onSelect={(option) => {
        const node = nodes()?.find((item) => item.id === option.value)
        if (node?.status === "waiting")
          dialog.replace(() => <DialogFlowGate run={props.run} gate={node.id} message={node.message ?? ""} />)
      }}
    />
  )
}

export function DialogFlowGate(props: { readonly run: string; readonly gate: string; readonly message: string }) {
  const dialog = useDialog()
  const toast = useToast()
  const store = useStore()
  const decide = async (approved: boolean, note?: string) => {
    const opened = await store.open(store.directory())
    if (!opened) return toast.show({ title: "Not decided", message: "This folder is not trusted.", variant: "error" })
    const error = opened.decide(props.run, props.gate, approved, note)
    opened.close()
    if (error) return toast.show({ title: "Not decided", message: plain(error), variant: "error" })
    toast.show({
      title: approved ? `Approved ${plain(props.gate)}` : `Rejected ${plain(props.gate)}`,
      message: `Continue the run with: orb flow resume ${props.run}`,
      variant: "success",
    })
    dialog.replace(() => <DialogFlowRun run={props.run} />)
  }
  const withNote = (approved: boolean) =>
    dialog.replace(() => (
      <DialogPrompt
        title={`${approved ? "Approve" : "Reject"} ${plain(props.gate)}: note`}
        placeholder="A note the workflow receives with the decision"
        onConfirm={(note) => void decide(approved, note.trim() || undefined).catch(toast.error)}
        onCancel={() => dialog.replace(() => <DialogFlowGate {...props} />)}
      />
    ))
  return (
    <DialogSelect
      title={`${plain(props.gate)}: ${plain(props.message)}`}
      options={[
        { value: "approve", title: "Approve" },
        { value: "approve-note", title: "Approve with a note…" },
        { value: "reject", title: "Reject" },
        { value: "reject-note", title: "Reject with a note…" },
      ]}
      onCancel={() => dialog.replace(() => <DialogFlowRun run={props.run} />)}
      onSelect={(option) => {
        if (option.value === "approve-note") return withNote(true)
        if (option.value === "reject-note") return withNote(false)
        void decide(option.value === "approve").catch(toast.error)
      }}
    />
  )
}
