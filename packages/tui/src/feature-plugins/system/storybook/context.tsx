import type { Plugin } from "@orbit/plugin/tui"
import type { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { ContextView } from "../../../component/dialog-context"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

type Info = SessionContextUsage.Info

const directory = "/work/orbit"
const breakdown = (tools: Info["messages"]["tools"] = []): Info["messages"] => ({
  toolCalls: 4_000,
  toolResults: 22_000,
  attachments: 1_500,
  assistant: 6_000,
  user: 2_500,
  tools,
  attachmentKinds: [{ name: "todo", tokens: 1_500 }],
})

const base: Info = {
  model: { providerID: "provider", id: "large-model" } as Info["model"],
  window: 200_000,
  percentage: 31,
  threshold: 167_000,
  total: 62_400,
  measured: true,
  auto: true,
  categories: [
    { kind: "system", tokens: 5_200 },
    { kind: "tools", tokens: 14_800 },
    { kind: "mcp", tokens: 3_100 },
    { kind: "mcp-deferred", tokens: 2_400 },
    { kind: "agents", tokens: 700 },
    { kind: "instructions", tokens: 4_600 },
    { kind: "skills", tokens: 900 },
    { kind: "messages", tokens: 36_000 },
    { kind: "auto-buffer", tokens: 33_000 },
    { kind: "free", tokens: 101_700 },
  ],
  files: [
    { path: `${directory}/ORBIT.md`, type: "file", tokens: 3_400 },
    { path: `${directory}/packages/core/ORBIT.md`, type: "file", tokens: 1_200 },
  ],
  mcp: [
    { name: "docs_search", server: "docs", tokens: 1_900, deferred: false },
    { name: "docs_fetch", server: "docs", tokens: 1_200, deferred: false },
    { name: "tracker_issue", server: "tracker", tokens: 2_400, deferred: true },
  ],
  agents: [
    { id: "reviewer", scope: "project", tokens: 400 },
    { id: "writer", scope: "user", tokens: 300 },
  ],
  skills: [{ id: "release", tokens: 900 }],
  systemTools: [{ name: "Read", tokens: 1_400 }],
  deferredTools: [],
  sections: [{ name: "Environment", tokens: 1_100 }],
  messages: breakdown([{ name: "Read", calls: 1_000, results: 14_000 }]),
}

// Fixtures: a usual session, one near full with every suggestion, automatic compaction off, a million-token window, a
// model whose window is unknown, and names that carry terminal control characters. The usual session has a deferred MCP
// tool: its category is in neither the legend nor the grid, and the MCP tools heading says some load on demand.
const FIXTURES: ReadonlyArray<{ label: string; info: Info }> = [
  { label: "typical", info: base },
  {
    label: "near full",
    info: {
      ...base,
      percentage: 86,
      total: 172_000,
      categories: [
        { kind: "system", tokens: 5_200 },
        { kind: "tools", tokens: 14_800 },
        { kind: "instructions", tokens: 12_000 },
        { kind: "messages", tokens: 140_000 },
        { kind: "auto-buffer", tokens: 33_000 },
        { kind: "free", tokens: 0 },
      ],
      files: [
        { path: `${directory}/ORBIT.md`, type: "file", tokens: 7_000 },
        { path: `${directory}/docs/ORBIT.md`, type: "file", tokens: 3_000 },
        { path: `${directory}/ORBIT.local.md`, type: "file", tokens: 2_000 },
      ],
      messages: breakdown([
        { name: "Bash", calls: 6_000, results: 40_000 },
        { name: "Read", calls: 2_000, results: 38_000 },
        { name: "WebFetch", calls: 500, results: 31_000 },
      ]),
    },
  },
  {
    label: "auto compaction off",
    info: {
      ...base,
      auto: false,
      percentage: 64,
      total: 128_000,
      categories: [
        { kind: "system", tokens: 5_200 },
        { kind: "tools", tokens: 14_800 },
        { kind: "messages", tokens: 108_000 },
        { kind: "compact-buffer", tokens: 3_000 },
        { kind: "free", tokens: 69_000 },
      ],
    },
  },
  {
    label: "1M window",
    info: {
      ...base,
      window: 1_000_000,
      percentage: 6,
      threshold: 967_000,
      categories: base.categories.map((item) =>
        item.kind === "free" ? { kind: "free", tokens: 901_700 } : item,
      ),
    },
  },
  {
    label: "unknown window",
    info: {
      ...base,
      window: undefined,
      percentage: undefined,
      threshold: undefined,
      categories: base.categories.filter((item) => item.kind !== "free" && item.kind !== "auto-buffer"),
    },
  },
  {
    label: "hostile names",
    info: {
      ...base,
      files: [{ path: `${directory}/evil\x1b]0;title\x07.md`, type: "file", tokens: 900 }],
      mcp: [{ name: "tool\x1b[2Kname", server: "srv\u202eevil", tokens: 600, deferred: false }],
      agents: [{ id: "agent\u009bx", scope: "project", tokens: 200 }],
    },
  },
]

function ContextStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [index, setIndex] = createSignal(0)
  const fixture = createMemo(() => FIXTURES[index()]!)

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
      <box paddingTop={1} paddingLeft={2} flexGrow={1}>
        {/* Nothing here asks the server: the view is drawn from the fixture. Resize below 80 columns for the narrow grid. */}
        <ContextView info={fixture().info} directory={directory} />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / context"
        details={[`fixture: ${fixture().label}`, `width: ${dimensions().width}`]}
        controls={[
          { shortcut: "ctrl+g", label: "next fixture" },
          { shortcut: "ctrl+x", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const contextStory: Story = {
  id: "context",
  title: "Context usage dialog",
  render: (context) => <ContextStory context={context} />,
}
