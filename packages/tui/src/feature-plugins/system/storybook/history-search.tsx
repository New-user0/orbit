import type { Plugin } from "@orbit/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { DialogHistorySearch } from "../../../component/prompt/dialog-history-search"
import type { PromptInfo } from "../../../prompt/history"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const here = "/Users/kit/code/open-source/orbit"
const elsewhere = "/Users/kit/code/open-source/orbit-docs"
const now = Date.now()
const minutes = (count: number) => now - count * 60_000

const entry = (text: string, directory: string, time: number, mode?: "shell"): PromptInfo => ({
  text,
  files: [],
  agents: [],
  skills: [],
  pasted: [],
  directory,
  time,
  mode,
})

// Oldest first, as the history file is.
const fixture: PromptInfo[] = [
  entry("explain how the session inbox delivers a steered prompt", elsewhere, minutes(2000)),
  entry("bun run check", here, minutes(900), "shell"),
  entry("fix the flaky dialog flow test\nit fails on the second run only", here, minutes(300)),
  entry("write a changelog entry for the keybindings file", elsewhere, minutes(120)),
  entry("git status", here, minutes(60), "shell"),
  entry("add a story for the history search dialog", here, minutes(5)),
]

function HistorySearchStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [directory, setDirectory] = createSignal<string | undefined>(here)
  const [restored, setRestored] = createSignal<PromptInfo>()

  const open = () =>
    props.context.ui.dialog.show(() => (
      <DialogHistorySearch
        entries={fixture}
        directory={directory()}
        // The choice stays in this story: nothing is sent and no history file is read or written.
        onSelect={setRestored}
      />
    ))

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "ctrl+r", title: "Search prompt history", group: "Storybook", run: open },
      {
        bind: "ctrl+g",
        title: "Switch the current directory",
        group: "Storybook",
        run: () => setDirectory((value) => (value === here ? elsewhere : value === elsewhere ? undefined : here)),
      },
      {
        bind: "ctrl+x",
        title: "Reset",
        group: "Storybook",
        run: () => {
          setRestored(undefined)
          setDirectory(here)
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.raised.base}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexGrow={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Prompt composer
        </text>
        <text fg={theme.text.muted}>
          {restored()
            ? `${restored()?.mode === "shell" ? "shell mode · " : ""}loaded from history`
            : "press ctrl+r to search earlier prompts"}
        </text>
        <box height={1} />
        <text fg={theme.text.base}>{restored()?.text ?? ""}</text>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / prompt history search"
        details={[`current directory: ${directory() ?? "none"}`]}
        controls={[
          { shortcut: "ctrl+r", label: "search" },
          { shortcut: "ctrl+g", label: "current directory" },
          { shortcut: "ctrl+x", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const historySearchStory: Story = {
  id: "history-search",
  title: "Prompt history search",
  render: (context) => <HistorySearchStory context={context} />,
}
