import type { TrustKind, TrustStatus } from "@orbit/client"
import type { Plugin } from "@orbit/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createMemo, createSignal, onMount } from "solid-js"
import { DialogTrust } from "../../../component/dialog-trust"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

// The two kinds of root: one a grant can be kept for, and the two it never can be kept for.
const ROOTS = [
  { label: "project", directory: "/Users/kit/code/orbit-app", persistent: true },
  { label: "home directory", directory: "/Users/kit", persistent: false },
  { label: "filesystem root", directory: "/", persistent: false },
] as const

// What the folder holds back, in the order it is listed: its own config, which trusting it turns on.
const SOURCES: readonly { path: string; kinds: readonly TrustKind[] }[] = [
  { path: ".orbit", kinds: ["plugins", "commands"] },
  { path: "orbit.json", kinds: ["hooks", "mcp", "providers"] },
  { path: ".mcp.json", kinds: ["mcp"] },
  { path: "orbit.local.jsonc", kinds: ["permissions", "sandbox"] },
  { path: "packages/web/.orbit", kinds: ["plugins"] },
  { path: "packages/api/orbit.json", kinds: ["shell", "formatter", "lsp"] },
  { path: "packages/docs/a-deliberately-long-directory-name/.orbit", kinds: ["network", "settings"] },
]

// Config in the folders above the project, each with the folder whose own trust turns it on, which trusting the project
// does not. Discovery goes from the outermost folder in, so these can come ahead of the project's own in what the server
// reports, and are listed here that way to show that the dialog puts the project's own first.
const ABOVE: readonly { path: string; kinds: readonly TrustKind[]; directory: string }[] = [
  { path: "/Users/kit/code/orbit.json", kinds: ["hooks", "mcp"], directory: "/Users/kit/code" },
  { path: "/Users/kit/code/shared/.orbit", kinds: ["plugins"], directory: "/Users/kit/code/shared" },
]

// How much is held back: one file, a few, or more than the dialog has room for.
const AMOUNTS = [1, 3, SOURCES.length] as const

// How much sits above the project: nothing, the files of one folder, or those of two.
const ABOVE_AMOUNTS = [0, 1, ABOVE.length] as const

function DialogTrustStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [root, setRoot] = createSignal(0)
  const [amount, setAmount] = createSignal(0)
  const [above, setAbove] = createSignal(0)
  // A folder that was trusted and whose config changed since asks "Trust changes?" instead of "Trust this folder?".
  const [changed, setChanged] = createSignal(false)
  const [message, setMessage] = createSignal("dialog open")

  const status = createMemo<TrustStatus>(() => {
    const item = ROOTS[root()]
    const own = SOURCES.slice(0, AMOUNTS[amount()]).map((source) => ({
      path: `${item.directory.replace(/\/$/, "")}/${source.path}`,
      kinds: [...source.kinds],
    }))
    return {
      directory: item.directory,
      trusted: changed(),
      persistent: item.persistent,
      ...(changed() ? { source: "saved" as const } : {}),
      withheld: [...ABOVE.slice(0, ABOVE_AMOUNTS[above()]).map((source) => ({ ...source, kinds: [...source.kinds] })), ...own],
      changed: changed() ? own : [],
    }
  })

  // The real dialog, with the answers kept here: nothing is sent to a server, so it is safe to explore.
  const open = () => {
    props.context.ui.dialog.show(
      () => (
        <DialogTrust
          status={status()}
          location={ROOTS[root()].directory}
          onTrust={(persist) => {
            setMessage(`trust chosen, which sends persist:${persist}`)
            props.context.ui.dialog.clear()
          }}
          onNotNow={() => {
            setMessage("not now chosen")
            props.context.ui.dialog.clear()
          }}
        />
      ),
      () => setMessage((current) => (current === "dialog open" ? "dialog dismissed" : current)),
    )
    setMessage("dialog open")
  }
  onMount(open)

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      {
        bind: "r",
        title: "Cycle the root",
        group: "Storybook",
        run: () => setRoot((value) => (value + 1) % ROOTS.length),
      },
      {
        bind: "s",
        title: "Cycle how much is held back",
        group: "Storybook",
        run: () => setAmount((value) => (value + 1) % AMOUNTS.length),
      },
      {
        bind: "a",
        title: "Cycle how much config sits above the project",
        group: "Storybook",
        run: () => setAbove((value) => (value + 1) % ABOVE_AMOUNTS.length),
      },
      {
        bind: "c",
        title: "Toggle: trusted, with config that changed since",
        group: "Storybook",
        run: () => setChanged((value) => !value),
      },
      { bind: "o,return", title: "Open the dialog", group: "Storybook", run: open },
      {
        bind: "x",
        title: "Reset the fixture",
        group: "Storybook",
        run: () => {
          batch(() => {
            setRoot(0)
            setAmount(0)
            setAbove(0)
            setChanged(false)
          })
          open()
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.base}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexGrow={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Folder not trusted
        </text>
        <text fg={theme.text.muted}>The dialog opens over this screen, as it does over Home or a session.</text>
        <text fg={theme.text.muted}>Nothing chosen here is sent anywhere.</text>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / trust dialog"
        details={[
          ROOTS[root()].label,
          `${AMOUNTS[amount()]} held back`,
          `${ABOVE_AMOUNTS[above()]} above`,
          changed() ? "changed since trusted" : "untrusted",
        ]}
        message={message()}
        controls={[
          { shortcut: "r", label: "root" },
          { shortcut: "s", label: "amount held back" },
          { shortcut: "a", label: "config above" },
          { shortcut: "c", label: "changed since trusted" },
          { shortcut: "o", label: "open" },
          { shortcut: "x", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const dialogTrustStory: Story = {
  id: "dialog-trust",
  title: "Trust dialog",
  render: (context) => <DialogTrustStory context={context} />,
}
