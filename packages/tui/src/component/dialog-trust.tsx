import type { TrustKind, TrustStatus } from "@orbit/client"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { dialogWidth, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { Locale } from "../util/locale"
import { abbreviateHome, formatPath } from "../util/path-format"
import { groupWithheld, trustCommands } from "../util/trust"

const labels: Record<TrustKind, string> = {
  hooks: "hooks",
  mcp: "MCP servers",
  plugins: "plugins",
  commands: "shell snippets",
  permissions: "permission rules",
  providers: "providers",
  shell: "shell",
  formatter: "formatters",
  lsp: "language servers",
  sandbox: "sandbox",
  network: "network access",
  settings: "other settings",
}

/**
 * Asks whether to trust the folder whose project config is held back. `onTrust` receives whether the grant can be kept
 * on disk, which it cannot for a home directory or a filesystem root: those are trusted only until Orbit restarts, and
 * the dialog offers nothing else for them. Config in a folder above it is listed after the folder's own, with the
 * command that trusts the folder that holds it, because trusting this one does not turn it on.
 */
export function DialogTrust(props: {
  status: TrustStatus
  onTrust: (persist: boolean) => void | Promise<void>
  onNotNow: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const paths = useTuiPaths()
  const [pending, setPending] = createSignal(false)
  const intro = "Orbit is leaving out what could run code or reach the network:"
  const held = createMemo(() => groupWithheld(props.status.withheld))
  const outro = createMemo(() =>
    [
      props.status.persistent
        ? "Trust it only if you trust whoever wrote it.\nIt stays trusted until `orb trust --revoke`."
        : "Trusting a home directory or filesystem root lasts only until Orbit restarts, or on the background service " +
          "until the service restarts.\nEnd it sooner with `orb trust --revoke`.",
      ...(held().above.length === 0
        ? []
        : [`Config above this folder stays off until its own folder is trusted: ${trustCommands(held().above)}.`]),
    ].join("\n"),
  )
  // The dialog's own padding is taken off, so a row never runs past its edge.
  const width = createMemo(() => Math.min(dialogWidth("medium"), dimensions().width - 2) - 8)
  // One entry per file or directory that holds something back, named from the folder when it lies inside it. What
  // trusting the folder turns on comes first, so a list that has to be cut short keeps it.
  const sources = createMemo(() =>
    [...held().own, ...held().above].map((item) => ({
      name: formatPath(item.path, { base: props.status.directory, home: paths.home, forwardSlashes: true }),
      kinds: item.kinds.map((kind) => labels[kind]).join(", "),
    })),
  )
  const column = createMemo(() =>
    Math.min(Math.max(...sources().map((item) => item.name.length)), Math.floor(width() / 2)),
  )
  // The choices are what must stay on screen, so a short or narrow terminal shortens the list before anything else.
  // It gets the rows left once the paragraphs, and eleven for the title, the status, the choices and the spacing, have
  // theirs; a paragraph takes a row more than its text needs, for the word that wraps early.
  const lines = (text: string) => text.split("\n").reduce((rows, line) => rows + Math.ceil(line.length / width()), 1)
  const visible = createMemo(() => Math.max(1, Math.min(6, dimensions().height - 11 - lines(intro) - lines(outro()))))

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
      // The dialog can open while a person is typing, so a stray Enter must never be what trusts the folder.
      focusTarget="later"
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
          <box flexDirection="column">
            <For each={sources().slice(0, visible())}>
              {(item) => (
                <text fg={theme.text.base} wrapMode="none" truncate>
                  {Locale.truncateMiddle(item.name, column()).padEnd(column() + 2)}
                  <span style={{ fg: theme.text.muted }}>{Locale.truncate(item.kinds, width() - column() - 2)}</span>
                </text>
              )}
            </For>
            <Show when={sources().length > visible()}>
              <text fg={theme.text.muted} wrapMode="none">
                and {sources().length - visible()} more
              </text>
            </Show>
          </box>
          <text fg={theme.text.muted} wrapMode="word">
            {outro()}
          </text>
        </box>
      }
      options={[
        { title: props.status.persistent ? "Trust this folder" : "Trust until Orbit restarts", value: "trust" },
        { title: "Not now", value: "later" },
      ]}
      onSelect={(option) => (option.value === "trust" ? void trust() : props.onNotNow())}
    />
  )
}
