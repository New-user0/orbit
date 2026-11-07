import type { TrustStatus } from "@orbit/client"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { dialogWidth, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { Locale } from "../util/locale"
import { abbreviateHome } from "../util/path-format"

/**
 * Asks whether to trust a folder that is not trusted. Nothing of it has been read, so the question lists nothing: it
 * names the folder, asks whether it is the person's own or one they trust, and says what trusting it lets Orbit do, as
 * the reference's question does in its own words. A folder that is trusted is never asked about again, whatever changed
 * in it since (D8). `onTrust` receives whether the grant can be kept on disk, which it cannot for a home directory or a
 * filesystem root: those are trusted only until Orbit restarts, and the dialog offers nothing else for them. `leave`
 * names the other answer: Exit for the folder the terminal UI started in, Not now for any other, and `onNotNow` takes
 * either.
 */
export function DialogTrust(props: {
  status: TrustStatus
  leave?: "exit" | "later"
  /** Whether nothing could be typed before the question opened, so that Enter on Trust is a choice the person saw. */
  guarded?: boolean
  onTrust: (persist: boolean) => void | Promise<void>
  onNotNow: () => void
  /** The "no" key on the question about the folder the terminal UI started in, which ends it with status 0. */
  onDecline?: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const paths = useTuiPaths()
  const [pending, setPending] = createSignal(false)
  const intro =
    "Do you know where this folder came from? If you are not sure, read through its files before you go on.\nOrbit can read, change and run the files here, and nothing here loads until you trust it."
  const outro = createMemo(() =>
    props.status.persistent
      ? "Trust it only if you trust whoever wrote it.\nIt stays trusted until `orb trust --revoke`."
      : "Trusting a home directory or filesystem root lasts only until Orbit restarts, or on the background service " +
        "until the service restarts.\nEnd it sooner with `orb trust --revoke`.",
  )
  // The dialog's own padding is taken off, so a row never runs past its edge.
  const width = createMemo(() => Math.min(dialogWidth("medium"), dimensions().width - 2) - 8)

  dialog.setCentered(true)

  const trust = async () => {
    setPending(true)
    await Promise.resolve(props.onTrust(props.status.persistent)).finally(() => setPending(false))
  }

  return (
    <DialogSelect
      title="Trust this folder?"
      renderFilter={false}
      locked={pending()}
      // A question can open while a person is typing, so a stray Enter there must never be what trusts it. The question
      // about the folder the terminal UI started in comes while the prompts take no typing, and starts on Trust, as the
      // reference's does.
      focusTarget={props.guarded === true ? "trust" : "later"}
      header={
        <box flexDirection="column" gap={1}>
          <text wrapMode="none" truncate>
            <span style={{ fg: theme.text.feedback.warning.base }}>⊙ Untrusted</span>
            <span style={{ fg: theme.text.muted }}>
              {"  " + Locale.truncateLeft(abbreviateHome(props.status.directory, paths.home), width() - 12)}
            </span>
          </text>
          <text fg={theme.text.muted} wrapMode="word">
            {intro}
          </text>
          <text fg={theme.text.muted} wrapMode="word">
            {outro()}
          </text>
        </box>
      }
      options={[
        { title: props.status.persistent ? "Trust this folder" : "Trust until Orbit restarts", value: "trust" },
        { title: props.leave === "exit" ? "Exit" : "Not now", value: "later" },
      ]}
      onSelect={(option) => (option.value === "trust" ? void trust() : props.onNotNow())}
      bindings={
        props.leave === "exit" && props.onDecline !== undefined
          ? [{ bind: "n", title: "No, exit", group: "Trust", run: props.onDecline }]
          : []
      }
    />
  )
}
