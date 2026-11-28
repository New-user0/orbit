import type { Plugin } from "@orbit/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { CostView } from "../../../component/dialog-cost"
import type { SessionCost } from "@orbit/schema/session-cost"
import { costSummary, type CostSummary } from "../../../util/cost"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const tokens = (scale: number) => ({
  input: 12_000 * scale,
  output: 3_400 * scale,
  reasoning: 800 * scale,
  cache: { read: 90_000 * scale, write: 6_000 * scale },
})

// Fixtures state plain numbers where the schema brands money.
const row = (modelID: string, overrides: Record<string, unknown> = {}) =>
  ({
    providerID: "a",
    modelID,
    responses: 3,
    tokens: tokens(1),
    cost: 0,
    unrecorded: 0,
    zero: 0,
    ...overrides,
  }) as unknown as SessionCost.Row
const summary = (info: Record<string, unknown>) =>
  costSummary({ cost: 0, own: 0, subagents: 0, rows: [], ...info } as unknown as SessionCost.Info, undefined)

// Fixture summaries: a priced session with two models, a model with no price, a partly priced session, subagents,
// spend no row explains, a session from before lines were counted, and a session with nothing.
const FIXTURES: ReadonlyArray<{ label: string; summary: CostSummary }> = [
  {
    label: "two priced models",
    summary: summary({
      cost: 1.2345,
      own: 1.2345,
      wall: 18 * 60_000 + 5_000,
      api: 6 * 60_000 + 40_000,
      lines: { added: 214, removed: 37 },
      rows: [
        row("large", { responses: 5, tokens: tokens(2), cost: 1.0 }),
        row("small", { cost: 0.2345 }),
      ],
    }),
  },
  {
    label: "price unknown",
    summary: summary({ rows: [row("mystery", { providerID: "local", responses: 2, unrecorded: 2 })] }),
  },
  {
    label: "partly priced",
    summary: summary({
      cost: 0.5,
      own: 0.5,
      wall: 95_000,
      api: 40_000,
      rows: [row("large", { responses: 2, cost: 0.5, unrecorded: 1 }), row("mystery", { providerID: "local", unrecorded: 1, responses: 1 })],
    }),
  },
  {
    label: "with subagents",
    summary: summary({
      cost: 2,
      own: 1.2,
      subagents: 0.8,
      wall: 95_000,
      api: 40_000,
      lines: { added: 3, removed: 0 },
      rows: [row("large", { responses: 4, tokens: tokens(2), cost: 2 })],
    }),
  },
  {
    label: "other usage, no line counts",
    summary: summary({
      cost: 0.62,
      own: 0.62,
      other: 0.12,
      wall: 95_000,
      api: 40_000,
      rows: [row("large", { responses: 2, tokens: tokens(2), cost: 0.5 })],
    }),
  },
  { label: "no responses", summary: summary({ lines: { added: 0, removed: 0 } }) },
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
