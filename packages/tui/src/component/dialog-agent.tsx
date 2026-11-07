import { useRenderer } from "@opentui/solid"
import { plain } from "@orbit/flow/plain"
import { existsSync } from "node:fs"
import { isIPv4 } from "node:net"
import path from "node:path"
import { createMemo } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useTuiPaths } from "../context/runtime"
import { openEditor, openFile } from "../editor"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogAgentCreate } from "./dialog-agent-create"
import { DialogAgentEdit, editable } from "./dialog-agent-edit"

const create = Symbol("create")
const edit = Symbol("edit")

/** Whether the server at `url` runs on this machine and sees `directory`, so a path it names can be opened here. */
export function onThisMachine(url: string | undefined, directory: string) {
  if (!url || !URL.canParse(url)) return false
  const host = new URL(url).hostname
  return (host === "localhost" || host === "[::1]" || (isIPv4(host) && host.startsWith("127."))) && existsSync(directory)
}

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const client = useClient()
  const data = useData()
  const location = useLocation()
  const paths = useTuiPaths()
  const renderer = useRenderer()

  const ref = () => location.ref ?? data.location.default()
  const agents = () => data.location.agent.list(ref()) ?? []
  // The files are written by this process, so they can only be made where the server's folders are this machine's.
  const here = () => onThisMachine(client.url, ref().directory)
  const configDirectory = (scope: "project" | "user") =>
    scope === "project"
      ? path.join(ref().directory, ".orbit")
      : ((data.location.config.list(ref()) ?? []).find((entry) => entry.type === "directory" && entry.scope === "user")
          ?.path ?? path.join(paths.home, ".orbit"))
  const notify = (changed: string[]) => client.api.config.sources.changed({ location: ref(), paths: changed })
  const open = (file: string) => openFile({ file, renderer, wait: true })
  const back = () => dialog.replace(() => <DialogAgent />)

  const options = createMemo(() => [
    {
      value: create as symbol | string,
      title: "Create agent…",
      description: here() ? "Write a new agent file" : "Unavailable: the server is not on this machine",
      category: "Agent files",
      disabled: false,
    },
    ...(editable(agents()).length === 0 || !here()
      ? []
      : [{ value: edit as symbol | string, title: "Edit an agent file…", category: "Agent files" }]),
    ...local.agent.list().map((item) => ({
      value: item.id as symbol | string,
      title: plain(item.id),
      description: item.description === undefined ? undefined : plain(item.description),
      category: "Switch agent",
    })),
  ])

  return (
    <DialogSelect
      title="Select agent"
      current={local.agent.current()?.id}
      options={options()}
      onSelect={async (option) => {
        if (option.value === create) {
          if (!here()) return
          // Asked when the dialog opens: it only decides which note the last step shows.
          const trusted = (await client.api.location.trust.get({ location: ref() }).catch(() => undefined))?.trusted
          return dialog.replace(() => (
            <DialogAgentCreate
              taken={agents().map((agent) => ({ id: agent.id, scope: agent.source?.scope }))}
              configDirectory={configDirectory}
              projectRoot={ref().directory}
              trusted={trusted}
              notify={notify}
              open={open}
              edit={(value) => openEditor({ value, renderer, cwd: ref().directory })}
              onBack={back}
            />
          ))
        }
        if (option.value === edit)
          return dialog.replace(() => <DialogAgentEdit agents={agents()} open={open} notify={notify} onBack={back} />)
        local.agent.set(option.value as string)
        dialog.clear()
      }}
    />
  )
}
