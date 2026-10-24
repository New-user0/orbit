import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"
import { controlFree, linesWith, listHeading, rewindApp, sessionID, until } from "./fixture/rewind"

// clients-ux-5 part 2: the three-way rewind picker. Step 1 lists the person's prompts, oldest first, with a "(current)"
// row selected at the bottom; each prompt's second line is its own file-tool edits from `scope=prompt`. Step 2 confirms
// one prompt: code options appear only when a dry run says a rewind would change files now, with the warning that shell
// and outside edits stay. "Code and conversation" stages a revert with its files, "Conversation only" stages one
// without them, and "Code only" rewinds the files at once.

const openPicker = async (setup: Awaited<ReturnType<typeof rewindApp>>) => {
  await setup.waitForFrame((frame) => frame.includes("Renamed it."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  return setup.waitForFrame((frame) => frame.includes(listHeading))
}

// Up from "(current)": the newest prompt, then the one before it.
const selectPrompt = async (setup: Awaited<ReturnType<typeof rewindApp>>, upPresses: number) => {
  for (let index = 0; index < upPresses; index++) setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
}

test.each([64, 120])(
  "/rewind lists every prompt with its own file edits and a current row, at %i columns",
  async (width) => {
    await using state = await tmpdir()
    await using setup = await rewindApp({ state: state.path, width })

    await openPicker(setup)
    const frame = await setup.waitForFrame(
      (frame) => frame.includes("parser.ts +12 -0") && frame.includes("2 files +5 -3"),
      { maxPasses: 200 },
    )

    expect(frame).toContain("Rewind")
    expect(frame).toContain("Add the parser")
    expect(frame).toContain("Rename the helper")
    expect(frame).toContain("(current)")
    // Oldest first, "(current)" last.
    expect(frame.indexOf("Add the parser")).toBeLessThan(frame.indexOf("Rename the helper"))
    expect(frame.indexOf("Rename the helper")).toBeLessThan(frame.indexOf("(current)"))
    // Each prompt's stats come from its own range, not the turn's.
    expect(setup.statsSent().sort()).toEqual(["prompt msg_0001", "prompt msg_0003", "prompt msg_0005"])
    // Opening the list rewinds nothing and runs no dry run.
    expect(setup.actions()).toEqual([])
    expect(setup.dryRunsSent()).toEqual([])
  },
)

test.each([64, 120])(
  "a repository file name and a stored prompt are drawn with their control characters written out, at %i columns",
  async (width) => {
    await using state = await tmpdir()
    await using setup = await rewindApp({ state: state.path, width })
    await openPicker(setup)

    // The hostile file name reaches the screen only through the picker's stats line.
    const frame = await setup.waitForFrame((frame) => frame.includes("evil\\x1b[2K"))
    expect(controlFree(frame)).toBe(true)
    expect(frame).toContain("+1 -1")
    // Its stored prompt is written out on its row too.
    expect(frame).toContain("Fix the \\x1b]0;pwned\\x07 title")

    // And in step 2, where the file is named in the effect line.
    await selectPrompt(setup, 1)
    const confirm = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
    expect(controlFree(confirm)).toBe(true)
    expect(confirm).toContain("evil\\x1b[2K")
  },
)

test("step 2 offers the code options only when a dry run would change files, and Esc goes back to the list", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)

  // "Rename the helper": the dry run would change two files.
  await selectPrompt(setup, 2)
  const both = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(setup.dryRunsSent()).toEqual(["msg_0003"])
  expect(both).toContain("Rewind to just before this prompt:")
  expect(both).toContain("Rename the helper")
  expect(both).toContain("2h ago")
  for (const option of ["Code and conversation", "Conversation only", "Code only", "Never mind"])
    expect(both).toContain(option)
  expect(both).toContain("Files go back: +3 -5 in a.ts and b.ts.")
  expect(both).toContain("The conversation goes back to this point.")
  expect(both).toContain(
    "Only edits made by Orbit's file tools go back; shell commands and edits made outside Orbit stay.",
  )

  setup.mockInput.pressEscape()
  const list = await setup.waitForFrame((frame) => frame.includes(listHeading) && !frame.includes("Code only"))
  expect(list).toContain("(current)")

  // "Add the parser": nothing on disk differs from its checkpoint, so only the conversation can go back.
  await selectPrompt(setup, 3)
  const conversation = await setup.waitForFrame(
    (frame) => frame.includes("Conversation only") && frame.includes("Add the parser"),
  )
  expect(conversation).toContain("Rewind the conversation to just before this prompt:")
  expect(conversation).not.toContain("Code and conversation")
  expect(conversation).not.toContain("Code only")
  expect(conversation).not.toContain("shell commands and edits made outside Orbit")
  expect(conversation).toContain("Never mind")
  expect(setup.actions()).toEqual([])
})

test("choosing the current row or Never mind changes nothing", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)

  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(listHeading))

  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Never mind"))
  for (let index = 0; index < 3; index++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(listHeading))
  expect(setup.actions()).toEqual([])
})

const options = [
  {
    option: "Code and conversation",
    downs: 0,
    action: `stage ${JSON.stringify({ messageID: "msg_0003" })}`,
    refilled: true,
  },
  {
    option: "Conversation only",
    downs: 1,
    action: `stage ${JSON.stringify({ messageID: "msg_0003", files: false })}`,
    refilled: true,
  },
  { option: "Code only", downs: 2, action: `files ${JSON.stringify({ messageID: "msg_0003" })}`, refilled: false },
]

test.each(options)("$option acts through its route and closes the picker", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  for (let index = 0; index < row.downs; index++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()

  await until(() => setup.actions().some((action) => /^(stage|files) /.test(action)), "the rewind request")
  // The one action the option names; any interrupt and wait come first.
  expect(setup.actions().filter((action) => action !== "interrupt" && action !== "wait")).toEqual([row.action])
  // The transcript shows the prompt once (the fake server sends no revert event, so it stays); a conversation rewind
  // also puts the prompt back in the input, a code-only rewind leaves the input empty.
  const frame = await setup.waitForFrame(
    (frame) =>
      !frame.includes("Never mind") &&
      !frame.includes(listHeading) &&
      linesWith(frame, "Rename the helper") === (row.refilled ? 2 : 1),
    { maxPasses: 200 },
  )
  expect(linesWith(frame, "Rename the helper")).toBe(row.refilled ? 2 : 1)
})

test("a busy session is interrupted and waited for before the rewind acts", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, running: true })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()

  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions()).toEqual([
    "interrupt",
    "wait",
    `stage ${JSON.stringify({ messageID: "msg_0003", files: false })}`,
  ])
})

// Classes 1, 7 and 13: what the server answers is what the picker shows. A dry run that is refused (the folder's trust
// ended: 403), that an older server does not know (404) or that fails (500) costs only the code options; the
// conversation can still go back. A real rewind the server refuses after the dry run allowed it (class 3: the server
// decides again when it acts) keeps the picker open with an error line naming the half that failed.
test.each([
  {
    label: "an untrusted folder",
    response: () =>
      json(
        { _tag: "UntrustedFolderError", directory: "/tmp/orbit", message: "The folder is not trusted" },
        { status: 403 },
      ),
  },
  { label: "an older server", response: () => new Response("Not Found", { status: 404 }) },
  { label: "a failure", response: () => json({ _tag: "UnknownError", message: "boom" }, { status: 500 }) },
])("a dry run refused by $label offers only the conversation", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith("/revert/files") && request.body?.dryRun ? row.response() : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  const frame = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(frame).not.toContain("Code and conversation")
  expect(frame).not.toContain("Code only")
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions().filter((action) => action.startsWith("stage") || action.startsWith("files"))).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0003", files: false })}`,
  ])
})

test.each([
  {
    option: "Code only",
    downs: 2,
    route: "/revert/files",
    response: () =>
      json(
        {
          _tag: "RewindFilesError",
          sessionID,
          messageID: "msg_0003",
          reason: "failed",
          message: "The files could not be restored. The server log has the details.",
        },
        { status: 409 },
      ),
    line: "Could not rewind the code: The files could not be restored. The server log has the details.",
  },
  {
    option: "Conversation only",
    downs: 1,
    route: "/revert/stage",
    response: () => json({ _tag: "SessionBusyError", sessionID, message: "Session is busy" }, { status: 409 }),
    line: "Could not rewind the conversation:",
  },
  {
    option: "Code and conversation",
    downs: 0,
    route: "/revert/stage",
    response: () =>
      json(
        { _tag: "UntrustedFolderError", directory: "/tmp/orbit", message: "The folder is not trusted" },
        { status: 403 },
      ),
    line: "Could not rewind the code and conversation:",
  },
])("a refused $option keeps the picker open with an error line naming what failed", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith(row.route) && !request.body?.dryRun ? row.response() : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  for (let index = 0; index < row.downs; index++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes(row.line))
  expect(frame).toContain("Rewind")
  expect(controlFree(frame)).toBe(true)
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes(row.line))
})

test("a session with no prompts says there is nothing to rewind", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, messages: [] })
  await setup.waitForFrame((frame) => frame.includes("Rewind fixture"))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("Nothing to rewind yet."))
  expect(frame).not.toContain(listHeading)
  expect(setup.actions()).toEqual([])
})

// Class 7: a prompt whose own edits cannot be read (a range across a folder switch answers 400) shows the warning on
// its row, and the other rows keep their stats.
test("a prompt whose own edits cannot be read shows the warning on its row only", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) =>
      request.path.endsWith("/diff") && new URLSearchParams(request.search).get("from") === "msg_0003"
        ? json({ _tag: "BadRequest", message: "The range crosses a folder switch" }, { status: 400 })
        : undefined,
  })
  await openPicker(setup)
  const frame = await setup.waitForFrame(
    (frame) =>
      frame.includes("No code rewind for this prompt") &&
      frame.includes("parser.ts +12 -0") &&
      frame.includes("evil\\x1b[2K"),
  )
  expect(linesWith(frame, "No code rewind for this prompt")).toBe(1)
  expect(frame).not.toContain("2 files +5 -3")
  expect(frame.indexOf("parser.ts +12 -0")).toBeLessThan(frame.indexOf("No code rewind for this prompt"))
  expect(frame.indexOf("No code rewind for this prompt")).toBeLessThan(frame.indexOf("evil\\x1b[2K"))
  expect(setup.actions()).toEqual([])
})

// Home and End jump to the oldest prompt and to "(current)", as the list's top and bottom keys.
test("Home selects the oldest prompt and End the current row", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  setup.mockInput.pressKey("HOME")
  setup.mockInput.pressEnter()
  const confirm = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(confirm).toContain("Rewind the conversation to just before this prompt:")
  expect(setup.dryRunsSent()).toEqual(["msg_0001"])

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes(listHeading))
  setup.mockInput.pressKey("END")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(listHeading))
  expect(setup.dryRunsSent()).toEqual(["msg_0001"])
  expect(setup.actions()).toEqual([])
})

// Class 9: the server's message reaches the error line written out, whatever it holds.
test("a refused rewind's message is drawn with its control characters written out", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) =>
      request.path.endsWith("/revert/stage")
        ? json({ _tag: "UnknownError", message: "boom \u001b]0;pwned\u0007 \u001b[2K" }, { status: 500 })
        : undefined,
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("Could not rewind the code and conversation:"))
  expect(frame).toContain("boom \\x1b]0;pwned\\x07 \\x1b[2K")
  expect(controlFree(frame)).toBe(true)
})
