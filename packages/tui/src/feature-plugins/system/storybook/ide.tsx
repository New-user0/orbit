import type { Plugin } from "@orbit/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createSignal, onMount } from "solid-js"
import { DialogIde, DialogIdeOpen, type IdeWindows } from "../../../component/dialog-ide"
import type { Editor } from "../../../editor"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

const here = "/Users/kit/code/orbit-app"

const window = (port: number, name: string, folders: string[]): Editor => ({
  port,
  token: "t".repeat(32),
  name,
  folders,
  url: `ws://127.0.0.1:${port}`,
  modified: 0,
})

// What the editors report: one window, two editors, two windows of one editor, and a name that tries to act on the terminal.
const SETS: ReadonlyArray<{ label: string; windows: Omit<IdeWindows, "current"> }> = [
  { label: "one window", windows: { matched: [window(41001, "Cursor", [here])], unmatched: [] } },
  {
    label: "two editors",
    windows: { matched: [window(41001, "Cursor", [here]), window(41002, "VS Code", [here])], unmatched: [] },
  },
  {
    label: "two windows of one editor",
    windows: {
      matched: [
        window(41001, "VS Code", [`${here}/packages/api`, `${here}/packages/web`, `${here}/docs`]),
        window(41002, "VS Code", [here, "/Users/kit/code/shared/a-deliberately-long-folder-name-that-needs-a-cut/and/more/path"]),
      ],
      unmatched: [],
    },
  },
  {
    label: "others that do not hold the folder",
    windows: {
      matched: [window(41001, "Cursor", [here])],
      unmatched: [window(41003, "VS Code", ["/Users/kit/code/other"]), window(41004, "Zed", ["/tmp/scratch", "/tmp/notes"])],
    },
  },
  { label: "none found", windows: { matched: [], unmatched: [] } },
  {
    label: "a hostile name",
    windows: {
      matched: [window(41001, "Cur\u001b]0;pwned\u0007sor", [`${here}\u001b[2J`])],
      unmatched: [window(41005, "Oth\u001b[31mer", ["/tmp/x"])],
    },
  },
]

function IdeStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [set, setSet] = createSignal(0)
  // Which window this process is linked to: none, or the first of the list.
  const [linked, setLinked] = createSignal(false)
  // Whether the terminal is an editor's own, where the window is found without being asked.
  const [inEditor, setInEditor] = createSignal(false)
  const [message, setMessage] = createSignal("dialog open")

  const windows = (): IdeWindows => ({
    ...SETS[set()].windows,
    current: linked() ? SETS[set()].windows.matched[0]?.port : undefined,
  })

  // The real dialog, with the answers kept here: nothing connects and nothing starts, so it is safe to explore.
  const open = () => {
    props.context.ui.dialog.show(
      () => (
        <DialogIde
          windows={windows()}
          directory={here}
          inEditor={inEditor()}
          onCancel={() => props.context.ui.dialog.clear()}
          onSelect={(port) => {
            setMessage(port === undefined ? "no editor chosen, which disconnects" : `window ${port} chosen, which connects`)
            props.context.ui.dialog.clear()
          }}
        />
      ),
      () => setMessage((current) => (current === "dialog open" ? "dialog dismissed" : current)),
    )
    setMessage("dialog open")
  }
  const openFolder = () => {
    props.context.ui.dialog.show(() => (
      <DialogIdeOpen
        windows={windows().matched}
        directory={here}
        onCancel={() => props.context.ui.dialog.clear()}
        onSelect={(chosen) => {
          setMessage(`/ide open would start the program for ${chosen.name}`)
          props.context.ui.dialog.clear()
        }}
      />
    ))
    setMessage("open picker")
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
      { bind: "f2", title: "Cycle the windows", group: "Storybook", run: () => (setSet((value) => (value + 1) % SETS.length), open()) },
      { bind: "f3", title: "Toggle: linked to the first window", group: "Storybook", run: () => (setLinked((value) => !value), open()) },
      { bind: "f4", title: "Toggle: an editor's own terminal", group: "Storybook", run: () => (setInEditor((value) => !value), open()) },
      { bind: "f5", title: "Open the folder picker", group: "Storybook", run: openFolder },
      {
        bind: "f6",
        title: "Reset the fixture",
        group: "Storybook",
        run: () => {
          batch(() => {
            setSet(0)
            setLinked(false)
            setInEditor(false)
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
          /ide
        </text>
        <text fg={theme.text.muted}>The dialog opens over this screen, as it does over Home or a session.</text>
        <text fg={theme.text.muted}>Nothing chosen here connects to an editor.</text>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / ide"
        details={[SETS[set()].label, linked() ? "linked" : "not linked", inEditor() ? "editor terminal" : "other terminal"]}
        message={message()}
        controls={[
          { shortcut: "f2", label: "windows" },
          { shortcut: "f3", label: "linked" },
          { shortcut: "f4", label: "terminal" },
          { shortcut: "f5", label: "open picker" },
          { shortcut: "f6", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const ideStory: Story = {
  id: "ide",
  title: "Editor dialog",
  render: (context) => <IdeStory context={context} />,
}
