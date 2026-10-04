import { createMemo, createResource } from "solid-js"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

// Orbit Flow runs of the current directory, their nodes, and decisions on gates waiting for one. The run store is a
// local SQLite file, so this reads it directly; @orbit/flow loads only when the dialog opens.

const marks = { running: "…", waiting: "?", succeeded: "✓", failed: "✗" }

async function open(directory: string) {
  const { openStore } = await import("@orbit/flow")
  return openStore(directory)
}

function useDirectory() {
  const location = useLocation()
  const data = useData()
  return () => location.current?.directory ?? data.location.default().directory
}

export function DialogFlowRuns() {
  const dialog = useDialog()
  const directory = useDirectory()
  const [runs] = createResource(directory, async (folder) => {
    const store = await open(folder)
    const list = store.runs(50)
    store.close()
    return list
  })
  const options = createMemo(() =>
    (runs() ?? []).map((run) => ({
      value: run.id,
      title: `${marks[run.status]} ${run.workflow}`,
      description: `${run.status} · ${new Date(run.updated).toLocaleString()}`,
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
  const directory = useDirectory()
  const [nodes] = createResource(directory, async (folder) => {
    const store = await open(folder)
    const list = [...store.nodes(props.run).values()]
    store.close()
    return list
  })
  const options = createMemo(() =>
    (nodes() ?? []).map((node) => {
      const usage = node.result?.usage as { input?: number; output?: number; cost?: number } | undefined
      return {
        value: node.id,
        title: `${marks[node.status]} ${node.id}`,
        description: [
          node.status === "waiting" ? node.message : undefined,
          usage ? `${(usage.input ?? 0) + (usage.output ?? 0)} tokens` : undefined,
          node.error ? String(node.error.message) : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
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

function DialogFlowGate(props: { readonly run: string; readonly gate: string; readonly message: string }) {
  const dialog = useDialog()
  const toast = useToast()
  const directory = useDirectory()
  const decide = async (approved: boolean, note?: string) => {
    const store = await open(directory())
    const error = store.decide(props.run, props.gate, approved, note)
    store.close()
    if (error) return toast.show({ title: "Not decided", message: error, variant: "error" })
    toast.show({
      title: approved ? `Approved ${props.gate}` : `Rejected ${props.gate}`,
      message: `Continue the run with: orb flow resume ${props.run}`,
      variant: "success",
    })
    dialog.replace(() => <DialogFlowRun run={props.run} />)
  }
  const withNote = (approved: boolean) =>
    dialog.replace(() => (
      <DialogPrompt
        title={`${approved ? "Approve" : "Reject"} ${props.gate}: note`}
        placeholder="A note the workflow receives with the decision"
        onConfirm={(note) => void decide(approved, note.trim() || undefined).catch(toast.error)}
        onCancel={() => dialog.replace(() => <DialogFlowGate {...props} />)}
      />
    ))
  return (
    <DialogSelect
      title={`${props.gate}: ${props.message}`}
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
