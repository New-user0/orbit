import { expect, test } from "bun:test"
import type { OrbitEvent } from "@orbit/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// context-memory-1 part 2: the real terminal UI draws the latest `session.context.updated` of the session in view in the
// prompt's footer row, as the reference draws its context warning in the prompt's footer, at narrow and wide widths.

type Report = Extract<OrbitEvent, { type: "session.context.updated" }>["data"]

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_context",
  title: "Long session",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

// A 200,000-token window with a 32,000-token output limit: the window less the summary's room is 180,000 and automatic
// compaction starts at 167,000 (SessionContextWindow). With it off, 175,000 in use leaves 3% of 180,000; with it on,
// 160,000 in use leaves 4% of 167,000. Both are inside the reference's 20,000-token band, so the state is `error`.
const off: Report = {
  sessionID: session.id,
  used: 175_000,
  window: 180_000,
  threshold: 167_000,
  auto: false,
  percentLeft: 3,
  state: "error",
  blocking: 177_000,
  paused: false,
  stale: false,
}
const on: Report = {
  sessionID: session.id,
  used: 160_000,
  window: 180_000,
  threshold: 167_000,
  auto: true,
  percentLeft: 4,
  state: "error",
  paused: false,
  stale: false,
}

function render(state: string, width: number) {
  return createAppFixture({
    state,
    width,
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      // A report is published only after a measured response, so the session in view always has one: the footer then
      // also has the context bar to place beside the warning.
      if (url.pathname === `/api/session/${session.id}/message`)
        return json({
          data: [
            {
              id: "msg_0001",
              type: "assistant",
              agent: session.agent,
              model: session.model,
              time: { created: 1, streamed: 2, completed: 3 },
              finish: "stop",
              cost: 0,
              tokens: { input: 175_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              content: [{ type: "text", text: "Answer" }],
            },
          ],
          cursor: {},
        })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [
            {
              id: "model",
              providerID: "provider",
              name: "Model",
              variants: [],
              limit: { context: 200_000, output: 32_000 },
            },
          ],
        })
    },
  })
}

// The footer row is the line under the prompt box's bottom border.
function footerRow(frame: string) {
  const lines = frame.split("\n")
  return lines[lines.findLastIndex((line) => line.trimStart().startsWith("╰")) + 1] ?? ""
}

// The prompt has drawn its footer once the location label (with its branch) is on the footer row.
const ready = (frame: string) => footerRow(frame).includes(":main")
const measured = (frame: string) => ready(frame) && footerRow(frame).includes("88%")

test.each([
  // The reference keeps the warning visible and cuts it at its end when the row is short, so 40 columns keep its start
  // and percent; from 80 columns the whole line shows, beside the model, instead of the context bar and the shortcuts.
  { name: "automatic compaction off", width: 120, report: off, text: "Context almost full (3% left) · run /compact" },
  { name: "automatic compaction off", width: 80, report: off, text: "Context almost full (3% left) · run /compact" },
  { name: "automatic compaction off", width: 90, report: off, text: "Context almost full (3% left) · run /compact" },
  { name: "automatic compaction off", width: 40, report: off, text: "Context almost full (3%" },
  { name: "automatic compaction on", width: 120, report: on, text: "4% left before auto-compaction" },
  { name: "automatic compaction on", width: 80, report: on, text: "4% left before auto-compaction" },
  { name: "automatic compaction on", width: 40, report: on, text: "4% left before auto" },
])("the prompt's footer row says the context is almost full with $name at $width columns", async (row) => {
  await using state = await tmpdir()
  await using setup = await render(state.path, row.width)
  // The measured response is loaded, so the footer has its context bar when the report arrives.
  await setup.waitForFrame(measured)

  setup.events.emit({
    id: "evt_context",
    created: 1,
    type: "session.context.updated",
    location: { directory },
    data: row.report,
  })
  const frame = await setup.waitForFrame((frame) => footerRow(frame).includes(row.text))

  expect(footerRow(frame)).toContain(row.text)
  // The model label keeps its place at the start of the row.
  expect(footerRow(frame)).toContain("Model")
  // The warning reports the same figure more precisely, so the bar gives way to it.
  expect(footerRow(frame)).not.toContain("88%")
  // The shortcuts give way to the warning when the row cannot hold both, and stay when it can.
  expect(footerRow(frame).includes("shift")).toBe(row.width === 120)
})

test.each([40, 120])("nothing is drawn at %s columns before a report arrives", async (width) => {
  await using state = await tmpdir()
  await using setup = await render(state.path, width)
  const frame = await setup.waitForFrame(ready)

  expect(frame).not.toContain("Context almost full")
  expect(frame).not.toContain("before auto-compaction")
})
