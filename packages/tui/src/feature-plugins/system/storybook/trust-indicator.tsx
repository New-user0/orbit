import type { TrustStatus } from "@orbit/client"
import type { Plugin } from "@orbit/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { DialogTrust } from "../../../component/dialog-trust"
import { TrustIndicator } from "../../../component/trust-indicator"
import { holdsBack } from "../../../context/trust"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

const directory = "/Users/kit/code/orbit-app"

// What the indicator can be shown for: a folder that holds something back, with or without config above it that only
// its own folder's trust turns on, one that is untrusted but holds nothing back of its own, which is most repositories
// and shows nothing, and one that is trusted.
const STATES: readonly { label: string; status: TrustStatus }[] = [
  {
    label: "untrusted, holds config back",
    status: {
      directory,
      trusted: false,
      persistent: true,
      withheld: [
        { path: `${directory}/.orbit`, kinds: ["plugins", "commands"] },
        { path: `${directory}/orbit.json`, kinds: ["hooks", "mcp"] },
      ],
    },
  },
  {
    label: "untrusted, own and above config",
    status: {
      directory,
      trusted: false,
      persistent: true,
      withheld: [
        { path: "/Users/kit/code/orbit.json", kinds: ["hooks"], directory: "/Users/kit/code" },
        { path: `${directory}/orbit.json`, kinds: ["hooks", "mcp"] },
      ],
    },
  },
  {
    label: "untrusted, only above config",
    status: {
      directory,
      trusted: false,
      persistent: true,
      withheld: [{ path: "/Users/kit/code/orbit.json", kinds: ["hooks"], directory: "/Users/kit/code" }],
    },
  },
  {
    label: "untrusted, holds nothing back",
    status: { directory, trusted: false, persistent: true, withheld: [] },
  },
  {
    label: "trusted",
    status: { directory, trusted: true, persistent: true, source: "saved", withheld: [] },
  },
]

function TrustIndicatorStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [state, setState] = createSignal(0)
  const [message, setMessage] = createSignal("click the indicator, or press enter, to open the question")
  const status = createMemo(() => STATES[state()].status)

  // What activating the indicator does in the app, with the answers kept here. There is nothing to activate while the
  // indicator is not shown.
  const open = () => {
    if (!holdsBack(status())) {
      setMessage("the indicator is not shown, so there is nothing to activate")
      return
    }
    setMessage("question opened")
    props.context.ui.dialog.show(() => (
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
    ))
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      {
        bind: "t",
        title: "Cycle the trust state",
        group: "Storybook",
        run: () => setState((value) => (value + 1) % STATES.length),
      },
      { bind: "return", title: "Activate the indicator", group: "Storybook", run: open },
      {
        bind: "x",
        title: "Reset the fixture",
        group: "Storybook",
        run: () => {
          setState(0)
          setMessage("click the indicator, or press enter, to open the question")
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.base}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexGrow={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Untrusted folder indicator
        </text>
        <text fg={theme.text.muted}>It sits in the prompt's footer on Home and in every session.</text>
        <text fg={theme.text.muted}>Below 80 columns it drops the /trust hint; resize the terminal to see.</text>
      </box>
      <box flexShrink={0} flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <text fg={theme.text.muted} wrapMode="none" truncate flexGrow={1} flexShrink={1}>
          ~/code/orbit-app:main
        </text>
        <TrustIndicator status={status()} onOpen={open} />
        <text fg={theme.text.base} wrapMode="none" flexShrink={0}>
          ctrl+p <span style={{ fg: theme.text.muted }}>commands</span>
        </text>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / untrusted indicator"
        details={[STATES[state()].label, `${dimensions().width} columns`]}
        message={message()}
        controls={[
          { shortcut: "t", label: "trust state" },
          { shortcut: "enter", label: "activate" },
          { shortcut: "x", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const trustIndicatorStory: Story = {
  id: "trust-indicator",
  title: "Untrusted indicator",
  render: (context) => <TrustIndicatorStory context={context} />,
}
