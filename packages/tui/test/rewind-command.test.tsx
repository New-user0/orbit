import { expect, test } from "bun:test"
import { projectedPromptInput } from "../src/prompt/codec"
import { tmpdir } from "./fixture/fixture"
import { conversation, linesWith, listHeading, rewindApp, session, sessionID, until } from "./fixture/rewind"
import { json } from "./fixture/tui-client"
import { waitForFrame } from "./fixture/frame"

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
    await waitForFrame(setup, (frame) => frame.includes("Renamed it."))
    await setup.mockInput.typeText("/rewind")
    setup.mockInput.pressEnter()
    const list = await waitForFrame(setup, (frame) => frame.includes(listHeading) && frame.includes("(current)"))
    // The row and the transcript behind the picker draw the command; the expansion is drawn nowhere.
    expect(list).toContain(SHOWN)
    expect(list).not.toContain("EXPANDED-BODY")
    // The control: a prompt with no command is its text.
    expect(list).toContain("Add the parser")

    // Up from "(current)": the newest prompt, then the command's.
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressEnter()
    const confirm = await waitForFrame(setup, (frame) => frame.includes("Code and conversation"))
    expect(linesWith(confirm, SHOWN)).toBeGreaterThan(0)
    expect(confirm).not.toContain("EXPANDED-BODY")
  },
)

test("a conversation rewind to a slash command's prompt puts the command back in the input", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, messages: withCommand })
  await waitForFrame(setup, (frame) => frame.includes("Renamed it."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  await waitForFrame(setup, (frame) => frame.includes(listHeading))
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await waitForFrame(setup, (frame) => frame.includes("Conversation only"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  // The transcript keeps the prompt (the fake server sends no revert event) and the input holds it again: two lines.
  const frame = await waitForFrame(setup,
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

// Every other list of the person's prompts draws the command too: a queued prompt in the queue dock (and in the
// transcript, from the inbox), the timeline and the fork list. The expansion is drawn nowhere.
test("a queued slash command, the timeline and the fork list draw the command, not its expansion", async () => {
  await using state = await tmpdir()
  const queued = {
    id: "msg_queued",
    sessionID,
    type: "user",
    delivery: "queue",
    payload: { text: "Check later. QUEUED-BODY", command: { name: "check", arguments: "src/later.ts" } },
    time: { created: now },
  }
  await using setup = await rewindApp({
    state: state.path,
    messages: withCommand,
    answer: (request) => (request.path.endsWith("/inbox") ? json({ data: [queued] }) : undefined),
  })
  const first = await waitForFrame(setup, (frame) => frame.includes("Renamed it.") && frame.includes("/check src/later.ts"), {
    maxPasses: 200,
  })
  expect(first).not.toContain("QUEUED-BODY")
  expect(first).not.toContain("EXPANDED-BODY")

  for (const [command, title] of [
    ["/timeline", "Timeline"],
    ["/fork", "Fork session"],
  ]) {
    await setup.mockInput.typeText(command)
    setup.mockInput.pressEnter()
    const list = await waitForFrame(setup, (frame) => frame.includes(title) && frame.includes(SHOWN), {
      maxPasses: 200,
    })
    expect(list).not.toContain("EXPANDED-BODY")
    setup.mockInput.pressEscape()
    await waitForFrame(setup, (frame) => !frame.includes(title))
  }
})

// m5-quality, item 9c: a skill activated for the session (a `skill` message, from `POST /api/session/:id/skill`) is a
// row too, as the reference lists a person's skill invocation by its name: drawn `/name`, never its instructions. It has
// no checkpoint of its own, so step 2 offers only the conversation, and that puts `/name ` back in the input.
test("a skill message is a row drawn by its name, whose conversation rewind puts the skill back in the input", async () => {
  await using state = await tmpdir()
  const messages = [
    ...conversation.slice(0, 4),
    {
      id: "msg_0004s",
      type: "skill",
      skill: "skl_deploy",
      name: "deploy",
      text: "SKILL-INSTRUCTIONS for deploying",
      time: { created: now - 30 * 60_000 },
    },
    ...conversation.slice(4),
  ]
  await using setup = await rewindApp({ state: state.path, messages })
  await waitForFrame(setup, (frame) => frame.includes("Renamed it."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  const list = await waitForFrame(setup, (frame) => frame.includes(listHeading) && frame.includes("(current)"))
  expect(linesWith(list, "/deploy")).toBeGreaterThan(0)
  expect(list).not.toContain("SKILL-INSTRUCTIONS")

  // Up from "(current)": the newest prompt, then the skill.
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  const confirm = await waitForFrame(setup, (frame) => frame.includes("Conversation only"))
  expect(confirm).toContain("/deploy")
  expect(confirm).not.toContain("Code only")
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions().filter((action) => action !== "interrupt" && action !== "wait")).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0004s", files: false })}`,
  ])
  const frame = await waitForFrame(setup,
    (frame) => !frame.includes("Do nothing") && !frame.includes(listHeading) && linesWith(frame, "/deploy") > 0,
    { maxPasses: 200 },
  )
  expect(frame).not.toContain("SKILL-INSTRUCTIONS")
})

// m5-quality, item 9b (class 15): a list row is one line, so a prompt of several lines is drawn on its row with its
// breaks as spaces.
test("a prompt of several lines is one line on its row", async () => {
  await using state = await tmpdir()
  const lines = conversation.map((message) =>
    message.id === "msg_0003" ? { ...message, text: "Rename the helper\nand every caller" } : message,
  )
  await using setup = await rewindApp({ state: state.path, messages: lines })
  await waitForFrame(setup, (frame) => frame.includes("Renamed it."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  const list = await waitForFrame(setup, (frame) => frame.includes(listHeading) && frame.includes("(current)"))
  expect(linesWith(list, "Rename the helper and every caller")).toBe(1)
})

// Review of fix loop 1: the Markdown transcript (`/copy`, and `/export` as Markdown, which write the same text) shows a
// slash command's prompt as the command that was run, as the transcript on screen draws it and as the reference's export
// does. The expansion is the model's and is not in it. A prompt with no command is its text (the control).
test("the Markdown transcript shows a slash command's prompt as its command", async () => {
  await using state = await tmpdir()
  const written: string[] = []
  await using setup = await rewindApp({
    state: state.path,
    messages: withCommand,
    clipboard: {
      read: async () => undefined,
      write: async (value: string) => {
        written.push(value)
      },
      dispose: async () => {},
    },
    answer: (request) =>
      request.path === `/api/experimental/session/${sessionID}/export`
        ? json({ data: { info: session, messages: withCommand } })
        : undefined,
  })
  await waitForFrame(setup, (frame) => frame.includes("Renamed it."))
  await setup.mockInput.typeText("/copy")
  setup.mockInput.pressEnter()
  await until(() => written.length > 0, "the transcript on the clipboard")
  expect(written[0]).toContain(`## User\n\n${SHOWN}\n`)
  expect(written[0]).not.toContain("EXPANDED-BODY")
  expect(written[0]).toContain("## User\n\nAdd the parser\n")
})

// Review of fix loop 2: the message menu's "Copy" writes a slash command's prompt as the command that was run, as the
// row it was opened from draws it. A prompt with no command copies its text (the control).
test.each([
  ["a slash command's prompt copies as its command", "/review src", SHOWN],
  ["a plain prompt copies as its text", "Add the parser", "Add the parser"],
])("the message menu's Copy: %s", async (_, filter, copied) => {
  await using state = await tmpdir()
  const written: string[] = []
  await using setup = await rewindApp({
    state: state.path,
    messages: withCommand,
    clipboard: {
      read: async () => undefined,
      write: async (value: string) => {
        written.push(value)
      },
      dispose: async () => {},
    },
  })
  await waitForFrame(setup, (frame) => frame.includes("Renamed it."))
  await setup.mockInput.typeText("/timeline")
  setup.mockInput.pressEnter()
  await waitForFrame(setup, (frame) => frame.includes("Timeline"))
  // A select dialog focuses its search field a moment after it is drawn.
  await Bun.sleep(50)
  await setup.mockInput.typeText(filter)
  await waitForFrame(setup, (frame) => frame.includes(copied))
  setup.mockInput.pressEnter()
  await waitForFrame(setup, (frame) => frame.includes("Message Actions"))
  await Bun.sleep(50)
  await setup.mockInput.typeText("Copy")
  await waitForFrame(setup, (frame) => frame.includes("message text to clipboard"))
  setup.mockInput.pressEnter()
  await until(() => written.length > 0, "the prompt on the clipboard")
  expect(written).toEqual([copied])
})
