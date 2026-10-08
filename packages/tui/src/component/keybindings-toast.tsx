import type { CliRenderer } from "@opentui/core"
import { plain } from "@orbit/flow/plain"
import { createEffect } from "solid-js"
import { useConfig } from "../config"
import { KeybindingsFile } from "../config/keybindings-file"
import { Keymap } from "../context/keymap"
import { useLog } from "../context/log"
import { openFile } from "../editor"
import { useToast, type ToastContext } from "../ui/toast"
import { errorMessage } from "../util/error"

// A toast has room for a few lines. Every note still goes to the log.
const SHOWN = 4

/**
 * Tells the person, in one toast, what Orbit left out of the keybindings file or what clashes in it. It speaks again only
 * when the notes change, so saving the file again or editing cli.json does not repeat it.
 */
export function KeybindingsToast() {
  const config = useConfig()
  const keymap = Keymap.use()
  const toast = useToast()
  const log = useLog({ component: "keybindings" })
  let shown = ""

  createEffect(() => {
    const notes = config.data.keybindings.diagnostics.map((note) => ({ ...note }))
    const key = JSON.stringify(notes)
    if (key === shown) return
    shown = key
    if (notes.length === 0) return
    notes.forEach((note) => log.warn(note.message, { severity: note.severity }))
    const more = notes.length - SHOWN
    toast.show({
      variant: notes.some((note) => note.severity === "error") ? "error" : "warning",
      title: `Keybindings file: ${notes.length} ${notes.length === 1 ? "note" : "notes"}`,
      message: [...notes.slice(0, SHOWN).map((note) => note.message), ...(more > 0 ? [`and ${more} more`] : [])].join(
        "\n",
      ),
      duration: 12000,
      action: { label: "Edit keybindings", run: () => keymap.dispatch("keybindings.open") },
    })
  })

  return null
}

/**
 * Opens the keybindings file for editing, writing the commented template first where there is no file. It never replaces
 * a file that exists, so one that does not parse is opened as it is. When nothing can open the file, a toast says where
 * it is.
 */
export async function editKeybindings(input: {
  file: string
  renderer: CliRenderer
  toast: ToastContext
  open?: typeof openFile
}) {
  await KeybindingsFile.create(input.file)
    .then(() => (input.open ?? openFile)({ file: input.file, renderer: input.renderer }))
    .catch((error) =>
      input.toast.show({
        variant: "warning",
        title: "Could not open the keybindings file",
        message: `${plain(input.file)}\n${plain(errorMessage(error))}`,
        duration: 15000,
      }),
    )
}
