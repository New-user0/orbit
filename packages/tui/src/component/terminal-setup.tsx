import type { JSX } from "solid-js"
import os from "node:os"
import { plain } from "@orbit/util/plain"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import {
  binding,
  detect,
  install,
  keybindingsFile,
  snippet,
  terminalName,
  type Result,
} from "../util/terminal-setup"

type Context = {
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  capabilities: { kitty_keyboard?: boolean } | null | undefined
  /** The keys that insert a newline in the prompt, as the person has them bound. */
  newlineKeys: string
  dialog: { replace(render: () => JSX.Element): void; clear(): void }
  toast: { show(input: { variant: "info" | "success" | "warning" | "error"; message: string }): void }
  copy(text: string): Promise<void>
}

/**
 * `/terminal-setup`. It starts no program. The one thing it can write is a single binding in the keybindings file of the
 * code editor whose terminal this is, and only after the person has seen the file and said yes; every other terminal gets
 * the setting to change, on the clipboard.
 */
export async function runTerminalSetup(context: Context) {
  const found = detect(context.env, context.capabilities)
  const name = terminalName(found.terminal, found.editor)
  if (found.distinct) {
    context.toast.show({
      variant: "info",
      message: `Shift+Enter already inserts a newline in ${name === "this terminal" ? "this terminal" : name}. Nothing needs to change.`,
    })
    return
  }

  if (found.editor) {
    const text = snippet(found.terminal)!
    if (found.remote)
      return show(
        context,
        "Install on the local machine",
        `${name} runs its server on another machine, and the keybindings file that counts is on this one. Add this to ${text.where}. It is copied to the clipboard.\n\n${text.text}`,
        text.text,
      )
    const file = keybindingsFile({
      editor: found.editor,
      platform: context.platform,
      home: os.homedir(),
      env: context.env,
    })
    return context.dialog.replace(() => (
      <DialogConfirm
        title="Add Shift+Enter for newlines"
        message={`Orbit will add one binding to ${plain(file)}. It sends Escape and Return for Shift+Enter in the terminal, which the prompt reads as a newline. Your other bindings and comments stay. A backup is made first.`}
        label={{ confirm: "Add it" }}
        onConfirm={() => void install({ file }).then((result) => context.toast.show(outcome(result)))}
      />
    ))
  }

  const text = snippet(found.terminal)
  if (text)
    return show(
      context,
      `Set up ${name}`,
      `Orbit does not change ${name}. Add this to ${text.where}. It is copied to the clipboard.\n\n${text.text}\n\nUntil then, ${context.newlineKeys} already insert a newline.`,
      text.text,
    )
  context.dialog.replace(() => (
    <DialogAlert
      title="Shift+Enter could not be confirmed"
      message={`Orbit does not know how to set up ${name}. These keys already insert a newline: ${context.newlineKeys}.`}
    />
  ))
}

function show(context: Context, title: string, message: string, copy: string) {
  void context.copy(copy).catch(() => undefined)
  context.dialog.replace(() => <DialogAlert title={title} message={message} />)
}

/** What each result says; the path goes through `plain` because it comes from the environment. */
export function outcome(result: Result): { variant: "success" | "warning" | "error"; message: string } {
  const file = plain(result.file)
  switch (result.type) {
    case "installed":
      return {
        variant: "success",
        message: `Added Shift+Enter to ${file}.${result.backup ? ` The old file is saved as ${plain(result.backup)}.` : ""} Restart the editor's terminal if it does not apply.`,
      }
    case "present":
      return { variant: "success", message: `${file} already has this binding.` }
    case "conflict":
      return {
        variant: "warning",
        message: `${file} already binds Shift+Enter in the terminal to something else. Resolve it by hand: Orbit left the file as it was. The binding to add is ${JSON.stringify(binding)}.`,
      }
    case "unparsable":
      return {
        variant: "error",
        message: `${file} could not be read as a keybindings list, so Orbit left it as it was. Fix or remove it, then run /terminal-setup again.`,
      }
    case "failed":
      return { variant: "error", message: `The binding could not be installed in ${file}: ${plain(result.reason)}.` }
  }
}
