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

// What is held back, in the order it is listed. A path that starts with a slash lies outside the root, as the config
// of a folder above a project does, so the dialog shows both the relative and the absolute way of naming a file.
const SOURCES: readonly { path: string; kinds: readonly TrustKind[] }[] = [
  { path: ".orbit", kinds: ["plugins", "commands"] },
  { path: "orbit.json", kinds: ["hooks", "mcp", "providers"] },
  { path: ".mcp.json", kinds: ["mcp"] },
  { path: "orbit.local.jsonc", kinds: ["permissions", "sandbox"] },
  { path: "packages/web/.orbit", kinds: ["plugins"] },
  { path: "packages/api/orbit.json", kinds: ["shell", "formatter", "lsp"] },
  { path: "packages/docs/a-deliberately-long-directory-name/.orbit", kinds: ["network", "settings"] },
  { path: "/Users/kit/code/shared/orbit.json", kinds: ["settings"] },
]

// How much is held back: one file, a few, or more than the dialog has room for.
const AMOUNTS = [1, 3, SOURCES.length] as const

function DialogTrustStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [root, setRoot] = createSignal(0)
  const [amount, setAmount] = createSignal(0)
  const [message, setMessage] = createSignal("dialog open")

  const status = createMemo<TrustStatus>(() => {
    const item = ROOTS[root()]
    return {
      directory: item.directory,
      trusted: false,
      persistent: item.persistent,
      withheld: SOURCES.slice(0, AMOUNTS[amount()]).map((source) => ({
        path: source.path.startsWith("/") ? source.path : `${item.directory.replace(/\/$/, "")}/${source.path}`,
        kinds: [...source.kinds],
      })),
    }
  })

  // The real dialog, with the answers kept here: nothing is sent to a server, so it is safe to explore.
  const open = () => {
    props.context.ui.dialog.show(
      () => (
        <DialogTrust
          status={status()}
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
      { bind: "o,return", title: "Open the dialog", group: "Storybook", run: open },
      {
        bind: "x",
        title: "Reset the fixture",
        group: "Storybook",
        run: () => {
          batch(() => {
            setRoot(0)
            setAmount(0)
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
        details={[ROOTS[root()].label, `${AMOUNTS[amount()]} held back`]}
        message={message()}
        controls={[
          { shortcut: "r", label: "root" },
          { shortcut: "s", label: "amount held back" },
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
