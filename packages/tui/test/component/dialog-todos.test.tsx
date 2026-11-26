import { expect, test } from "bun:test"
import { DialogTodos, TodosView } from "../../src/component/dialog-todos"
import { PlanDock } from "../../src/routes/session/plan-dock"
import { json } from "../fixture/tui-client"
import { renderLocal, session as sessionFixture } from "../fixture/local"

const todos = [
  { content: "write the parser", status: "completed" },
  { content: "wire the command", status: "in_progress" },
  { content: "document it\u001b[31m", status: "pending" },
]

const call = (name: string, part: Record<string, unknown>) => ({
  id: "a",
  type: "assistant",
  content: [{ type: "tool", id: "p", name, state: { status: "completed", content: [], ...part } }],
})

// The marks and the text of each plan row, whichever component drew them.
const rows = (frame: string) => frame.split("\n").flatMap((line) => (/write the parser|wire the command|document it/.test(line) ? [line.trim().replace(/\s+/g, " ")] : []))

test.each([
  ["a todo call", call("todo", { input: { todos }, metadata: {} })],
  ["a task tool's list", call("task_update", { input: {}, metadata: { todos } })],
])("/todos draws the same plan as the dock for %s", async (_name, message) => {
  await using setup = await renderLocal({
    sessions: [sessionFixture("plan")],
    fetch: async (url) => {
      if (url.pathname === "/api/session/plan/message") return json({ data: [message], cursor: {} })
    },
  })
  await setup.data.session.sync("plan")
  await setup.data.session.message.sync("plan")

  setup.dialog.replace(() => <PlanDock sessionID="plan" />)
  const dock = rows(await setup.waitForFrame((frame) => frame.includes("write the parser")))
  setup.dialog.replace(() => <DialogTodos sessionID="plan" />)
  const dialog = await setup.waitForFrame((frame) => frame.includes("Plan") && frame.includes("3 steps"))

  expect(rows(dialog)).toEqual(dock)
  expect(dock).toHaveLength(3)
  expect(dialog).toContain("1 done · 1 in progress · 1 open")
  // The escape sequence in the model's text is written out, not sent to the terminal.
  expect(dialog).not.toContain("\u001b")
})

test("a session without a plan, and no session, each say so", async () => {
  await using setup = await renderLocal()
  setup.dialog.replace(() => <DialogTodos sessionID="none" />)
  expect(await setup.waitForFrame((frame) => frame.includes("no plan yet"))).toContain("This session has no plan yet.")
  setup.dialog.replace(() => <DialogTodos />)
  expect(await setup.waitForFrame((frame) => frame.includes("No session is open."))).toContain("No session is open.")
})

test("the count leaves out in progress when nothing is", async () => {
  await using setup = await renderLocal()
  setup.dialog.replace(() => <TodosView session items={[{ content: "one", status: "pending" }]} />)
  const frame = await setup.waitForFrame((frame) => frame.includes("1 step"))
  expect(frame).toContain("1 step · 0 done · 1 open")
})

test("a plan longer than the screen scrolls inside the dialog and says so", async () => {
  await using setup = await renderLocal()
  const items = Array.from({ length: 40 }, (_, index) => ({
    content: `Step ${index + 1}`,
    status: index === 0 ? ("in_progress" as const) : ("pending" as const),
  }))
  setup.dialog.replace(() => <TodosView items={items} session />)
  const first = await setup.waitForFrame((frame) => frame.includes("40 steps"))
  expect(first).toContain("Step 1")
  expect(first).not.toContain("Step 40")
  expect(first).toContain("scroll")

  await Bun.sleep(60)
  for (let index = 0; index < 40; index++) setup.mockInput.pressArrow("down")
  const last = await setup.waitForFrame((frame) => frame.includes("Step 40"))
  // Rows are padded to the terminal width, so compare trimmed rows.
  const trimmed = last.split("\n").map((line) => line.trimEnd())
  expect(trimmed.some((line) => line.endsWith("Step 1"))).toBe(false)
  expect(trimmed.some((line) => line.endsWith("Step 40"))).toBe(true)
})
