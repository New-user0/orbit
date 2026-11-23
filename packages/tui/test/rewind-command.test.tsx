import { expect, test } from "bun:test"
import { projectedPromptInput } from "../src/prompt/codec"
import { tmpdir } from "./fixture/fixture"
import { conversation, linesWith, listHeading, rewindApp, until } from "./fixture/rewind"

// m5-quality, FU-M5-002: a prompt the person gave as a slash command is shown and given back as they typed it,
// `/name args`, as the reference shows it, while the model got the command's expansion. The server records the command
// on the user message (`command: { name, arguments }`); the terminal UI draws it on the rewind picker's row, in step 2's
// quote and in the transcript, and a conversation rewind puts `/name args` back in the input, so sending it runs the
// command again. A prompt with no command is drawn and put back as its text (the control: every other row here).

const now = Date.now()
const EXPANDED = "Review the helper's callers carefully. EXPANDED-BODY"
const SHOWN = "/review src/helper.ts"

// The conversation, with the second prompt (`msg_0003`) given as `/review src/helper.ts`.
const withCommand = conversation.map((message) =>
  message.id === "msg_0003"
    ? {
        id: "msg_0003",
        type: "user",
        text: EXPANDED,
        command: { name: "review", arguments: "src/helper.ts" },
        time: { created: now - 2 * 60 * 60_000 },
      }
    : message,
)

test.each([64, 120])(
  "a slash command's prompt is its command on the row, in the quote and in the transcript, at %i columns",
  async (width) => {
    await using state = await tmpdir()
    await using setup = await rewindApp({ state: state.path, width, messages: withCommand })
    await setup.waitForFrame((frame) => frame.includes("Renamed it."))
    await setup.mockInput.typeText("/rewind")
    setup.mockInput.pressEnter()
    const list = await setup.waitForFrame((frame) => frame.includes(listHeading) && frame.includes("(current)"))
    // The row and the transcript behind the picker draw the command; the expansion is drawn nowhere.
    expect(list).toContain(SHOWN)
    expect(list).not.toContain("EXPANDED-BODY")
    // The control: a prompt with no command is its text.
    expect(list).toContain("Add the parser")

    // Up from "(current)": the newest prompt, then the command's.
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressEnter()
    const confirm = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
    expect(linesWith(confirm, SHOWN)).toBeGreaterThan(0)
    expect(confirm).not.toContain("EXPANDED-BODY")
  },
)

test("a conversation rewind to a slash command's prompt puts the command back in the input", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, messages: withCommand })
  await setup.waitForFrame((frame) => frame.includes("Renamed it."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(listHeading))
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  // The transcript keeps the prompt (the fake server sends no revert event) and the input holds it again: two lines.
  const frame = await setup.waitForFrame(
    (frame) => !frame.includes("Do nothing") && !frame.includes(listHeading) && linesWith(frame, SHOWN) === 2,
    { maxPasses: 200 },
  )
  expect(linesWith(frame, SHOWN)).toBe(2)
  expect(frame).not.toContain("EXPANDED-BODY")
})

// Every other place that puts an earlier or queued prompt back in the input (the message dialog's Rewind, an interrupt
// before the reply, undoing a queued prompt, a fork) and Mini's turns read the prompt through `projectedPromptInput`.
test("a slash command's prompt is given back as `/name args`, and `/name ` with no arguments, with its attachments", () => {
  type Projected = Parameters<typeof projectedPromptInput>[0]
  const files = [
    {
      mime: "text/plain",
      name: "notes.txt",
      source: { type: "uri", uri: "file:///workspace/notes.txt" },
    },
  ]
  expect(
    projectedPromptInput({
      text: EXPANDED,
      files,
      command: { name: "review", arguments: "src/helper.ts" },
    } as unknown as Projected),
  ).toMatchObject({ text: SHOWN, files: [{ uri: "file:///workspace/notes.txt", name: "notes.txt" }] })
  expect(
    projectedPromptInput({ text: EXPANDED, command: { name: "review", arguments: "" } } as unknown as Projected).text,
  ).toBe("/review ")
  // The control: a prompt with no command is given back as its text.
  expect(projectedPromptInput({ text: "Add the parser" } as Projected).text).toBe("Add the parser")
})
