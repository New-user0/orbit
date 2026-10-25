import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"
import {
  controlFree,
  hostileCommand,
  linesWith,
  listHeading,
  rewindApp,
  sessionID,
  until,
  withShell,
} from "./fixture/rewind"

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
    await using setup = await rewindApp({ state: state.path, width, messages: withShell("ls -la") })

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
    // A command the person ran with `!` is a row of its own, in its place and behind its `!`.
    expect(frame).toContain("! ls -la")
    expect(frame.indexOf("Rename the helper")).toBeLessThan(frame.indexOf("! ls -la"))
    expect(frame.indexOf("! ls -la")).toBeLessThan(frame.indexOf("(current)"))
    // Each prompt's stats come from its own range, not the turn's; a shell command asks for none.
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
    await using setup = await rewindApp({ state: state.path, width, messages: withShell(hostileCommand) })
    await openPicker(setup)

    // The hostile file name reaches the screen only through the picker's stats line.
    const frame = await setup.waitForFrame((frame) => frame.includes("evil\\x1b[2K"))
    expect(controlFree(frame)).toBe(true)
    expect(frame).toContain("+1 -1")
    // Its stored prompt is written out on its row too, and so is a stored shell command on its own row.
    expect(frame).toContain("Fix the \\x1b]0;pwned\\x07 title")
    expect(frame).toContain("! echo \\x1b]0;pwned\\x07 hi")

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

// A command the person ran with `!` has no checkpoint of its own, so the server's dry run answers `canRewind: false`
// and step 2 offers only the conversation. Rewinding it puts the command back in the input, in shell mode.
test("a shell command is a row whose conversation rewind puts the command back in shell mode", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, messages: withShell("ls -la") })
  await openPicker(setup)

  // Up from "(current)": the newest prompt, then the shell command.
  await selectPrompt(setup, 2)
  const confirm = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(setup.dryRunsSent()).toEqual(["msg_0004a"])
  expect(confirm).toContain("Rewind the conversation to just before this prompt:")
  expect(confirm).toContain("! ls -la")
  expect(confirm).not.toContain("Code only")
  expect(setup.statsSent()).not.toContain("prompt msg_0004a")

  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions().filter((action) => action !== "interrupt" && action !== "wait")).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0004a", files: false })}`,
  ])
  // The transcript draws the command behind `$`; the input draws it behind `!`, with shell mode's own hint.
  const frame = await setup.waitForFrame(
    (frame) => !frame.includes("Never mind") && frame.includes("! ls -la") && frame.includes("exit shell mode"),
    { maxPasses: 200 },
  )
  expect(frame).toContain("$ ls -la")
})

// Running the put-back command again is new work, so the staged revert is committed first, as for a prompt; otherwise
// the command would land after the boundary, be drawn nowhere and be dropped by the next prompt's commit. A refused
// commit sends no command.
test.each([
  { commit: 204, sent: ["commit", "shell"] },
  { commit: 409, sent: ["commit"] },
])(
  "running the command a shell row put back commits the staged revert before the command is sent (commit answers $commit)",
  async (row) => {
    await using state = await tmpdir()
    await using setup = await rewindApp({
      state: state.path,
      messages: withShell("ls -la"),
      answer: (request) => {
        if (request.path === `/api/session/${sessionID}/revert/commit`)
          return row.commit === 204
            ? new Response(null, { status: 204 })
            : json({ _tag: "SessionBusyError", sessionID, message: "Session is busy" }, { status: 409 })
        if (request.path === `/api/session/${sessionID}/shell`) return new Response(null, { status: 204 })
        return undefined
      },
    })
    await openPicker(setup)
    await selectPrompt(setup, 2)
    await setup.waitForFrame((frame) => frame.includes("Conversation only"))
    setup.mockInput.pressEnter()
    await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
    // The server's echo of the staged revert hides the command and everything after it from the transcript.
    setup.events.emit({
      id: "evt_rewind_shell_staged",
      created: Date.now(),
      type: "session.revert.staged",
      durable: { aggregateID: sessionID, seq: 1, version: 1 },
      data: { sessionID, revert: { messageID: "msg_0004a", files: [] } },
    })
    await setup.waitForFrame(
      (frame) => !frame.includes("$ ls -la") && frame.includes("! ls -la") && frame.includes("exit shell mode"),
      { maxPasses: 200 },
    )

    setup.mockInput.pressEnter()
    const answered = (request: { path: string }) =>
      request.path.endsWith("/revert/commit") || request.path.endsWith(`${sessionID}/shell`)
    await until(() => setup.requests.filter(answered).length === row.sent.length, "the commit and shell requests")
    if (row.commit !== 204) await setup.waitForFrame((frame) => frame.includes("Failed to commit revert"))
    await Bun.sleep(100)
    expect(setup.requests.filter(answered).map((request) => request.path.split("/").pop())).toEqual([...row.sent])
    if (row.commit === 204)
      expect(setup.requests.find((request) => request.path.endsWith("/shell"))?.body).toMatchObject({
        command: "ls -la",
      })
  },
)

// The server answers no dry run while the session runs (409), so choosing a prompt stops the session first; the code
// options then reflect the files on disk. The rewind itself interrupts and waits again, in case the session started
// again meanwhile.
test("a busy session is interrupted and waited for before the rewind acts", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, running: true })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  const confirm = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(confirm).toContain("Rewind to just before this prompt:")
  expect(confirm).toContain("Code only")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()

  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.sequence()).toEqual([
    "interrupt",
    "wait",
    "dry run msg_0003",
    "interrupt",
    "wait",
    `stage ${JSON.stringify({ messageID: "msg_0003", files: false })}`,
  ])
})

// While a chosen rewind runs, Esc leaves the picker up with a line saying so, and the server's answer is drawn there:
// a refusal arriving after the person pressed Esc is not dropped.
test("Esc while a rewind runs keeps the picker up, and a late refusal is drawn", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith("/revert/files") && !request.body?.dryRun ? held.promise : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("files")), "the rewind request")
  await setup.waitForFrame((frame) => frame.includes("Rewinding…"))
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  await Bun.sleep(200)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Rewinding…")
  held.resolve(
    json(
      { _tag: "RewindFilesError", sessionID, messageID: "msg_0003", reason: "failed", message: "Not restored." },
      { status: 409 },
    ),
  )
  await setup.waitForFrame((frame) => frame.includes("Could not rewind the code: Not restored."))
})

// A picker closed some other way while its rewind runs (ctrl+c here) leaves alone the dialog opened after it: a late
// success does not clear that dialog, and a late refusal is shown as a toast instead.
test.each([
  { label: "succeeds", response: () => json({ data: { messageID: "msg_0003", files: [] } }), toast: "" },
  {
    label: "is refused",
    response: () => json({ _tag: "SessionBusyError", sessionID, message: "Session is busy" }, { status: 409 }),
    toast: "Could not rewind the code and conversation:",
  },
])("a rewind that $label after its picker closed leaves the next dialog open", async (row) => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith("/revert/stage") ? held.promise : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  await setup.waitForFrame((frame) => frame.includes("Rewinding…"))
  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("Rewinding…"))
  await Bun.sleep(50)
  await setup.mockInput.typeText("/timeline")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Timeline"))
  held.resolve(row.response())
  if (row.toast) await setup.waitForFrame((frame) => frame.includes(row.toast))
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Timeline")
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

// Classes 7 and 13: code options need a dry run that says it can rewind and lists the files as a list. One that cannot
// rewind, or whose list is something else, leaves only the conversation, whatever else it names.
test.each([
  { label: "cannot rewind", answer: { canRewind: false, filesChanged: ["/tmp/orbit/src/a.ts"], insertions: 3 } },
  { label: "names its files in a string", answer: { canRewind: true, filesChanged: "src/a.ts", insertions: 3 } },
])("a dry run that $label offers only the conversation", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) =>
      request.path.endsWith("/revert/files") && request.body?.dryRun ? json({ data: row.answer }) : undefined,
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  const frame = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(frame).toContain("Rewind the conversation to just before this prompt:")
  expect(frame).not.toContain("Code and conversation")
  expect(frame).not.toContain("Code only")
  expect(frame).toContain("The code stays as it is.")
})

// Class 7: a prompt whose own edits come back as something other than a list shows the warning, as a refused one does.
test("a prompt whose own edits come back malformed shows the warning on its row", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) =>
      request.path.endsWith("/diff") && new URLSearchParams(request.search).get("from") === "msg_0003"
        ? json({ data: { file: "src/a.ts", additions: 1, deletions: 0 } })
        : undefined,
  })
  await openPicker(setup)
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("No code rewind for this prompt") && frame.includes("parser.ts +12 -0"),
  )
  expect(linesWith(frame, "No code rewind for this prompt")).toBe(1)
})

// Seven rows are drawn, the window centred on the selection, and a row asks for its stats only once it is drawn: the
// list opens on "(current)" with the six newest prompts, and Home brings the oldest ones in.
test("the list draws seven rows around the selection and asks only drawn rows for their stats", async () => {
  await using state = await tmpdir()
  const now = Date.now()
  const id = (index: number) => `msg_${String(index).padStart(4, "0")}`
  const ids = Array.from({ length: 10 }, (_, index) => id(index * 2 + 1))
  const messages = ids.flatMap((prompt, index) => [
    { id: prompt, type: "user", text: `Prompt number ${index + 1}`, time: { created: now - (20 - index) * 60_000 } },
    {
      id: id(index * 2 + 2),
      type: "assistant",
      agent: "build",
      model: { providerID: "provider", id: "model" },
      time: { created: now - (20 - index) * 60_000 + 1000, completed: now - (20 - index) * 60_000 + 2000 },
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text: index === 9 ? "Renamed it." : `Answer ${index + 1}` }],
    },
  ])
  await using setup = await rewindApp({ state: state.path, messages, height: 50 })
  await openPicker(setup)
  await until(() => setup.statsSent().length >= 6, "the drawn rows' stats")
  await Bun.sleep(200)
  expect(setup.statsSent().sort()).toEqual(ids.slice(4).map((prompt) => `prompt ${prompt}`))

  setup.mockInput.pressKey("HOME")
  await until(() => setup.statsSent().length >= 10, "the oldest rows' stats")
  expect(setup.statsSent().sort()).toEqual(ids.map((prompt) => `prompt ${prompt}`))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(setup.dryRunsSent()).toEqual([ids[0]])
})

// While the dry run runs the list says so; Enter again asks nothing more, and Esc closes the picker, which its late
// answer does not reopen.
test("Enter while the dry run runs asks it once, and Esc then closes the picker for good", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith("/revert/files") && request.body?.dryRun ? held.promise : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Checking files…"))
  setup.mockInput.pressEnter()
  await Bun.sleep(200)
  expect(setup.dryRunsSent()).toEqual(["msg_0003"])

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Checking files…") && !frame.includes(listHeading))
  held.resolve(json({ data: { canRewind: true, filesChanged: ["/tmp/orbit/src/a.ts"], insertions: 3, deletions: 5 } }))
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain("Code and conversation")
  expect(setup.actions()).toEqual([])
})

// Enter again while a rewind is under way sends nothing more.
test("Enter while a rewind runs sends it once", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith("/revert/stage") ? held.promise : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  setup.mockInput.pressEnter()
  await Bun.sleep(300)
  held.resolve(json({ data: { messageID: "msg_0003", files: [] } }))
  await setup.waitForFrame((frame) => !frame.includes("Code and conversation"))
  expect(setup.actions().filter((action) => action.startsWith("stage"))).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0003" })}`,
  ])
})
