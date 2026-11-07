import type { Plugin } from "@orbit/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import {
  DialogRewind,
  type RewindDryRun,
  type RewindFileStat,
  type RewindPrompt,
} from "../../../routes/session/dialog-rewind"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

const hour = 60 * 60_000

type Fixture = {
  label: string
  prompts: RewindPrompt[]
  /** A missing entry draws that row's warning, as a failed `scope=prompt` request does. */
  stats: Record<string, RewindFileStat[]>
  dryRuns: Record<string, RewindDryRun>
}

const FIXTURES: Fixture[] = [
  {
    label: "a session with edits",
    prompts: [
      { id: "p1", text: "Add the parser", created: Date.now() - 3 * hour },
      { id: "p2", text: "Rename the helper and update every caller", created: Date.now() - 2 * hour },
      { id: "p3", text: "Explain the change", created: Date.now() - 10 * 60_000 },
    ],
    stats: {
      p1: [{ file: "src/parser.ts", additions: 12, deletions: 0 }],
      p2: [
        { file: "src/a.ts", additions: 3, deletions: 1 },
        { file: "src/b.ts", additions: 2, deletions: 2 },
        { file: "src/c.ts", additions: 1, deletions: 0 },
      ],
      p3: [],
    },
    dryRuns: {
      p1: {
        canRewind: true,
        filesChanged: ["/work/src/parser.ts", "/work/src/a.ts", "/work/src/b.ts"],
        insertions: 6,
        deletions: 15,
      },
      p2: { canRewind: true, filesChanged: ["/work/src/a.ts", "/work/src/b.ts"], insertions: 3, deletions: 5 },
      p3: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 },
    },
  },
  { label: "nothing to rewind", prompts: [], stats: {}, dryRuns: {} },
  {
    label: "code unavailable",
    prompts: [{ id: "p1", text: "Rewrite the build script", created: Date.now() - hour }],
    stats: {},
    dryRuns: { p1: { canRewind: false } },
  },
  {
    label: "hostile names",
    prompts: [{ id: "p1", text: "Fix the \u001b]0;pwned\u0007 title", created: Date.now() - 5 * 60_000 }],
    stats: { p1: [{ file: "src/evil\u001b[2K\u001b]0;pwned\u0007name.ts", additions: 1, deletions: 1 }] },
    dryRuns: {
      p1: {
        canRewind: true,
        filesChanged: ["/work/src/evil\u001b[2K\u001b]0;pwned\u0007name.ts"],
        insertions: 1,
        deletions: 1,
      },
    },
  },
]

function RewindStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [index, setIndex] = createSignal(0)
  const [message, setMessage] = createSignal("picker open")

  // The real picker, answered from the fixture: nothing is sent to a server, so every option is safe to choose.
  const open = () => {
    const fixture = FIXTURES[index()]
    setMessage("picker open")
    props.context.ui.dialog.show(() => (
      <DialogRewind
        prompts={fixture.prompts}
        stats={(id) => (fixture.stats[id] ? Promise.resolve(fixture.stats[id]) : Promise.reject(new Error("no range")))}
        dryRun={(id) => Promise.resolve(fixture.dryRuns[id])}
        act={async (option, id) => {
          setMessage(`${option} chosen for ${id}`)
        }}
        onClose={() => props.context.ui.dialog.clear()}
      />
    ))
  }
  onMount(open)

  const select = (next: number) => {
    setIndex(next)
    open()
  }

  // The fixture keys work while the picker is open, so they sit in the global layer.
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        bind: "ctrl+g",
        title: "Next fixture",
        group: "Storybook",
        run: () => select((index() + 1) % FIXTURES.length),
      },
      { bind: "ctrl+r", title: "Reset", group: "Storybook", run: () => select(0) },
    ],
  }))
  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.base}>
      <box paddingLeft={2} paddingTop={1} flexGrow={1}>
        <text fg={theme.text.muted}>The picker opens over this screen as it does over a session.</text>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / rewind"
        details={[`fixture: ${FIXTURES[index()].label}`]}
        message={message()}
        controls={[
          { shortcut: "ctrl+g", label: "next fixture" },
          { shortcut: "ctrl+r", label: "reset" },
          { shortcut: "esc", label: "close, then back" },
        ]}
      />
    </box>
  )
}

export const rewindStory: Story = {
  id: "rewind",
  title: "Rewind picker",
  render: (context) => <RewindStory context={context} />,
}
