import { expect, test } from "bun:test"
import path from "node:path"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"

// The status line command is the person's own and stands in for a hook, so it follows the organization's hook switches
// as the hook runners do (class 7: an answer that is missing, old or failed does not run it). The real app draws it; the
// marker file shows whether the command ran at all.
const bun = process.execPath.replaceAll("\\", "/")
const base = { compatibility: true, plugins: {} }

const rows = [
  {
    name: "hooks open (control)",
    answer: () => json({ ...base, hooks: { disabled: false, managed_only: false } }),
    ran: true,
    notice: undefined,
  },
  {
    name: "managed settings turn hooks off",
    answer: () => json({ ...base, hooks: { disabled: true, managed_only: false } }),
    ran: false,
    notice: "Status line off: managed settings turn hooks off",
  },
  {
    name: "managed settings allow only managed hooks",
    answer: () => json({ ...base, hooks: { disabled: false, managed_only: true } }),
    ran: false,
    notice: "Status line off: managed settings allow only managed hooks",
  },
  {
    name: "hooks off and managed only together",
    answer: () => json({ ...base, hooks: { disabled: true, managed_only: true } }),
    ran: false,
    notice: "Status line off: managed settings turn hooks off",
  },
  { name: "a server that does not report hooks", answer: () => json(base), ran: false, notice: undefined },
  {
    name: "a server that fails to answer",
    answer: () => new Response("gone", { status: 503 }),
    ran: false,
    notice: undefined,
  },
]

test.each(rows)("the status line, with $name", async (row) => {
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  const marker = path.join(scripts.path, "marker.txt").replaceAll("\\", "/")
  const script = path.join(scripts.path, "line.ts").replaceAll("\\", "/")
  await Bun.write(script, `await Bun.write(${JSON.stringify(marker)}, "x"); console.log("LINE-DRAWN")`)
  await using setup = await createAppFixture({
    state: state.path,
    width: 120,
    config: { animations: false, status_line: { interval: 1_000, command: `${bun} ${script}` } },
    fetch: (url) => (url.pathname === "/api/config/effective" ? row.answer() : undefined),
  })
  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  // Past the interval, so a command that is allowed to run has run and been drawn.
  await Bun.sleep(row.ran ? 1_500 : 2_500)
  if (row.ran) await setup.waitForFrame((frame) => frame.includes("LINE-DRAWN"))
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(await Bun.file(marker).exists()).toBe(row.ran)
  expect(frame.includes("LINE-DRAWN")).toBe(row.ran)
  if (row.notice) expect(frame).toContain(row.notice)
  else expect(frame).not.toContain("Status line off")
}, 30_000)

// The reference shows every non-empty line of the output; a leading blank line must not hide the rest.
test("the status line draws every non-empty line, below one another, and skips a leading blank line", async () => {
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  const script = path.join(scripts.path, "lines.ts").replaceAll("\\", "/")
  await Bun.write(script, `console.log("\\n  LINE-ONE\\n\\nLINE-TWO  \\nLINE-THREE")`)
  await using setup = await createAppFixture({
    state: state.path,
    width: 120,
    config: { animations: false, status_line: { interval: 60_000, command: `${bun} ${script}` } },
  })
  await setup.ready
  // the command runs `bun <script>` at mount; give the first run room before the bounded frame wait
  await Bun.sleep(2_500)
  await setup.renderOnce()
  await setup.waitForFrame((frame) => frame.includes("LINE-THREE"))
  const rows = setup.captureCharFrame().split("\n")
  const at = (text: string) => rows.findIndex((row) => row.includes(text))
  expect([at("LINE-ONE"), at("LINE-TWO"), at("LINE-THREE")]).toEqual([at("LINE-ONE"), at("LINE-ONE") + 1, at("LINE-ONE") + 2])
  expect(at("LINE-ONE")).toBeGreaterThanOrEqual(0)
}, 30_000)
