import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"
import {
  controlFree,
  conversation,
  hostileCommand,
  linesWith,
  listHeading,
  promptStats,
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

// Step 2's option lines that draw the focus pointer.
const pointed = (frame: string) =>
  frame
    .split("\n")
    .filter((line) => /\d\. (Code and conversation|Conversation only|Code only|Never mind)/.test(line))
    .filter((line) => line.includes("›"))

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

// A prompt queued while the session ran outlives the rewind, as the reference's queue does. Steering it afterwards is
// new work: the server commits the staged revert before it delivers the prompt (core session-owned.test.ts pins that),
// and the transcript keeps the prompt through the commit's echo and draws it in the rewound conversation.
test("a prompt queued before a conversation rewind is drawn in the rewound conversation once it is steered", async () => {
  await using state = await tmpdir()
  const queued = {
    id: "msg_queued",
    sessionID,
    type: "user",
    delivery: "queue",
    payload: { text: "Queued before the rewind" },
    time: { created: Date.now() },
  }
  await using setup = await rewindApp({
    state: state.path,
    running: true,
    answer: (request) => {
      if (request.path === `/api/session/${sessionID}/inbox`) return json({ data: [queued] })
      if (request.path === `/api/session/${sessionID}/inbox/${queued.id}`) return json({ data: queued })
      return undefined
    },
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  setup.events.emit({
    id: "evt_rewind_queued_staged",
    created: Date.now(),
    type: "session.revert.staged",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, revert: { messageID: "msg_0003", files: [] } },
  })
  await setup.waitForFrame((frame) => !frame.includes("Renamed it.") && frame.includes("1 queued"), { maxPasses: 200 })

  // The rewound prompt is back in the input; cleared, Enter on the empty prompt steers the queued one.
  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.waitForFrame((frame) => !frame.includes("Rename the helper"))
  setup.mockInput.pressEnter()
  await until(() => setup.requests.some((request) => request.path.endsWith(`/inbox/${queued.id}`)), "the steer request")
  expect(setup.requests.find((request) => request.path.endsWith(`/inbox/${queued.id}`))?.body).toMatchObject({
    delivery: "steer",
  })
  // What the server sends when it delivers the steered prompt over the staged revert.
  setup.events.emit({
    id: "evt_rewind_queued_committed",
    created: Date.now(),
    type: "session.revert.committed",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID, to: "msg_0003" },
  })
  setup.events.emit({
    id: "evt_rewind_queued_delivered",
    created: Date.now(),
    type: "session.inbox.delivered",
    durable: { aggregateID: sessionID, seq: 3, version: 1 },
    data: { sessionID, inboxID: queued.id },
  })
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("Queued before the rewind") && !frame.includes("1 queued"),
    { maxPasses: 200 },
  )
  expect(frame).toContain("Added the parser.")
  expect(frame).not.toContain("Renamed it.")
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

// Enter or a digit again while a rewind is under way sends nothing more, and the digit does not move the focus off the
// option that runs.
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
  setup.mockInput.pressKey("3")
  await Bun.sleep(300)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("1. Code and conversation ✓")
  expect(pointed(frame)).toEqual([])
  expect(setup.actions().filter((action) => action.startsWith("files"))).toEqual([])
  held.resolve(json({ data: { messageID: "msg_0003", files: [] } }))
  await setup.waitForFrame((frame) => !frame.includes("Code and conversation"))
  expect(setup.actions().filter((action) => action.startsWith("stage"))).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0003" })}`,
  ])
})

// The list's keys follow the reference's message selector and Orbit's own pickers. Each key is pressed from a known row,
// then Enter, and the dry run names the row it landed on. The arrows are the control; ctrl+p and ctrl+n are the shared,
// rebindable dialog keys; j and k are the reference's; its top chords reach the oldest prompt and its bottom chords
// "(current)", where Enter closes the picker without asking anything.
type Setup = Awaited<ReturnType<typeof rewindApp>>
const press = {
  up: (setup: Setup) => setup.mockInput.pressArrow("up"),
  down: (setup: Setup) => setup.mockInput.pressArrow("down"),
  "ctrl+p": (setup: Setup) => setup.mockInput.pressKey("p", { ctrl: true }),
  "ctrl+n": (setup: Setup) => setup.mockInput.pressKey("n", { ctrl: true }),
  k: (setup: Setup) => setup.mockInput.pressKey("k"),
  j: (setup: Setup) => setup.mockInput.pressKey("j"),
  "ctrl+up": (setup: Setup) => setup.mockInput.pressArrow("up", { ctrl: true }),
  "shift+up": (setup: Setup) => setup.mockInput.pressArrow("up", { shift: true }),
  "meta+up": (setup: Setup) => setup.mockInput.pressArrow("up", { meta: true }),
  "shift+k": (setup: Setup) => setup.mockInput.pressKey("k", { shift: true }),
  "ctrl+down": (setup: Setup) => setup.mockInput.pressArrow("down", { ctrl: true }),
  "shift+down": (setup: Setup) => setup.mockInput.pressArrow("down", { shift: true }),
  "meta+down": (setup: Setup) => setup.mockInput.pressArrow("down", { meta: true }),
  "shift+j": (setup: Setup) => setup.mockInput.pressKey("j", { shift: true }),
}
test.each([
  { key: "up", ups: 0, lands: ["msg_0005"] },
  { key: "ctrl+p", ups: 0, lands: ["msg_0005"] },
  { key: "k", ups: 0, lands: ["msg_0005"] },
  { key: "down", ups: 2, lands: ["msg_0005"] },
  { key: "ctrl+n", ups: 2, lands: ["msg_0005"] },
  { key: "j", ups: 2, lands: ["msg_0005"] },
  { key: "ctrl+up", ups: 0, lands: ["msg_0001"] },
  { key: "shift+up", ups: 0, lands: ["msg_0001"] },
  { key: "meta+up", ups: 0, lands: ["msg_0001"] },
  { key: "shift+k", ups: 0, lands: ["msg_0001"] },
  { key: "ctrl+down", ups: 2, lands: [] },
  { key: "shift+down", ups: 2, lands: [] },
  { key: "meta+down", ups: 2, lands: [] },
  { key: "shift+j", ups: 2, lands: [] },
] as const)("in the list, $key moves the selection as the reference's selector does", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  for (let index = 0; index < row.ups; index++) setup.mockInput.pressArrow("up")
  press[row.key](setup)
  setup.mockInput.pressEnter()
  if (row.lands.length) await setup.waitForFrame((frame) => frame.includes("Never mind"))
  if (!row.lands.length) await setup.waitForFrame((frame) => !frame.includes(listHeading))
  expect(setup.dryRunsSent()).toEqual([...row.lands])
  expect(setup.actions()).toEqual([])
})

// Step 2 draws its options numbered, as the reference's select does. Ctrl+n and j move as arrow down does (the
// control), ctrl+p and k as arrow up, and a digit chooses the option with that number at once. The list's top chords
// do not move the options, as the reference's select has none.
const stageBoth = `stage ${JSON.stringify({ messageID: "msg_0003" })}`
const stageConversation = `stage ${JSON.stringify({ messageID: "msg_0003", files: false })}`
test.each([
  { keys: ["down"], digit: "", action: stageConversation },
  { keys: ["ctrl+n"], digit: "", action: stageConversation },
  { keys: ["j", "j", "k"], digit: "", action: stageConversation },
  { keys: ["down", "ctrl+p"], digit: "", action: stageBoth },
  { keys: ["down", "shift+down", "meta+down", "ctrl+down", "shift+j"], digit: "", action: stageConversation },
  { keys: [], digit: "3", action: `files ${JSON.stringify({ messageID: "msg_0003" })}` },
  { keys: [], digit: "2", action: stageConversation },
] as const)("in step 2, keys $keys then digit '$digit' choose through the options' keys", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  const confirm = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  for (const [index, label] of ["Code and conversation", "Conversation only", "Code only", "Never mind"].entries())
    expect(confirm).toContain(`${index + 1}. ${label}`)
  for (const key of row.keys) press[key](setup)
  if (row.digit) setup.mockInput.pressKey(row.digit)
  if (!row.digit) setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => /^(stage|files) /.test(action)), "the rewind request")
  expect(setup.actions().filter((action) => action !== "interrupt" && action !== "wait")).toEqual([row.action])
})

// A digit chooses Never mind as Enter does; a digit with no option, or one pressed in the list, does nothing.
test("a digit for Never mind goes back to the list, and a digit with no option or in the list does nothing", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressKey("1")
  await Bun.sleep(150)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain(listHeading)
  expect(setup.dryRunsSent()).toEqual([])
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("2. Never mind"))
  setup.mockInput.pressKey("3")
  await Bun.sleep(150)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("2. Never mind")
  setup.mockInput.pressKey("2")
  await setup.waitForFrame((frame) => frame.includes(listHeading))
  expect(setup.actions()).toEqual([])
})

// The picker's moves are the shared dialog keys, so a person who rebinds them moves the picker with their own key, and
// the default it replaced no longer moves it. Arrow up is the control, still bound alongside.
test("a person's own keys for the dialog moves reach the picker", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    keybinds: { "dialog.select.prev": "up,f6", "dialog.select.next": "down,f7" },
  })
  await openPicker(setup)
  setup.mockInput.pressKey("p", { ctrl: true })
  setup.mockInput.pressKey("F6")
  setup.mockInput.pressKey("F6")
  setup.mockInput.pressKey("F7")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Never mind"))
  expect(setup.dryRunsSent()).toEqual(["msg_0005"])
})

// Once a rewind is refused, the picker shows only its error line: a digit there chooses nothing.
test("a digit on the error line sends nothing", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) =>
      request.path.endsWith("/revert/stage")
        ? json({ _tag: "SessionBusyError", sessionID, message: "Session is busy" }, { status: 409 })
        : undefined,
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressKey("1")
  await setup.waitForFrame((frame) => frame.includes("Could not rewind the code and conversation:"))
  setup.mockInput.pressKey("3")
  setup.mockInput.pressKey("1")
  await Bun.sleep(300)
  expect(setup.actions().filter((action) => action !== "interrupt" && action !== "wait")).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0003" })}`,
  ])
})

// The picker's keys in every step and state, as the reference's list and its confirm step's select behave (addendum
// ref-specs/clients-ux-5-p2-picker.md). Page keys go in as their terminal sequences.
const pageUp = (setup: Setup) => setup.mockInput.pressKey("\x1b[5~")
const pageDown = (setup: Setup) => setup.mockInput.pressKey("\x1b[6~")
const stageOldest = `stage ${JSON.stringify({ messageID: "msg_0001", files: false })}`

// The rewinds sent, without the interrupt and wait that come before each.
const rewinds = (setup: Setup) => setup.actions().filter((action) => action !== "interrupt" && action !== "wait")

// Draws a frame once keys that should change nothing have had time to act.
const settled = async (setup: Setup) => {
  await Bun.sleep(150)
  await setup.renderOnce()
  return setup.captureCharFrame()
}

// Step 2's previous and next wrap at both ends: up on the first option reaches Never mind, down on the last reaches the
// first again. Enter then acts on the option reached. `ups` picks the prompt: 2 has four options, 3 has two.
test.each([
  { key: "up", ups: 2, presses: 1, lands: "› 4. Never mind", action: undefined },
  { key: "k", ups: 2, presses: 1, lands: "› 4. Never mind", action: undefined },
  { key: "ctrl+p", ups: 2, presses: 1, lands: "› 4. Never mind", action: undefined },
  { key: "down", ups: 2, presses: 4, lands: "› 1. Code and conversation", action: stageBoth },
  { key: "j", ups: 2, presses: 4, lands: "› 1. Code and conversation", action: stageBoth },
  { key: "ctrl+n", ups: 2, presses: 4, lands: "› 1. Code and conversation", action: stageBoth },
  { key: "down", ups: 3, presses: 2, lands: "› 1. Conversation only", action: stageOldest },
] as const)("in step 2, $key pressed $presses times from the first of $ups-up's options wraps", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await selectPrompt(setup, row.ups)
  await setup.waitForFrame((frame) => frame.includes("Never mind"))
  // One press at a time, each drawn, so the last press starts from the last option.
  for (let index = 0; index < row.presses; index++) {
    press[row.key](setup)
    await settled(setup)
  }
  await setup.waitForFrame((frame) => frame.includes(row.lands))
  setup.mockInput.pressEnter()
  if (!row.action) {
    await setup.waitForFrame((frame) => frame.includes(listHeading))
    expect(setup.actions()).toEqual([])
    return
  }
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(rewinds(setup)).toEqual([row.action])
})

// Control: the list clamps at both ends, as the reference's list does; step 2's wrap stays in step 2.
test("in the list, up on the oldest prompt and down on (current) stay put", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  for (let index = 0; index < 4; index++) setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(setup.dryRunsSent()).toEqual(["msg_0001"])

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes(listHeading))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes(listHeading))
  await openPicker(setup)
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(listHeading))
  expect(setup.dryRunsSent()).toEqual(["msg_0001"])
  expect(setup.actions()).toEqual([])
})

test("in step 2, page down lands on Never mind and page up on the first option, without wrapping", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("› 1. Code and conversation"))
  pageDown(setup)
  await setup.waitForFrame((frame) => frame.includes("› 4. Never mind"))
  pageDown(setup)
  expect(await settled(setup)).toContain("› 4. Never mind")
  pageUp(setup)
  await setup.waitForFrame((frame) => frame.includes("› 1. Code and conversation"))
  pageUp(setup)
  expect(await settled(setup)).toContain("› 1. Code and conversation")
  setup.mockInput.pressEnter()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(rewinds(setup)).toEqual([stageBoth])
})

// The page keys are the shared dialog ids, so a person's own key reaches step 2. (The default it replaced is then the
// session's own page key, which scrolls the transcript and closes any dialog, as in every Orbit dialog.)
test("a person's own page keys move step 2", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, keybinds: { "dialog.select.page_down": "f8" } })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("› 1. Code and conversation"))
  setup.mockInput.pressKey("F8")
  await setup.waitForFrame((frame) => frame.includes("› 4. Never mind"))
  pageUp(setup)
  await setup.waitForFrame((frame) => frame.includes("› 1. Code and conversation"))
})

// The reference's list has no page keys, so they do nothing there: the picker takes them, and the session's own page
// keys (which close any dialog) do not get them.
test("in the list, page keys do nothing", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  pageUp(setup)
  pageDown(setup)
  expect(await settled(setup)).toContain(listHeading)
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(listHeading))
  expect(setup.dryRunsSent()).toEqual([])
  expect(setup.actions()).toEqual([])
})

// While a chosen rewind runs, step 2's keys are off: no key moves the focus, no option is pointed at, and the effect
// lines keep describing the option chosen. The refusal then names that option. "Conversation only" is chosen, the second
// of four options, so that every key here, the first-option and last-option ones too, would move the focus elsewhere.
const moves = {
  ...press,
  HOME: (setup: Setup) => setup.mockInput.pressKey("HOME"),
  END: (setup: Setup) => setup.mockInput.pressKey("END"),
  "page up": pageUp,
  "page down": pageDown,
}
test.each(["down", "up", "j", "k", "ctrl+n", "ctrl+p", "HOME", "END", "page up", "page down"] as const)(
  "while a rewind runs, %s moves no option and no option is pointed at",
  async (key) => {
    await using state = await tmpdir()
    const held = Promise.withResolvers<Response>()
    await using setup = await rewindApp({
      state: state.path,
      answer: (request) => (request.path.endsWith("/revert/stage") ? held.promise : undefined),
    })
    await openPicker(setup)
    await selectPrompt(setup, 2)
    await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
    setup.mockInput.pressArrow("down")
    await setup.waitForFrame((frame) => frame.includes("› 2. Conversation only"))
    setup.mockInput.pressEnter()
    await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
    await setup.waitForFrame((frame) => frame.includes("Rewinding…"))
    moves[key](setup)
    const frame = await settled(setup)
    expect(pointed(frame)).toEqual([])
    expect(frame).toContain("2. Conversation only ✓")
    expect(frame).toContain("The conversation goes back to this point.")
    expect(frame).toContain("The code stays as it is.")
    held.resolve(json({ _tag: "SessionBusyError", sessionID, message: "Session is busy" }, { status: 409 }))
    await setup.waitForFrame((frame) => frame.includes("Could not rewind the conversation:"))
    expect(rewinds(setup)).toEqual([stageConversation])
  },
)

test.each([64, 120])("Enter marks the chosen option while it runs, at %i columns", async (width) => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    width,
    answer: (request) => (request.path.endsWith("/revert/stage") ? held.promise : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes("Rewinding…"))
  expect(frame).toContain("1. Code and conversation ✓")
  expect(pointed(frame)).toEqual([])
  held.resolve(json({ data: { messageID: "msg_0003", files: [] } }))
  await setup.waitForFrame((frame) => !frame.includes("Rewinding…"))
})

// A digit acts on its option at once but leaves the focus, and so the effect lines, where they were, and marks nothing.
test("a digit chooses its option without moving the focus", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith("/revert/files") && !request.body?.dryRun ? held.promise : undefined),
  })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("› 1. Code and conversation"))
  setup.mockInput.pressKey("3")
  await until(() => setup.actions().some((action) => action.startsWith("files")), "the files request")
  const frame = await setup.waitForFrame((frame) => frame.includes("Rewinding…"))
  expect(frame).toContain("The conversation goes back to this point.")
  expect(frame).not.toContain("✓")
  expect(pointed(frame)).toEqual([])
  held.resolve(json({ data: { canRewind: true } }))
  await setup.waitForFrame((frame) => !frame.includes("Rewinding…"))
})

test("a full-width digit chooses as its digit does", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  // In the list it does nothing.
  setup.mockInput.pressKey("１")
  expect(await settled(setup)).toContain(listHeading)
  expect(setup.dryRunsSent()).toEqual([])
  await selectPrompt(setup, 2)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressKey("２")
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(rewinds(setup)).toEqual([stageConversation])
})

// `n` is the reference's other close key: it closes the list (also while it checks files), the empty picker and the
// error line, and does nothing in step 2.
test.each(["the list", "the list while it checks files", "the empty picker", "the error line", "step 2"] as const)(
  "n on %s",
  async (place) => {
    await using state = await tmpdir()
    const held = Promise.withResolvers<Response>()
    await using setup = await rewindApp({
      state: state.path,
      messages: place === "the empty picker" ? [] : undefined,
      answer: (request) => {
        if (place === "the list while it checks files" && request.path.endsWith("/revert/files")) return held.promise
        if (place === "the error line" && request.path.endsWith("/revert/stage"))
          return json({ _tag: "SessionBusyError", sessionID, message: "Session is busy" }, { status: 409 })
        return undefined
      },
    })
    if (place === "the empty picker") {
      await setup.waitForFrame((frame) => frame.includes("Rewind fixture"))
      await setup.mockInput.typeText("/rewind")
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("Nothing to rewind yet."))
    }
    if (place !== "the empty picker") await openPicker(setup)
    if (place === "the list while it checks files") {
      await selectPrompt(setup, 2)
      await setup.waitForFrame((frame) => frame.includes("Checking files…"))
    }
    if (place === "the error line" || place === "step 2") {
      await selectPrompt(setup, 2)
      await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
    }
    if (place === "the error line") {
      setup.mockInput.pressEnter()
      await setup.waitForFrame((frame) => frame.includes("Could not rewind the code and conversation:"))
    }
    const before = setup.actions()
    setup.mockInput.pressKey("n")
    if (place === "step 2") {
      expect(await settled(setup)).toContain("Code and conversation")
      expect(setup.actions()).toEqual([])
      return
    }
    await setup.waitForFrame(
      (frame) =>
        !frame.includes(listHeading) &&
        !frame.includes("Nothing to rewind yet.") &&
        !frame.includes("Could not rewind") &&
        !frame.includes("Checking files…"),
    )
    // A dry run that answers after the picker closed opens nothing.
    held.resolve(json({ data: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } }))
    expect(await settled(setup)).not.toContain("Never mind")
    expect(setup.actions()).toEqual(before)
  },
)

test("Enter in a picker with nothing to rewind keeps it open", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, messages: [] })
  await setup.waitForFrame((frame) => frame.includes("Rewind fixture"))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Nothing to rewind yet."))
  setup.mockInput.pressEnter()
  expect(await settled(setup)).toContain("Nothing to rewind yet.")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Nothing to rewind yet."))
})

// The index of the first line at or below the list heading that holds `text`.
const rowLine = (frame: string, text: string) => {
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes(listHeading))
  return lines.findIndex((line, index) => index > start && line.includes(text))
}

// Every row is three lines: its prompt, its stats line (kept empty until the stats answer) and a blank line, so the
// window does not move when the stats arrive.
test.each([64, 120])("every row keeps three lines while its stats load and after, at %i columns", async (width) => {
  await using state = await tmpdir()
  const gate = Promise.withResolvers<void>()
  await using setup = await rewindApp({
    state: state.path,
    width,
    answer: (request) => {
      const query = new URLSearchParams(request.search)
      if (!request.path.endsWith("/diff") || query.get("scope") !== "prompt") return undefined
      return gate.promise.then(() => json({ data: promptStats[query.get("from") ?? ""] }))
    },
  })
  const spacing = (frame: string) => {
    const rows = ["Add the parser", "Rename the helper", "Fix the", "(current)"].map((text) => rowLine(frame, text))
    return rows.slice(1).map((row, index) => row - rows[index])
  }
  await openPicker(setup)
  await until(() => setup.statsSent().length === 3, "the rows' stats requests")
  expect(spacing(await settled(setup))).toEqual([3, 3, 3])
  gate.resolve()
  const loaded = await setup.waitForFrame((frame) => frame.includes("parser.ts +12 -0") && frame.includes("+1 -1"))
  expect(spacing(loaded)).toEqual([3, 3, 3])
  expect(loaded.split("\n")[rowLine(loaded, "Add the parser") + 1]).toContain("parser.ts +12 -0")
})

// Step 2 quotes up to the prompt's first four lines, each on its own line, as the reference does.
test.each([64, 120])("step 2 quotes up to four lines of a long prompt, at %i columns", async (width) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    width,
    messages: [
      { ...conversation[0], text: "first line\nsecond line\nthird line\nfourth line\nfifth line" },
      ...conversation.slice(1),
    ],
  })
  await openPicker(setup)
  await selectPrompt(setup, 3)
  const frame = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  const lines = frame.split("\n")
  const block = lines.slice(
    lines.findIndex((line) => line.includes("Rewind the conversation to just before this prompt:")),
    lines.findIndex((line) => line.includes("Never mind")),
  )
  for (const text of ["first line", "second line", "third line", "fourth line"])
    expect(block.filter((line) => line.includes(text))).toHaveLength(1)
  expect(block.findIndex((line) => line.includes("fourth line"))).toBe(
    block.findIndex((line) => line.includes("first line")) + 3,
  )
  expect(block.join("\n")).not.toContain("fifth line")
})

// The quote stops at the prompt's 500th character, counted by code point, so an emoji there is drawn whole (half of it
// would be a lone surrogate, a class 9 control-category character) and what follows is not drawn.
test("step 2 quotes up to 500 characters of a long prompt and never half an emoji", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    messages: [{ ...conversation[0], text: `${"a".repeat(499)}😀${"b".repeat(40)}` }, ...conversation.slice(1)],
  })
  await openPicker(setup)
  await selectPrompt(setup, 3)
  const frame = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  const lines = frame.split("\n")
  const block = lines
    .slice(
      lines.findIndex((line) => line.includes("Rewind the conversation to just before this prompt:")),
      lines.findIndex((line) => line.includes("Never mind")),
    )
    .join("\n")
  expect(block).toContain("😀")
  expect(block).not.toContain("bb")
  expect(controlFree(block)).toBe(true)
})

// The conversation changing while the picker is open (addendum ref-specs/clients-ux-5-p2-picker.md, sections 4 to 6).
// The list follows the live conversation with one "(current)" row, always last. The selection is a position, as in the
// reference: a prompt that arrives while "(current)" is selected takes the pointer, and what is drawn at the pointer is
// what Enter acts on. Each event is what the server sends; `live` numbers them after the fixture's own.
let liveSeq = 100
const live = (setup: Setup, type: string, data: Record<string, unknown>) =>
  setup.events.emit({
    id: `evt_rewind_live_${liveSeq}`,
    created: Date.now(),
    type,
    durable: { aggregateID: sessionID, seq: liveSeq++, version: 1 },
    data: { sessionID, ...data },
  } as never)
// A person's prompt admitted and then delivered.
const arrive = (setup: Setup, inboxID: string, text: string) => {
  live(setup, "session.inbox.enqueued", { inboxID, item: { type: "user", payload: { text }, delivery: "steer" } })
  live(setup, "session.inbox.delivered", { inboxID })
}

// The list's own lines, from its heading to its key hints, so the transcript behind the picker does not count.
const listLines = (frame: string) => {
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes(listHeading))
  const end = lines.findIndex((line, index) => index > start && line.includes("enter continue"))
  return start === -1 || end === -1 ? [] : lines.slice(start + 1, end)
}
const listHas = (frame: string, text: string) => listLines(frame).filter((line) => line.includes(text)).length
const pointerLines = (frame: string) => listLines(frame).filter((line) => line.includes("› "))
// Where each text is drawn in the list, top to bottom.
const rowOrder = (frame: string, texts: string[]) =>
  texts.map((text) => listLines(frame).findIndex((line) => line.includes(text)))
const inOrder = (order: number[]) =>
  order.every((line, index) => line !== -1 && (index === 0 || line > order[index - 1]))

test.each([64, 120])(
  "a prompt that arrives while the list is open is one new row, and the pointer stays at its position, at %i columns",
  async (width) => {
    await using state = await tmpdir()
    await using setup = await rewindApp({ state: state.path, width })
    await openPicker(setup)
    await setup.waitForFrame((frame) => pointerLines(frame).some((line) => line.includes("(current)")))
    arrive(setup, "msg_0007", "Arrived later")

    const frame = await setup.waitForFrame((frame) => listHas(frame, "Arrived later") === 1, { maxPasses: 200 })
    expect(listHas(frame, "(current)")).toBe(1)
    expect(pointerLines(frame)).toHaveLength(1)
    expect(pointerLines(frame)[0]).toContain("Arrived later")
    expect(inOrder(rowOrder(frame, ["Rename the helper", "Fix the", "Arrived later", "(current)"]))).toBe(true)

    setup.mockInput.pressEnter()
    const confirm = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
    expect(setup.dryRunsSent()).toEqual(["msg_0007"])
    expect(confirm).toContain("Arrived later")
    expect(setup.actions()).toEqual([])
  },
)

test("a prompt that arrives while an older prompt is selected leaves the pointer on it", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressArrow("up")
  await setup.waitForFrame((frame) => pointerLines(frame).some((line) => line.includes("Rename the helper")))
  arrive(setup, "msg_0007", "Arrived later")

  const frame = await setup.waitForFrame((frame) => listHas(frame, "Arrived later") === 1, { maxPasses: 200 })
  expect(listHas(frame, "(current)")).toBe(1)
  expect(pointerLines(frame)).toHaveLength(1)
  expect(pointerLines(frame)[0]).toContain("Rename the helper")
  expect(inOrder(rowOrder(frame, ["Rename the helper", "Fix the", "Arrived later", "(current)"]))).toBe(true)
  // The prompt before it now ends at the new one, so its file line is asked again; the older ones are not.
  await until(() => askedFor(setup, "msg_0005") === 2, "the newest old prompt's second ask")
  expect(askedFor(setup, "msg_0003")).toBe(1)

  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(setup.dryRunsSent()).toEqual(["msg_0003"])
})

test("a shell command that arrives while the list is open is one new row", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await setup.waitForFrame((frame) => pointerLines(frame).some((line) => line.includes("(current)")))
  live(setup, "session.shell.started", {
    shell: {
      id: "sh_live",
      status: "running",
      command: "make build",
      cwd: "/tmp/orbit",
      shell: "bash",
      file: "/tmp/orbit/sh_live.log",
      metadata: {},
      time: { started: Date.now() },
    },
  })

  const frame = await setup.waitForFrame((frame) => listHas(frame, "! make build") === 1, { maxPasses: 200 })
  expect(listHas(frame, "(current)")).toBe(1)
  expect(pointerLines(frame)).toHaveLength(1)
  expect(pointerLines(frame)[0]).toContain("! make build")
  expect(inOrder(rowOrder(frame, ["Fix the", "! make build", "(current)"]))).toBe(true)
})

// Another client stages a revert at the middle prompt: its rows leave the list, and the position (3, the old
// "(current)") is past the end, where no row is pointed and Enter does nothing.
const stagedElsewhere = async (setup: Setup) => {
  await openPicker(setup)
  live(setup, "session.revert.staged", { revert: { messageID: "msg_0003", files: [] } })
  return setup.waitForFrame((frame) => listHas(frame, "Add the parser") === 1 && !listHas(frame, "Rename the helper"), {
    maxPasses: 200,
  })
}

test("a revert another client stages while the list is open removes the rows behind it", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  const frame = await stagedElsewhere(setup)
  expect(listHas(frame, "Fix the")).toBe(0)
  expect(listHas(frame, "(current)")).toBe(1)
  const order = rowOrder(frame, ["Add the parser", "(current)"])
  expect(order[1] - order[0]).toBe(3)
  expect(pointerLines(frame)).toEqual([])

  setup.mockInput.pressEnter()
  expect(await settled(setup)).toContain(listHeading)
  expect(setup.dryRunsSent()).toEqual([])
  expect(setup.actions()).toEqual([])

  setup.mockInput.pressArrow("down")
  const down = await setup.waitForFrame((frame) => pointerLines(frame).length === 1)
  expect(pointerLines(down)[0]).toContain("(current)")
})

test("up from past the end steps back one position at a time", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await stagedElsewhere(setup)
  setup.mockInput.pressArrow("up")
  expect(pointerLines(await settled(setup))).toEqual([])
  setup.mockInput.pressArrow("up")
  expect(pointerLines(await settled(setup))[0]).toContain("(current)")
  setup.mockInput.pressArrow("up")
  expect(pointerLines(await settled(setup))[0]).toContain("Add the parser")
})

test("a revert another client clears while the list is open brings its rows back", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, revert: "msg_0003" })
  await setup.waitForFrame((frame) => frame.includes("Added the parser."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => pointerLines(frame).some((line) => line.includes("(current)")))
  live(setup, "session.revert.cleared", {})

  const frame = await setup.waitForFrame((frame) => listHas(frame, "Rename the helper") === 1, { maxPasses: 200 })
  expect(listHas(frame, "(current)")).toBe(1)
  expect(inOrder(rowOrder(frame, ["Add the parser", "Rename the helper", "Fix the", "(current)"]))).toBe(true)
  expect(pointerLines(frame)).toHaveLength(1)
  expect(pointerLines(frame)[0]).toContain("Rename the helper")

  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(setup.dryRunsSent()).toEqual(["msg_0003"])
})

// The newest prompt's reply is still running when the list opens, with a file written; then its step ends.
const runningReply = [
  ...conversation.slice(0, 5),
  {
    id: "msg_0006",
    type: "assistant",
    agent: "build",
    model: { providerID: "provider", id: "model" },
    time: { created: Date.now() - 4 * 60_000 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [
      { type: "text", text: "Fixed the title." },
      {
        type: "tool",
        id: "call_write",
        name: "write",
        state: { status: "completed", input: { filePath: "src/c.ts" }, content: [], metadata: {} },
        time: { created: 1, completed: 2 },
      },
    ],
  },
]
const askedFor = (setup: Setup, messageID: string) =>
  setup.statsSent().filter((sent) => sent === `prompt ${messageID}`).length

test("the newest prompt's file line follows its reply's edits", async () => {
  await using state = await tmpdir()
  let newest = 0
  await using setup = await rewindApp({
    state: state.path,
    messages: runningReply,
    answer: (request) => {
      const query = new URLSearchParams(request.search)
      if (!request.path.endsWith("/diff") || query.get("from") !== "msg_0005") return undefined
      return json({
        data: newest++ === 0 ? [] : [{ file: "src/c.ts", patch: "", additions: 4, deletions: 0, status: "added" }],
      })
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Fixed the title."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  const before = await setup.waitForFrame((frame) => listHas(frame, "No file edits") === 1)
  const [prompt, empty] = rowOrder(before, ["Fix the", "No file edits"])
  expect(empty - prompt).toBe(1)
  live(setup, "session.step.ended", {
    assistantMessageID: "msg_0006",
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })

  const frame = await setup.waitForFrame((frame) => listHas(frame, "c.ts +4 -0") === 1, { maxPasses: 200 })
  const [row, line] = rowOrder(frame, ["Fix the", "c.ts +4 -0"])
  expect(line - row).toBe(1)
  await Bun.sleep(200)
  expect(askedFor(setup, "msg_0005")).toBe(2)
  expect(askedFor(setup, "msg_0001")).toBe(1)
  expect(askedFor(setup, "msg_0003")).toBe(1)
})

// A tool call that only starts or runs has written nothing yet, so it asks nothing; the moment it finishes, while the
// reply is still running, the newest prompt's file line is asked again.
test("a tool call of a running reply asks the stats again when it finishes, not when it starts", async () => {
  await using state = await tmpdir()
  let newest = 0
  await using setup = await rewindApp({
    state: state.path,
    messages: runningReply,
    answer: (request) => {
      const query = new URLSearchParams(request.search)
      if (!request.path.endsWith("/diff") || query.get("from") !== "msg_0005") return undefined
      return json({
        data: newest++ === 0 ? [] : [{ file: "src/d.ts", patch: "", additions: 2, deletions: 1, status: "modified" }],
      })
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Fixed the title."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => listHas(frame, "No file edits") === 1)
  const call = { assistantMessageID: "msg_0006", id: "call_edit" }
  live(setup, "session.tool.input.started", { ...call, name: "edit" })
  live(setup, "session.tool.called", { ...call, input: { filePath: "src/d.ts" }, executed: true, state: {} })
  await settled(setup)
  await settled(setup)
  expect(askedFor(setup, "msg_0005")).toBe(1)

  live(setup, "session.tool.success", { ...call, metadata: {}, content: [], executed: true })
  const frame = await setup.waitForFrame((frame) => listHas(frame, "d.ts +2 -1") === 1, { maxPasses: 200 })
  expect(listHas(frame, "No file edits")).toBe(0)
  expect(askedFor(setup, "msg_0005")).toBe(2)
})

// One request per row at a time: a range that changes while the row's request runs is asked once more when that
// request answers, so the line ends on the newer range rather than the answer that was already on its way.
test("a reply that ends while its prompt's stats are being asked asks them once more after the answer", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<void>()
  let newest = 0
  await using setup = await rewindApp({
    state: state.path,
    messages: runningReply,
    answer: (request) => {
      const query = new URLSearchParams(request.search)
      if (!request.path.endsWith("/diff") || query.get("from") !== "msg_0005") return undefined
      if (newest++ === 0) return held.promise.then(() => json({ data: [] }))
      return json({ data: [{ file: "src/e.ts", patch: "", additions: 3, deletions: 0, status: "added" }] })
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Fixed the title."))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  await until(() => askedFor(setup, "msg_0005") === 1, "the newest prompt's first ask")
  live(setup, "session.step.ended", {
    assistantMessageID: "msg_0006",
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await settled(setup)
  await settled(setup)
  expect(askedFor(setup, "msg_0005")).toBe(1)

  held.resolve()
  const frame = await setup.waitForFrame((frame) => listHas(frame, "e.ts +3 -0") === 1, { maxPasses: 200 })
  expect(listHas(frame, "No file edits")).toBe(0)
  expect(askedFor(setup, "msg_0005")).toBe(2)
})

// Control for the bound on asking again: streamed text changes no file, so it asks nothing.
test("streamed text alone does not ask the stats again", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await until(() => setup.statsSent().length === 3, "the rows' stats")
  live(setup, "session.text.started", { assistantMessageID: "msg_0006", ordinal: 1 })
  live(setup, "session.text.delta", { assistantMessageID: "msg_0006", ordinal: 1, delta: "Streamed words" })
  live(setup, "session.step.streamed", { assistantMessageID: "msg_0006" })
  await settled(setup)
  await settled(setup)
  expect(setup.statsSent()).toHaveLength(3)
  // The same events reach the picker: the step ending after them asks the newest prompt once more.
  live(setup, "session.step.ended", {
    assistantMessageID: "msg_0006",
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await until(() => askedFor(setup, "msg_0005") === 2, "the newest prompt's second ask")
  expect(setup.statsSent()).toHaveLength(4)
})

test("a session moved while the list is open asks the earlier rows again", async () => {
  await using state = await tmpdir()
  let moved = false
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) =>
      moved && request.path.endsWith("/diff")
        ? json({ _tag: "BadRequest", message: "The range crosses a folder switch" }, { status: 400 })
        : undefined,
  })
  await openPicker(setup)
  await setup.waitForFrame((frame) => listHas(frame, "parser.ts +12 -0") === 1 && listHas(frame, "2 files +5 -3") === 1)
  moved = true
  live(setup, "session.moved", { location: { directory: "/tmp/orbit/packages/tui" }, projectID: "project" })

  const frame = await setup.waitForFrame((frame) => listHas(frame, "No code rewind for this prompt") === 3, {
    maxPasses: 200,
  })
  expect(listHas(frame, "parser.ts +12 -0")).toBe(0)
  expect(askedFor(setup, "msg_0001")).toBe(2)
  expect(askedFor(setup, "msg_0003")).toBe(2)
})

test("a row whose stats failed asks again after a reconnect", async () => {
  await using state = await tmpdir()
  let middle = 0
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => {
      const query = new URLSearchParams(request.search)
      if (!request.path.endsWith("/diff") || query.get("from") !== "msg_0003") return undefined
      return middle++ === 0 ? json({ _tag: "UnknownError", message: "lost" }, { status: 500 }) : undefined
    },
  })
  await openPicker(setup)
  await setup.waitForFrame((frame) => listHas(frame, "No code rewind for this prompt") === 1)
  setup.events.disconnect()

  const frame = await setup.waitForFrame((frame) => listHas(frame, "2 files +5 -3") === 1, { maxPasses: 400 })
  expect(listHas(frame, "No code rewind for this prompt")).toBe(0)
  expect(askedFor(setup, "msg_0003")).toBe(2)
  expect(askedFor(setup, "msg_0001")).toBe(1)
})

// Class 13: the prompt left the conversation through another client's revert, so staging at it would move that
// revert and put back what it hid. The picker refuses in words and sends nothing.
test("a prompt another client's revert hid is not rewound from step 2", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await selectPrompt(setup, 1)
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  live(setup, "session.revert.staged", { revert: { messageID: "msg_0003", files: [] } })
  await settled(setup)
  await setup.mockInput.typeText("1")

  const frame = await setup.waitForFrame((frame) =>
    frame.includes("Could not rewind: that prompt is no longer in the conversation."),
  )
  expect(controlFree(frame)).toBe(true)
  await settled(setup)
  expect(setup.actions()).toEqual([])
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Could not rewind"))
  expect(setup.actions()).toEqual([])
})

// Step 2 holds the chosen prompt and does not follow the list (a control); Esc goes back to the live list.
test("a prompt that arrives while step 2 is open changes nothing there, and Esc goes back to the live list", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await openPicker(setup)
  await selectPrompt(setup, 2)
  const step = (frame: string) =>
    frame
      .split("\n")
      .filter((line) =>
        /\d\. (Code and conversation|Conversation only|Code only|Never mind)|goes back|stays as it is/.test(line),
      )
  const before = step(await setup.waitForFrame((frame) => frame.includes("Code and conversation")))
  arrive(setup, "msg_0007", "Arrived later")
  await settled(setup)
  expect(step(await settled(setup))).toEqual(before)

  setup.mockInput.pressEscape()
  const frame = await setup.waitForFrame((frame) => listHas(frame, "Arrived later") === 1, { maxPasses: 200 })
  expect(listHas(frame, "(current)")).toBe(1)
  expect(pointerLines(frame)).toHaveLength(1)
  expect(pointerLines(frame)[0]).toContain("Rename the helper")
})

// Control: the position set when the picker opened is 0, so the first prompt to arrive is pointed and acts.
test("the first prompt to arrive turns nothing to rewind into the list", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, messages: [] })
  await setup.waitForFrame((frame) => frame.includes("Rewind fixture"))
  await setup.mockInput.typeText("/rewind")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Nothing to rewind yet."))
  arrive(setup, "msg_0001", "Add the first thing")

  const frame = await setup.waitForFrame((frame) => listHas(frame, "Add the first thing") === 1, { maxPasses: 200 })
  expect(listHas(frame, "(current)")).toBe(1)
  expect(pointerLines(frame)[0]).toContain("Add the first thing")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(setup.dryRunsSent()).toEqual(["msg_0001"])
})
