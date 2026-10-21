import type { TrustKind, TrustStatus } from "@orbit/client"
import { plain } from "@orbit/flow/plain"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { dialogWidth, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { Locale } from "../util/locale"
import { abbreviateHome, formatPath } from "../util/path-format"
import { changedOwn, groupWithheld, trustCommands } from "../util/trust"

const labels: Record<TrustKind, string> = {
  hooks: "hooks",
  mcp: "MCP servers",
  plugins: "plugins",
  commands: "shell snippets",
  permissions: "permission rules",
  providers: "providers",
  shell: "shell",
  env: "environment variables",
  formatter: "formatters",
  lsp: "language servers",
  sandbox: "sandbox",
  skills: "skills",
  network: "network access",
  settings: "other settings",
}

/**
 * Asks whether to trust a folder. A folder that is not trusted has had nothing read from it, so the question lists
 * nothing: it names the folder, asks whether it is the person's own or one they trust, and says what trusting it lets
 * Orbit do, as the reference's question does in its own words. A trusted folder whose executable config changed since
 * is asked about again, with what changed listed, and config in a folder above it after the folder's own, with the
 * command that trusts the folder that holds it. `onTrust` receives whether the grant can be kept on disk, which it
 * cannot for a home directory or a filesystem root: those are trusted only until Orbit restarts, and the dialog offers
 * nothing else for them. `leave` names the other answer: Exit for the folder the terminal UI started in, Not now for any
 * other, and `onNotNow` takes either.
 */
export function DialogTrust(props: {
  status: TrustStatus
  /** The folder in view, which the commands that trust a folder above the project go through. */
  location?: string
  leave?: "exit" | "later"
  onTrust: (persist: boolean) => void | Promise<void>
  onNotNow: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const paths = useTuiPaths()
  const [pending, setPending] = createSignal(false)
  // A folder that is trusted already asks again when what it runs changed since: a pull, a branch switch or an edit.
  const changed = createMemo(() => props.status.trusted)
  const intro = createMemo(() =>
    changed()
      ? "This folder's config changed since you trusted it, and Orbit is leaving out what changed:"
      : "Is this your own project, or one you trust, such as your own code, a well-known open source project or your team's work? If not, look through the folder first.\nOrbit can read, change and run the files here, and nothing here loads until you trust it.",
  )
  // Nothing of a folder that is not trusted was read, so there is nothing to list for it.
  const held = createMemo(() =>
    changed()
      ? { ...groupWithheld(props.status.withheld), own: changedOwn(props.status) }
      : { own: [], above: [] },
  )
  const outro = createMemo(() =>
    [
      changed()
        ? "Trust the changes only if you know who made them.\nThe folder stays trusted either way, and the rest of its config keeps running."
        : props.status.persistent
          ? "Trust it only if you trust whoever wrote it.\nIt stays trusted until `orb trust --revoke`."
          : "Trusting a home directory or filesystem root lasts only until Orbit restarts, or on the background service " +
            "until the service restarts.\nEnd it sooner with `orb trust --revoke`.",
      ...(held().above.length === 0
        ? []
        : [
            `Config above this folder stays off until its own folder is trusted: ${trustCommands(held().above, props.location ?? props.status.directory)}.`,
          ]),
    ].join("\n"),
  )
  // The dialog's own padding is taken off, so a row never runs past its edge.
  const width = createMemo(() => Math.min(dialogWidth("medium"), dimensions().width - 2) - 8)
  // One entry per file or directory that holds something back, named from the folder when it lies inside it. What
  // trusting the folder turns on comes first, so a list that has to be cut short keeps it.
  const sources = createMemo(() =>
    [...held().own, ...held().above].map((item) => ({
      name: plain(formatPath(item.path, { base: props.status.directory, home: paths.home, forwardSlashes: true })),
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
  const visible = createMemo(() => Math.max(1, Math.min(6, dimensions().height - 11 - lines(intro()) - lines(outro()))))

  dialog.setCentered(true)

  const trust = async () => {
    setPending(true)
    // A grant that is stored stays stored when it is renewed, and one that lasts until Orbit restarts stays that way.
    const persist = changed() ? props.status.source === "saved" : props.status.persistent
    await Promise.resolve(props.onTrust(persist)).finally(() => setPending(false))
  }

  return (
    <DialogSelect
      title={changed() ? "Trust the changes?" : "Trust this folder?"}
      renderFilter={false}
      locked={pending()}
      // A question about another folder can open while a person is typing, so a stray Enter there must never be what
      // trusts it. The question about the folder the terminal UI started in comes before anything can be typed, and
      // starts on Trust, as the reference's does.
      focusTarget={props.leave === "exit" && !changed() ? "trust" : "later"}
      header={
        <box flexDirection="column" gap={1}>
          <text wrapMode="none" truncate>
            <span style={{ fg: theme.text.feedback.warning.base }}>{changed() ? "⊙ Changed" : "⊙ Untrusted"}</span>
            <span style={{ fg: theme.text.muted }}>
              {"  " + Locale.truncateLeft(abbreviateHome(props.status.directory, paths.home), width() - 12)}
            </span>
          </text>
          <text fg={theme.text.muted} wrapMode="word">
            {intro()}
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
        {
          title: changed()
            ? "Trust changes"
            : props.status.persistent
              ? "Trust this folder"
              : "Trust until Orbit restarts",
          value: "trust",
        },
        { title: props.leave === "exit" && !changed() ? "Exit" : "Not now", value: "later" },
      ]}
      onSelect={(option) => (option.value === "trust" ? void trust() : props.onNotNow())}
    />
  )
}
