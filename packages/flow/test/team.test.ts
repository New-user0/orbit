import { expect, test } from "bun:test"
import { introduction, parse, update } from "../src/team"

test("a reply's messages, notes and done are parsed, with or without quotes", () => {
  expect(
    parse(`Working on it.
<message to="coder">Write the parser.
Use the spec in docs/.</message>
<message to=all>Standup in 5.</message>
<note key="plan">parser, then tests</note>
<note key='owner'>coder</note>
<DONE> shipped </DONE>`),
  ).toEqual({
    messages: [
      { to: "coder", text: "Write the parser.\nUse the spec in docs/." },
      { to: "all", text: "Standup in 5." },
    ],
    notes: [
      { key: "plan", text: "parser, then tests" },
      { key: "owner", text: "coder" },
    ],
    done: "shipped",
  })
  expect(parse("Nothing to say.")).toEqual({ messages: [], notes: [] })
})

test("the introduction tells the lead how to finish and members whom to report to", () => {
  const members = { lead: { role: "Coordinate." }, coder: { role: "Write code." } }
  const lead = introduction({ name: "lead", goal: "Ship it.", members, lead: "lead" })
  const coder = introduction({ name: "coder", goal: "Ship it.", members, lead: "lead" })
  expect(lead).toContain('You are "lead"')
  expect(lead).toContain("- lead (lead): Coordinate.")
  expect(lead).toContain("<done>")
  expect(coder).toContain("report back to lead")
  expect(coder).not.toContain("Only the lead can finish")
})

test("an update lists new messages and the board", () => {
  expect(update([{ from: "lead", to: "coder", text: "Go." }], { plan: "one step" })).toBe(
    "New messages:\n[from lead] Go.\n\nBoard:\n- plan: one step\n\nContinue in your role.",
  )
  expect(update([], {})).toBe("No new messages.\n\nContinue in your role.")
})
