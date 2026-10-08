import type { Plugin } from "@orbit/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { CostView } from "../../../component/dialog-cost"
import type { CostSummary } from "../../../util/cost"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const tokens = (scale: number) => ({
  input: 12_000 * scale,
  output: 3_400 * scale,
  reasoning: 800 * scale,
  cache: { read: 90_000 * scale, write: 6_000 * scale },
})

// Fixture summaries: a priced session with two models, one with a model that has no price, and a session with nothing.
const FIXTURES: ReadonlyArray<{ label: string; summary: CostSummary }> = [
  {
    label: "two priced models",
    summary: {
      cost: 1.2345,
      partial: false,
      tokens: tokens(3),
      wall: 18 * 60_000 + 5_000,
      api: 6 * 60_000 + 40_000,
      models: [
        { providerID: "a", modelID: "large", name: "Large", responses: 5, tokens: tokens(2), cost: 1.0, unpriced: 0 },
        { providerID: "a", modelID: "small", name: "Small", responses: 3, tokens: tokens(1), cost: 0.2345, unpriced: 0 },
      ],
    },
  },
  {
    label: "price unknown",
    summary: {
      cost: undefined,
      partial: false,
      tokens: tokens(1),
      wall: undefined,
      api: undefined,
      models: [
        { providerID: "local", modelID: "mystery", name: "Mystery", responses: 2, tokens: tokens(1), cost: undefined, unpriced: 2 },
      ],
    },
  },
  {
    label: "partly priced",
    summary: {
      cost: 0.5,
      partial: true,
      tokens: tokens(2),
      wall: 95_000,
      api: 40_000,
      models: [
        { providerID: "a", modelID: "large", name: "Large", responses: 2, tokens: tokens(1), cost: 0.5, unpriced: 1 },
        { providerID: "local", modelID: "mystery", name: "Mystery", responses: 1, tokens: tokens(1), cost: undefined, unpriced: 1 },
      ],
    },
  },
  {
    label: "no responses",
    summary: { cost: 0, partial: false, tokens: tokens(0), wall: undefined, api: undefined, models: [] },
  },
]

function CostStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [index, setIndex] = createSignal(0)
  const fixture = createMemo(() => FIXTURES[index()])

  props.context.keymap.layer(() => ({
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
      { bind: "ctrl+x", title: "Reset", group: "Storybook", run: () => setIndex(0) },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.raised.base}>
      <box paddingTop={1} flexGrow={1}>
        {/* Nothing here reads the data store or sends anything: the view is drawn from the fixture. */}
        <CostView summary={fixture().summary} />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / cost"
        details={[`fixture: ${fixture().label}`]}
        controls={[
          { shortcut: "ctrl+g", label: "next fixture" },
          { shortcut: "ctrl+x", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const costStory: Story = {
  id: "cost",
  title: "Cost dialog",
  render: (context) => <CostStory context={context} />,
}
