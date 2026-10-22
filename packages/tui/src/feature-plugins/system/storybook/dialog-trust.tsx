import type { TrustStatus } from "@orbit/client"
import type { Plugin } from "@orbit/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onMount } from "solid-js"
import { DialogTrust } from "../../../component/dialog-trust"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

// The two kinds of root: one a grant can be kept for, and the two it never can be kept for.
const ROOTS = [
  { label: "project", directory: "/Users/kit/code/orbit-app", persistent: true },
  { label: "home directory", directory: "/Users/kit", persistent: false },
  { label: "filesystem root", directory: "/", persistent: false },
] as const

function DialogTrustStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [root, setRoot] = createSignal(0)
  const [message, setMessage] = createSignal("dialog open")

  // Nothing of a folder that is not trusted is read, so the status lists nothing it holds.
  const status = createMemo<TrustStatus>(() => ({
    directory: ROOTS[root()].directory,
    trusted: false,
    persistent: ROOTS[root()].persistent,
    withheld: [],
  }))

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
      { bind: "o,return", title: "Open the dialog", group: "Storybook", run: open },
      {
        bind: "x",
        title: "Reset the fixture",
        group: "Storybook",
        run: () => {
          setRoot(0)
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
        details={[ROOTS[root()].label, "untrusted"]}
        message={message()}
        controls={[
          { shortcut: "r", label: "root" },
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
