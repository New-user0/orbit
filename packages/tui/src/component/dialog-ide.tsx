import { plain } from "@orbit/util/plain"
import path from "node:path"
import { For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import type { Editor } from "../editor"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

/** The windows `/ide` offers, as the editor context lists them. */
export type IdeWindows = { matched: readonly Editor[]; unmatched: readonly Editor[]; current?: number }

const none = "none"

/**
 * `/ide`: the editor windows that hold this folder, with the one this process is linked to focused, and a last row that
 * links to none. Windows that hold some other folder are named below, apart, because they cannot be chosen.
 */
export function DialogIde(props: {
  windows: IdeWindows
  directory: string
  /** Whether this is a terminal of an editor, where the window is found without being asked. */
  inEditor: boolean
  onSelect: (port: number | undefined) => void
  onCancel?: () => void
}) {
  const theme = useTheme().surface("dialog")
  const names = props.windows.matched.map((item) => plain(item.name))
  const options: DialogSelectOption<number | typeof none>[] = [
    ...props.windows.matched.map((item) => ({
      value: item.port,
      title: plain(item.name),
      // The folders tell two windows of the same editor apart, so they are shown only then.
      description:
        names.filter((name) => name === plain(item.name)).length > 1 ? formatFolders(item.folders, props.directory) : undefined,
    })),
    { value: none, title: "No editor" },
  ]
  return (
    <DialogSelect
      title="Select an editor"
      options={options}
      skipFilter
      current={props.windows.current ?? none}
      header={
        <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
          <text fg={theme.text.muted}>Share your open file and selection with Orbit, and take mentions from the editor.</text>
          <Show when={props.windows.matched.length === 0}>
            <text fg={theme.text.muted}>
              No editor with this folder open was found. The Orbit editor extension must be installed and the editor running.
            </text>
          </Show>
        </box>
      }
      footer={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <Show when={props.windows.unmatched.length > 0}>
            <text fg={theme.text.muted}>
              {`${props.windows.unmatched.length} ${props.windows.unmatched.length === 1 ? "window has" : "windows have"} no folder that holds this one:`}
            </text>
            <For each={props.windows.unmatched}>
              {(item) => (
                <text fg={theme.text.muted} wrapMode="none">{`  • ${plain(item.name)} ${formatFolders(item.folders, props.directory)}`}</text>
              )}
            </For>
          </Show>
          <Show when={!props.inEditor}>
            <text fg={theme.text.muted}>Tip: Orbit connects by itself from an editor's own terminal.</text>
          </Show>
        </box>
      }
      onSelect={(option) => props.onSelect(option.value === none ? undefined : (option.value as number))}
      onCancel={props.onCancel}
    />
  )
}

/** `/ide open`: where to open this folder. The row of a window that has no program shows what to do by hand. */
export function DialogIdeOpen(props: {
  windows: readonly Editor[]
  directory: string
  onSelect: (window: Editor) => void
  onCancel?: () => void
}) {
  return (
    <DialogSelect
      title="Open this folder in"
      options={props.windows.map((item) => ({
        value: item.port,
        title: plain(item.name),
        description: formatFolders(item.folders, props.directory),
      }))}
      onSelect={(option) => {
        const chosen = props.windows.find((item) => item.port === option.value)
        if (chosen) props.onSelect(chosen)
      }}
      onCancel={props.onCancel}
    />
  )
}

const budget = 100

/**
 * The folders of a window on one line, for telling windows apart: at most the first two, a folder under `directory` shown
 * relative to it, each cut to its share of the line from the front so that the end of the path stays, and an ellipsis at
 * the end when folders were left out. The text is escaped, because the editor chose it.
 */
export function formatFolders(folders: readonly string[], directory: string) {
  const base = directory.normalize("NFC")
  const shown = folders.slice(0, 2).map((folder) => {
    const normal = folder.normalize("NFC")
    const relative = path.relative(base, normal)
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : normal
  })
  const cut = folders.length > shown.length
  // Two characters for each separator and three for the ellipsis that says some were left out.
  const room = budget - (shown.length - 1) * 2 - (cut ? 3 : 0)
  const share = Math.max(1, Math.floor(room / Math.max(1, shown.length)))
  const line = shown.map((folder) => (folder.length > share ? `…${folder.slice(folder.length - share + 1)}` : folder))
  return plain(`${line.join(", ")}${cut ? "…" : ""}`)
}
