import { useRenderer } from "@opentui/solid"
import type { InstructionMemoryListing, InstructionMemoryTarget } from "@orbit/client"
import { plain } from "@orbit/flow/plain"
import { openPath } from "@orbit/util/open"
import path from "node:path"
import { createMemo, createResource } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { editFile } from "../editor"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { onThisMachine } from "./dialog-agent"

// `/memory`: the instruction files the location loaded, the user and project files a person can create, and the memory
// folders. The dialog never decides a place: it posts the row's target, and opens only the path the server answers,
// a file in the person's editor and a folder in the system's file manager (class 3). Every name, path and message the
// server sends is drawn through `plain`, since a repository chooses its file names and an agent its id (class 9).

// The file chosen last, focused the next time the dialog opens, as long as the process runs. Folder rows are not kept.
let last: string | undefined

type Row =
  | { readonly type: "toggle" }
  | { readonly type: "file" | "folder"; readonly target: InstructionMemoryTarget; readonly path: string }
  | { readonly type: "warning" }

const unavailable = "Unavailable: the server is not on this machine"

export function DialogMemory(props: {
  /** Opens a folder in the system's file manager. */
  open?: (folder: string) => Promise<unknown>
  /** Opens a file in the person's editor and waits for it to close. */
  edit?: typeof editFile
}) {
  const client = useClient()
  const data = useData()
  const dialog = useDialog()
  const location = useLocation()
  const paths = useTuiPaths()
  const renderer = useRenderer()
  const theme = useTheme().surface("dialog")
  const toast = useToast()

  const ref = () => location.ref ?? data.location.default()
  const [listing, { refetch }] = createResource(() => client.api.location.memory.list({ location: ref() }))
  const here = () => onThisMachine(client.url, ref().directory)

  // A path as a person reads it: below the home folder or the location's folder, whichever is shorter, else whole.
  const display = (file: string) => {
    const relativeTo = (base: string, mark: string) => {
      const rest = path.relative(base, file)
      return rest === "" || rest === ".." || rest.startsWith(`..${path.sep}`) || path.isAbsolute(rest)
        ? undefined
        : `${mark}${path.sep}${rest}`
    }
    const found = [relativeTo(paths.home, "~"), relativeTo(ref().directory, ".")].filter((item) => item !== undefined)
    return plain(found.toSorted((a, b) => a.length - b.length)[0] ?? file)
  }

  const options = createMemo((): DialogSelectOption<string>[] => {
    const value = listing()
    if (value === undefined) return []
    const shown = new Set(value.files.map((file) => file.path))
    return [
      { value: "toggle", title: `Auto memory: ${value.enabled ? "on" : "off"}` },
      ...value.files.flatMap((file) => [
        {
          value: key({ type: "file", target: file.target, path: file.path }),
          title: file.role === "user" ? "User memory" : file.role === "project" ? "Project memory" : indent(value, file.path) + display(file.path),
          description: here() ? describe(value, file) : unavailable,
        },
        ...warnings(value, file.path),
      ]),
      ...value.warnings.filter((warning) => !shown.has(warning.path)).flatMap((warning) => warnings(value, warning.path, true)),
      ...value.folders.map((folder) => ({
        value: key({ type: "folder", target: folder.target, path: folder.path }),
        title:
          folder.type === "memory"
            ? "Open memory folder"
            : folder.type === "team"
              ? "Open team memory folder"
              : `Open ${plain(folder.agent ?? "")} agent memory`,
        description: !here() ? unavailable : folder.type === "agent" ? `${plain(folder.scope ?? "")} scope` : display(folder.path),
      })),
    ]
  })

  // Each warning about `file` as a row of its own; one whose file did not load is named by that file.
  const warnings = (value: InstructionMemoryListing, file: string, alone = false) =>
    value.warnings
      .filter((warning) => warning.path === file)
      .map((warning) => ({
        value: key({ type: "warning" }, `${warning.path}\n${warning.type}`),
        title: alone ? `! ${display(warning.path)}` : `  ! ${plain(warning.message)}`,
        description: alone ? plain(warning.message) : undefined,
        fg: theme.text.feedback.warning.base,
      }))

  // An import sits under its importer, one step deeper for each level of importing.
  const indent = (value: InstructionMemoryListing, file: string) => {
    const depth = (current: string, seen: number): number => {
      const parent = value.files.find((item) => item.path === current)?.importedBy
      return parent === undefined || seen > value.files.length ? seen : depth(parent, seen + 1)
    }
    const levels = depth(file, 0)
    return levels === 0 ? "" : `${"  ".repeat(levels - 1)}└ `
  }

  // The reference's descriptions: a person's file says where it is saved, the project's file whether it is checked in,
  // an import that it is imported.
  const describe = (value: InstructionMemoryListing, file: InstructionMemoryListing["files"][number]) => {
    if (file.kind === "user") return `Saved in ${display(file.path)}`
    if (file.role === "project") return `${value.git ? "Checked in at" : "Saved in"} ${display(file.path)}`
    if (file.importedBy !== undefined) return "Imported"
    return undefined
  }

  const rows = createMemo(() => {
    const value = listing()
    const found = new Map<string, Row>([["toggle", { type: "toggle" }]])
    for (const file of value?.files ?? []) found.set(key({ type: "file", target: file.target, path: file.path }), { type: "file", target: file.target, path: file.path })
    for (const folder of value?.folders ?? [])
      found.set(key({ type: "folder", target: folder.target, path: folder.path }), { type: "folder", target: folder.target, path: folder.path })
    return found
  })

  const current = () => {
    const files = listing()?.files ?? []
    const remembered = files.find((file) => key({ type: "file", target: file.target, path: file.path }) === last)
    const first = remembered ?? files[0]
    return first === undefined ? undefined : key({ type: "file", target: first.target, path: first.path })
  }

  const choose = async (row: Row) => {
    if (row.type === "warning") return
    if (row.type === "toggle") {
      const value = listing()
      if (value === undefined) return
      await client.api.config.update({ memory: { enabled: !value.enabled } }).catch(toast.error)
      // What the server reports is shown, which an environment switch or a managed setting may decide.
      return refetch()
    }
    if (!here()) return
    if (row.type === "file") last = key(row)
    const failed = (error: unknown) => {
      if (row.type === "file") dialog.clear()
      toast.show({ variant: "error", message: `Could not open ${display(row.path)}: ${plain(errorMessage(error))}` })
    }
    const made = await client.api.location.memory.ensure({ location: ref(), target: row.target }).catch((error: unknown) => {
      failed(error)
      return undefined
    })
    if (made === undefined) return
    // A folder opener on a file named like a program would run it, so only a folder answer is opened (class 4).
    if (row.type === "folder") {
      if (made.type !== "folder") return failed(new Error("the server did not answer with a folder"))
      return (props.open ?? openPath)(made.path).catch(failed)
    }
    if (made.type !== "file") return failed(new Error("the server did not answer with a file"))
    const opened = await (props.edit ?? editFile)({ file: made.path, renderer }).catch((error: unknown) => {
      failed(error)
      return undefined
    })
    if (opened === undefined) return
    dialog.clear()
    toast.show({
      variant: "info",
      message: `Opened ${display(made.path)} in ${plain(opened.editor)}. ${
        opened.source === "default"
          ? "To choose an editor, set $VISUAL or $EDITOR."
          : `It was chosen by $${opened.source}=${plain(process.env[opened.source] ?? "")}.`
      }`,
    })
  }

  return (
    <DialogSelect
      title="Memory"
      options={options()}
      current={current()}
      onSelect={(option) => {
        const row = rows().get(option.value)
        void choose(row ?? { type: "warning" })
      }}
      onCancel={() => {
        dialog.clear()
        toast.show({ variant: "info", message: "Memory editing was cancelled." })
      }}
    />
  )
}

// Rows are told apart by what they name, so the remembered file is found again whatever moved around it.
function key(row: { readonly type: string; readonly target?: InstructionMemoryTarget; readonly path?: string }, extra = "") {
  return JSON.stringify([row.type, row.target, row.path, extra])
}
