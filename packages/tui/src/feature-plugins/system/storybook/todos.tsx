import type { Plugin } from "@orbit/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { TodosView } from "../../../component/dialog-todos"
import type { TodoItem } from "../../../util/tool-display"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const FIXTURES: ReadonlyArray<{ label: string; session: boolean; items: TodoItem[] }> = [
  {
    label: "a plan under way",
    session: true,
    items: [
      { content: "Read the parser and its tests", status: "completed" },
      { content: "Add the alias table", status: "in_progress" },
      { content: "Document the new commands", status: "pending" },
      { content: "Run the whole suite", status: "pending" },
    ],
  },
  { label: "all done", session: true, items: [{ content: "Ship it", status: "completed" }] },
  { label: "nothing open", session: true, items: [] },
  { label: "no session", session: false, items: [] },
  {
    label: "a hostile line",
    session: true,
    items: [
      { content: "Fix the \u001b[31mred\u001b[0m heading\u0007 and the very long line that goes on and on past the edge of a narrow terminal", status: "in_progress" },
      { content: "Second", status: "pending" },
    ],
  },
  {
    label: "a long plan",
    session: true,
    items: Array.from({ length: 24 }, (_, index) => ({
      content: `Step ${index + 1}`,
      status: index < 9 ? ("completed" as const) : index === 9 ? ("in_progress" as const) : ("pending" as const),
    })),
  },
]

function TodosStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [index, setIndex] = createSignal(0)
  const fixture = createMemo(() => FIXTURES[index()])

  // The view's scroll keys live in the modal layer, as in the dialog; the story's own keys join them.
  createEffect(() => onCleanup(props.context.keymap.mode.push("modal")))
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      {
        bind: "ctrl+g",
        title: "Next fixture",
        group: "Storybook",
        run: () => setIndex((value) => (value + 1) % FIXTURES.length),
      },
      { bind: "ctrl+r", title: "Reset", group: "Storybook", run: () => setIndex(0) },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.raised.base}>
      <box paddingTop={1} flexGrow={1}>
        {/* Nothing here reads the data store or sends anything: the view is drawn from the fixture. */}
        <TodosView items={fixture().items} session={fixture().session} />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / todos"
        details={[`fixture: ${fixture().label}`]}
        controls={[
          { shortcut: "ctrl+g", label: "next fixture" },
          { shortcut: "ctrl+r", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const todosStory: Story = {
  id: "todos",
  title: "Plan dialog",
  render: (context) => <TodosStory context={context} />,
}
