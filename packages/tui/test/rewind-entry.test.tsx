import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"
import { conversation, linesWith, listHeading, rewindApp, sessionID, until, withShell } from "./fixture/rewind"

// clients-ux-5 part 2: every way into the rewind picker (class 12). `/rewind` and its alias `/checkpoint`, Esc pressed
// twice on an empty prompt of an idle session, and the message dialog's Rewind, which opens step 2 for that prompt or,
// when nothing but empty replies follows it and no file would change, rewinds the conversation at once. An interrupt
// of a prompt that got no reply yet puts the prompt back in the input the same way.

const quick = { id: "msg_0007", type: "user", text: "Quick question", time: { created: Date.now() - 60_000 } }
const reply = (content: ReadonlyArray<unknown>, completed: boolean) => ({
  id: "msg_0008",
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  time: completed ? { created: Date.now() - 59_000, completed: Date.now() - 58_000 } : { created: Date.now() - 59_000 },
  ...(completed ? { finish: "stop" } : {}),
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  content,
})

const loaded = (frame: string) => frame.includes("Renamed it.")

test("/checkpoint opens the same picker as /rewind", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  await setup.mockInput.typeText("/checkpoint")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((frame) => frame.includes(listHeading))
  expect(frame).toContain("Rename the helper")
  expect(frame).toContain("(current)")
})

test("Esc twice on an empty prompt of an idle session opens the picker", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  const frame = await setup.waitForFrame((frame) => frame.includes(listHeading), { maxPasses: 100 })
  expect(frame).toContain("(current)")
  expect(setup.actions()).toEqual([])
})

// The double-press window is wider than one burst of key events: a second Esc 400 ms after the first still opens it.
test("Esc twice 400 ms apart on an empty prompt of an idle session opens the picker", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  setup.mockInput.pressEscape()
  await Bun.sleep(400)
  setup.mockInput.pressEscape()
  const frame = await setup.waitForFrame((frame) => frame.includes(listHeading), { maxPasses: 100 })
  expect(frame).toContain("(current)")
  expect(setup.actions()).toEqual([])
})

// The controls: one Esc, two Esc presses further apart than the double-press window, and two quick ones while the
// prompt holds text, open nothing.
test("Esc once, Esc twice slowly, or Esc twice over a typed prompt does not open the picker", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  setup.mockInput.pressEscape()
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain(listHeading)
  await Bun.sleep(700)
  setup.mockInput.pressEscape()
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain(listHeading)

  await setup.mockInput.typeText("draft")
  await setup.waitForFrame((frame) => frame.includes("draft"))
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  await Bun.sleep(300)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).not.toContain(listHeading)
})

// Each condition on its own, in a fresh app so no earlier press arms the first Esc: a typed prompt, a session with no
// messages, one whose queued prompt waits in the inbox, and one whose every prompt a staged revert took back, so the
// visible conversation is empty although its messages are still listed (Esc twice belongs to the picker only when
// none holds).
const queued = { id: "msg_queued", type: "user", delivery: "queue", payload: { text: "Later" }, time: { created: 5 } }
test.each([
  { label: "over a typed prompt", messages: undefined, inbox: [], typed: "draft", ready: "Renamed it.", revert: "" },
  {
    label: "in a session with no messages",
    messages: [] as unknown[],
    inbox: [],
    typed: "",
    ready: "Rewind fixture",
    revert: "",
  },
  {
    label: "while a queued prompt waits",
    messages: undefined,
    inbox: [queued],
    typed: "",
    ready: "Renamed it.",
    revert: "",
  },
  {
    label: "after a staged revert took back every prompt",
    messages: undefined,
    inbox: [],
    typed: "",
    ready: "/redo to restore",
    revert: "msg_0001",
  },
])("Esc twice $label does not open the picker", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    messages: row.messages,
    revert: row.revert || undefined,
    answer: (request) => (request.path.endsWith("/inbox") ? json({ data: row.inbox }) : undefined),
  })
  await setup.waitForFrame((frame) => frame.includes(row.ready))
  if (row.typed) {
    await setup.mockInput.typeText(row.typed)
    await setup.waitForFrame((frame) => frame.includes(row.typed))
  }
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  await Bun.sleep(300)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).not.toContain(listHeading)
  expect(frame).not.toContain("Nothing to rewind yet.")
})

// A select dialog focuses its search field a moment after it is drawn, so each filter is typed after that moment.
const openFromTimeline = async (setup: Awaited<ReturnType<typeof rewindApp>>, prompt: string) => {
  await setup.mockInput.typeText("/timeline")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Timeline"))
  await Bun.sleep(50)
  await setup.mockInput.typeText(prompt)
  await setup.waitForFrame((frame) => frame.includes(prompt))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Message Actions"))
  await Bun.sleep(50)
  await setup.mockInput.typeText("Rewind")
  await setup.waitForFrame((frame) => frame.includes("Rewind"))
  setup.mockInput.pressEnter()
}

test("the message dialog's Rewind opens step 2 for that prompt, and Esc closes the picker instead of going back", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  await openFromTimeline(setup, "Rename the helper")

  const frame = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(frame).toContain("Rewind to just before this prompt:")
  expect(frame).not.toContain(listHeading)
  expect(setup.dryRunsSent()).toEqual(["msg_0003"])

  setup.mockInput.pressEscape()
  const closed = await setup.waitForFrame((frame) => !frame.includes("Code and conversation"))
  expect(closed).not.toContain(listHeading)
  expect(setup.actions()).toEqual([])
})

// A picker opened from the message dialog stands in for the reference's step 2 while it checks files, and `n` does
// nothing in that step: only Esc closes it.
test("n does nothing while a picker opened from the message dialog checks files, and in its step 2", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => (request.path.endsWith("/revert/files") && request.body?.dryRun ? held.promise : undefined),
  })
  await setup.waitForFrame(loaded)
  await openFromTimeline(setup, "Rename the helper")
  await setup.waitForFrame((frame) => frame.includes("Checking files…"))
  setup.mockInput.pressKey("n")
  await Bun.sleep(150)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Checking files…")

  held.resolve(
    json({
      data: { canRewind: true, filesChanged: ["/tmp/orbit/src/a.ts"], insertions: 3, deletions: 5 },
    }),
  )
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  setup.mockInput.pressKey("n")
  await Bun.sleep(150)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Code and conversation")
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes("Code and conversation"))
  expect(setup.actions()).toEqual([])
})

// The skip-picker shortcut: a prompt followed only by a reply with nothing in it, whose rewind would change no file,
// goes straight back into the input with its conversation rewound, as does one whose dry run lists files it cannot
// put back (no checkpoint). The controls are the same prompt when the dry run says a file would change, and when a
// command the person ran with `!` or a skill follows the empty reply: step 2 opens and nothing is rewound yet.
const ranAfter = {
  id: "msg_0009",
  type: "shell",
  shellID: "sh_after",
  command: "ls",
  status: "exited",
  exit: 0,
  output: { output: "", cursor: 0, size: 0, truncated: false },
  time: { created: Date.now() - 57_000, completed: Date.now() - 56_000 },
}
const skillAfter = {
  id: "msg_0009",
  type: "skill",
  skill: "review",
  name: "review",
  time: { created: Date.now() - 57_000 },
}
test.each([
  { label: "no file would change", canRewind: true, filesChanged: [], after: [], shortcut: true },
  {
    label: "the dry run cannot rewind the files it lists",
    canRewind: false,
    filesChanged: ["/tmp/orbit/packages/tui/src/quick.ts"],
    after: [],
    shortcut: true,
  },
  {
    label: "the dry run names its files in a string",
    canRewind: true,
    filesChanged: "/tmp/orbit/packages/tui/src/quick.ts",
    after: [],
    shortcut: true,
  },
  {
    label: "a file would change",
    canRewind: true,
    filesChanged: ["/tmp/orbit/packages/tui/src/quick.ts"],
    after: [],
    shortcut: false,
  },
  { label: "a shell command follows", canRewind: true, filesChanged: [], after: [ranAfter], shortcut: false },
  { label: "a skill follows", canRewind: true, filesChanged: [], after: [skillAfter], shortcut: false },
])("the message dialog rewinds at once when only an empty reply follows and $label", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    messages: [...conversation, quick, reply([], true), ...row.after],
    answer: (request) =>
      request.path.endsWith("/revert/files") && request.body?.dryRun && request.body.messageID === "msg_0007"
        ? json({ data: { canRewind: row.canRewind, filesChanged: row.filesChanged, insertions: 0, deletions: 1 } })
        : undefined,
  })
  await setup.waitForFrame(loaded)
  await setup.waitForFrame((frame) => frame.includes("Quick question"))
  await openFromTimeline(setup, "Quick question")

  if (!row.shortcut) {
    const frame = await setup.waitForFrame((frame) => frame.includes("Never mind"))
    expect(frame).toContain(row.filesChanged.length ? "Code and conversation" : "Conversation only")
    expect(frame).toContain("Quick question")
    expect(setup.actions()).toEqual([])
    return
  }
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions().filter((action) => action !== "interrupt" && action !== "wait")).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0007", files: false })}`,
  ])
  const frame = await setup.waitForFrame(
    (frame) => !frame.includes("Message Actions") && linesWith(frame, "Quick question") === 2,
    { maxPasses: 200 },
  )
  expect(frame).not.toContain("Code and conversation")
})

// An interrupt (Esc twice while the session runs) of a prompt whose reply has nothing in it yet, with nothing typed and
// nothing queued, rewinds the conversation to that prompt and puts it back in the input. The control is a reply that
// already holds text: the interrupt leaves the conversation as it is.
test.each([
  { label: "has nothing in it", content: [], restored: true },
  { label: "already holds text", content: [{ type: "text", text: "Partial answer" }], restored: false },
])("interrupting a prompt whose reply $label", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    running: true,
    messages: [...conversation, quick, reply(row.content, false)],
  })
  // Esc interrupts only once the app knows the session runs, which its interrupt hint shows.
  await setup.waitForFrame((frame) => frame.includes("Quick question") && frame.includes("interrupt"), {
    maxPasses: 200,
  })
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  await until(() => setup.actions().includes("interrupt"), "the interrupt")

  if (!row.restored) {
    await Bun.sleep(1000)
    expect(setup.actions().filter((action) => action.startsWith("stage"))).toEqual([])
    return
  }
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions().filter((action) => action.startsWith("stage") || action.startsWith("files"))).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0007", files: false })}`,
  ])
  await setup.waitForFrame((frame) => linesWith(frame, "Quick question") === 2, { maxPasses: 200 })
})

// Opened from the message dialog, the picker has no list to go back to: Never mind closes it, as Esc does. The newest
// prompt is the timeline's first row, so it is chosen without a filter.
test("Never mind on a picker opened from the message dialog closes it", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  await openFromTimeline(setup, "Fix the")
  await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(setup.dryRunsSent()).toEqual(["msg_0005"])
  for (let index = 0; index < 3; index++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  const closed = await setup.waitForFrame((frame) => !frame.includes("Never mind"))
  expect(closed).not.toContain(listHeading)
  expect(closed).not.toContain("Checking files")
  expect(setup.actions()).toEqual([])
})

// The interrupted prompt goes back into the input, so the history entry its submit added is dropped and Up does not
// offer it twice; the entries before it stay. The prompt is sent from this window, as only its own entry is dropped.
test("interrupting a prompt whose reply has nothing in it drops the prompt's history entry", async () => {
  await using state = await tmpdir()
  const history = Bun.file(`${state.path}/prompt-history.jsonl`)
  await Bun.write(history, JSON.stringify({ text: "Earlier", files: [], agents: [], pasted: [] }) + "\n")
  await using setup = await rewindApp({
    state: state.path,
    answer: (request) => {
      if (request.method !== "POST" || !request.path.endsWith("/prompt")) return undefined
      const item = { type: "user", payload: { text: request.body.text }, delivery: "steer" }
      return json({ data: { id: request.body.id, sessionID, time: { created: Date.now() }, ...item } })
    },
  })
  await setup.waitForFrame(loaded)
  await setup.mockInput.typeText("Quick question")
  setup.mockInput.pressEnter()
  await until(() => setup.requests.some((request) => request.path.endsWith("/prompt")), "the prompt request")
  const sent = setup.requests.find((request) => request.path.endsWith("/prompt"))!
  // The server delivers it and starts working on it: the prompt leaves the inbox and becomes the newest message, with
  // no reply yet. Events are handled in order, so the interrupt hint shows only once the delivery is in too.
  setup.events.emit({
    id: "evt_quick_delivered",
    created: Date.now(),
    type: "session.inbox.delivered",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, inboxID: sent.body.id },
  })
  setup.events.emit({
    id: "evt_quick_started",
    created: Date.now(),
    type: "session.execution.started",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID },
  })
  await setup.waitForFrame((frame) => frame.includes("Quick question") && frame.includes("esc interrupt"), {
    maxPasses: 200,
  })
  const texts = async () =>
    (await history.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).text)
  // The file is written in the background, so it is read until it holds the submit's entry.
  for (const _ of Array.from({ length: 200 })) {
    if ((await texts()).join() === "Earlier,Quick question") break
    await Bun.sleep(20)
  }
  expect(await texts()).toEqual(["Earlier", "Quick question"])
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions().filter((action) => action.startsWith("stage"))).toEqual([
    `stage ${JSON.stringify({ messageID: sent.body.id, files: false })}`,
  ])
  await setup.waitForFrame((frame) => linesWith(frame, "Quick question") === 2, { maxPasses: 200 })
  // The file is rewritten in the background, so it is read until it holds the result.
  let saved: string[] = []
  for (const _ of Array.from({ length: 200 })) {
    saved = await texts()
    if (saved.join() === "Earlier") break
    await Bun.sleep(20)
  }
  expect(saved).toEqual(["Earlier"])
})

// A click on a person's prompt in the transcript opens the same message dialog as the timeline, and its Rewind opens
// step 2 for that prompt.
test("a click on a prompt opens the message dialog, whose Rewind opens step 2 for that prompt", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  const frame = await setup.waitForFrame(loaded)
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes("Rename the helper"))
  await setup.mockMouse.click(lines[row].indexOf("Rename the helper") + 1, row)
  await setup.waitForFrame((frame) => frame.includes("Message Actions"))
  await Bun.sleep(50)
  await setup.mockInput.typeText("Rewind")
  await setup.waitForFrame((frame) => frame.includes("code and/or conversation"))
  setup.mockInput.pressEnter()
  const confirm = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(confirm).toContain("Rewind to just before this prompt:")
  expect(setup.dryRunsSent()).toEqual(["msg_0003"])
  expect(setup.actions()).toEqual([])
})

// On a running session the message dialog's Rewind stops the session before its dry run, which the server would
// otherwise refuse, so step 2 still offers the code options.
test("the message dialog's Rewind on a running session stops it first and offers the code options", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, running: true })
  await setup.waitForFrame(loaded)
  await openFromTimeline(setup, "Rename the helper")
  const confirm = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
  expect(confirm).toContain("Rewind to just before this prompt:")
  expect(setup.sequence()).toEqual(["interrupt", "wait", "dry run msg_0003"])
})

// The shortcut on a running session: the prompt's reply is still empty, so the dialog's Rewind stops the session, asks
// the dry run and, with no file to change, rewinds the conversation at once. While the stop is under way the picker
// already stands in for the message dialog with `Checking files…`, so the dialog cannot be chosen twice, Enter sends
// nothing more, and Esc gives up the rewind (the stop it already asked for stays).
test.each([
  { label: "goes on to the conversation rewind", escape: false },
  { label: "is given up by Esc", escape: true },
])(
  "the message dialog's shortcut on a running session shows Checking files while it stops, and $label",
  async (row) => {
    await using state = await tmpdir()
    const held = Promise.withResolvers<void>()
    await using setup = await rewindApp({
      state: state.path,
      running: true,
      messages: [...conversation, quick, reply([], false)],
      answer: (request) => {
        if (request.path.endsWith("/wait")) return held.promise.then(() => new Response(null, { status: 204 }))
        if (request.path.endsWith("/revert/files") && request.body?.dryRun)
          return json({ data: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } })
        return undefined
      },
    })
    await setup.waitForFrame((frame) => frame.includes("Quick question"))
    await openFromTimeline(setup, "Quick question")
    await until(() => setup.actions().includes("wait"), "the wait for the stop")
    const checking = await setup.waitForFrame((frame) => frame.includes("Checking files…"))
    expect(checking).not.toContain("Message Actions")
    setup.mockInput.pressEnter()
    await Bun.sleep(200)
    expect(setup.sequence()).toEqual(["interrupt", "wait"])

    if (row.escape) {
      setup.mockInput.pressEscape()
      await setup.waitForFrame((frame) => !frame.includes("Checking files…"))
      held.resolve()
      await until(() => setup.dryRunsSent().length === 1, "the dry run")
      await Bun.sleep(300)
      expect(setup.actions()).toEqual(["interrupt", "wait"])
      return
    }
    held.resolve()
    await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
    expect(setup.sequence()).toEqual([
      "interrupt",
      "wait",
      "dry run msg_0007",
      "interrupt",
      "wait",
      `stage ${JSON.stringify({ messageID: "msg_0007", files: false })}`,
    ])
    const frame = await setup.waitForFrame(
      (frame) => !frame.includes("Checking files…") && linesWith(frame, "Quick question") === 2,
      { maxPasses: 200 },
    )
    expect(frame).not.toContain("Message Actions")
  },
)

// A prompt at or after the staged revert's boundary is no longer in the conversation: the message dialog's Rewind
// closes without asking anything.
test("the message dialog's Rewind on a prompt a staged revert already took back closes without a dry run", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path, revert: "msg_0005" })
  await setup.waitForFrame(loaded)
  await openFromTimeline(setup, "Fix the")
  await setup.waitForFrame((frame) => !frame.includes("Message Actions"))
  await Bun.sleep(300)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).not.toContain("Checking files")
  expect(frame).not.toContain("Code and conversation")
  expect(setup.dryRunsSent()).toEqual([])
  expect(setup.actions()).toEqual([])
})

// A prompt that leaves the conversation while its message dialog is open (here a revert another client committed) is
// no prompt to rewind any more: the dialog's Rewind does nothing, and the dialog stays for its other actions.
test("the message dialog's Rewind on a prompt that left the conversation while the dialog was open does nothing", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  await setup.mockInput.typeText("/timeline")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Timeline"))
  await Bun.sleep(50)
  await setup.mockInput.typeText("Fix the")
  await setup.waitForFrame((frame) => frame.includes("Fix the"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Message Actions") && frame.includes("Fixed the title."))
  setup.events.emit({
    id: "evt_committed_elsewhere",
    created: Date.now(),
    type: "session.revert.committed",
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, to: "msg_0005" },
  })
  await setup.waitForFrame((frame) => !frame.includes("Fixed the title."), { maxPasses: 200 })
  await Bun.sleep(50)
  await setup.mockInput.typeText("Rewind")
  await setup.waitForFrame((frame) => frame.includes("code and/or conversation"))
  setup.mockInput.pressEnter()
  await Bun.sleep(300)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Message Actions")
  expect(frame).not.toContain("Checking files")
  expect(setup.dryRunsSent()).toEqual([])
  expect(setup.actions()).toEqual([])
})

// The shortcut decides again once its dry run answers, because the conversation can change while the dry run runs (and
// while a running session is stopped before it). A prompt another client's revert took back is not staged at: that
// would move the other revert and put back what it hid. The refusal is shown, and nothing more is sent after the hide.
test.each([{ running: false }, { running: true }])(
  "the message dialog's shortcut sends nothing for a prompt another client's revert hid during its dry run (running: $running)",
  async (row) => {
    await using state = await tmpdir()
    const held = Promise.withResolvers<void>()
    await using setup = await rewindApp({
      state: state.path,
      running: row.running,
      messages: [...conversation, quick, reply([], !row.running)],
      answer: (request) => {
        if (!(request.path.endsWith("/revert/files") && request.body?.dryRun)) return undefined
        return held.promise.then(() =>
          json({ data: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } }),
        )
      },
    })
    await setup.waitForFrame((frame) => frame.includes("Quick question"))
    await openFromTimeline(setup, "Quick question")
    await until(() => setup.dryRunsSent().length === 1, "the dry run")
    await setup.waitForFrame((frame) => frame.includes("Checking files…"))
    const before = setup.actions()
    setup.events.emit({
      id: "evt_staged_elsewhere",
      created: Date.now(),
      type: "session.revert.staged",
      durable: { aggregateID: sessionID, seq: 200, version: 1 },
      data: { sessionID, revert: { messageID: "msg_0003", files: [] } },
    })
    // The event reaches the client over its event stream, behind the picker that covers the transcript: give it time.
    await Bun.sleep(300)
    held.resolve()

    // The refusal is a toast, which wraps the sentence after "in the".
    const frame = await setup.waitForFrame(
      (frame) => frame.includes("Could not rewind: that prompt is no longer in the") && frame.includes("conversation."),
      { maxPasses: 200 },
    )
    expect(frame).not.toContain("Checking files…")
    await Bun.sleep(200)
    expect(setup.actions()).toEqual(before)
    expect(before).toEqual(row.running ? ["interrupt", "wait"] : [])
  },
)

// The same recheck reads the conversation as it is after the stop: a reply that gained text while the running session
// stopped is something a person would miss, so the picker goes on to step 2 instead of rewinding at once.
test("the message dialog's shortcut opens step 2 when the reply gained text before its dry run answered", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<void>()
  await using setup = await rewindApp({
    state: state.path,
    running: true,
    messages: [...conversation, quick, reply([], false)],
    answer: (request) => {
      if (!(request.path.endsWith("/revert/files") && request.body?.dryRun)) return undefined
      return held.promise.then(() => json({ data: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } }))
    },
  })
  await setup.waitForFrame((frame) => frame.includes("Quick question"))
  await openFromTimeline(setup, "Quick question")
  await until(() => setup.dryRunsSent().length === 1, "the dry run")
  const event = (type: string, data: Record<string, unknown>, seq: number) =>
    setup.events.emit({
      id: `evt_text_${seq}`,
      created: Date.now(),
      type,
      durable: { aggregateID: sessionID, seq, version: 1 },
      data: { sessionID, assistantMessageID: "msg_0008", ordinal: 1, ...data },
    } as never)
  event("session.text.started", {}, 300)
  event("session.text.delta", { delta: "Half an answer" }, 301)
  // The picker covers the transcript, so the text cannot be waited for in the frame: give the event stream time.
  await Bun.sleep(300)
  held.resolve()

  const frame = await setup.waitForFrame((frame) => frame.includes("Conversation only"), { maxPasses: 200 })
  expect(frame).toContain("Rewind the conversation to just before this prompt:")
  await Bun.sleep(200)
  expect(setup.actions()).toEqual(["interrupt", "wait"])
})

// Class 13: a conversation rewind the server refuses, on the shortcut or after an interrupt, is shown as an error.
test.each([
  { label: "the message dialog's shortcut", running: false },
  { label: "an interrupt", running: true },
])("a refused conversation rewind from $label is shown", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    running: row.running,
    messages: [...conversation, quick, reply([], !row.running)],
    answer: (request) => {
      if (request.path.endsWith("/revert/files") && request.body?.dryRun)
        return json({ data: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } })
      if (request.path.endsWith("/revert/stage"))
        return json({ _tag: "SessionBusyError", sessionID: "ses_rewind", message: "Session is busy" }, { status: 409 })
      return undefined
    },
  })
  if (row.running) {
    await setup.waitForFrame((frame) => frame.includes("Quick question") && frame.includes("interrupt"), {
      maxPasses: 200,
    })
    setup.mockInput.pressEscape()
    setup.mockInput.pressEscape()
  }
  if (!row.running) {
    await setup.waitForFrame((frame) => frame.includes("Quick question"))
    await openFromTimeline(setup, "Quick question")
  }
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  await setup.waitForFrame((frame) => frame.includes("Session is busy"), { maxPasses: 200 })
})

// The interrupt path rewinds nothing when the person has typed something since, or a prompt waits in the inbox: the
// conversation stays and the input keeps what it holds.
test.each([
  { label: "something is typed", typed: "draft", inbox: [] as unknown[] },
  { label: "a queued prompt waits", typed: "", inbox: [queued] },
])("interrupting a prompt with no reply rewinds nothing when $label", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    running: true,
    messages: [...conversation, quick, reply([], false)],
    answer: (request) => (request.path.endsWith("/inbox") ? json({ data: row.inbox }) : undefined),
  })
  await setup.waitForFrame((frame) => frame.includes("Quick question") && frame.includes("interrupt"), {
    maxPasses: 200,
  })
  if (row.typed) {
    await setup.mockInput.typeText(row.typed)
    await setup.waitForFrame((frame) => frame.includes(row.typed))
  }
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  await until(() => setup.actions().includes("wait"), "the wait after the interrupt")
  await Bun.sleep(500)
  expect(setup.actions().filter((action) => action.startsWith("stage"))).toEqual([])
})

// A prompt still in the inbox is not a message yet, so it is no row of the picker.
test("a prompt still waiting in the inbox is not a row", async () => {
  await using state = await tmpdir()
  const held = Promise.withResolvers<Response>()
  await using setup = await rewindApp({
    state: state.path,
    running: true,
    answer: (request) => (request.method === "POST" && request.path.endsWith("/prompt") ? held.promise : undefined),
  })
  try {
    await setup.waitForFrame(loaded)
    await setup.mockInput.typeText("Waiting prompt")
    setup.mockInput.pressEnter()
    await until(() => setup.requests.some((request) => request.path.endsWith("/prompt")), "the prompt request")
    await setup.mockInput.typeText("/rewind")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes(listHeading))
    await until(() => setup.statsSent().length >= 3, "the rows' stats")
    await Bun.sleep(200)
    expect(setup.statsSent().sort()).toEqual(["prompt msg_0001", "prompt msg_0003", "prompt msg_0005"])
  } finally {
    held.resolve(json({ _tag: "UnknownError", message: "stopped" }, { status: 500 }))
  }
})

// The shortcut skips the picker only when nothing a person would miss follows the prompt: a reply holding text, or a
// later prompt, sends the message dialog's Rewind to step 2 even when no file would change.
test.each([
  { label: "a reply with text", messages: conversation, prompt: "Add the parser" },
  {
    label: "a later prompt",
    messages: [
      { id: "msg_0001", type: "user", text: "First ask", time: { created: Date.now() - 120_000 } },
      { ...reply([], true), id: "msg_0002" },
      { ...quick, id: "msg_0003" },
      { ...reply([], true), id: "msg_0004" },
    ],
    prompt: "First ask",
  },
])("the message dialog's Rewind opens step 2 when $label follows", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    messages: [...row.messages],
    answer: (request) =>
      request.path.endsWith("/revert/files") && request.body?.dryRun
        ? json({ data: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } })
        : undefined,
  })
  await setup.waitForFrame((frame) => frame.includes(row.prompt))
  await openFromTimeline(setup, row.prompt)
  const frame = await setup.waitForFrame((frame) => frame.includes("Conversation only"))
  expect(frame).toContain("Rewind the conversation to just before this prompt:")
  expect(setup.actions()).toEqual([])
})

// What counts as something in a reply: text that is only spaces does not, a tool call does.
test.each([
  { label: "only spaces", content: [{ type: "text", text: "   " }], restored: true },
  {
    label: "a tool call",
    content: [
      {
        type: "tool",
        id: "call-read",
        name: "read",
        state: { status: "running", input: {}, metadata: {} },
        time: { created: 1 },
      },
    ],
    restored: false,
  },
])("interrupting a prompt whose reply holds $label", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    running: true,
    messages: [...conversation, quick, reply(row.content, false)],
  })
  await setup.waitForFrame((frame) => frame.includes("Quick question") && frame.includes("interrupt"), {
    maxPasses: 200,
  })
  setup.mockInput.pressEscape()
  setup.mockInput.pressEscape()
  await until(() => setup.actions().includes("wait"), "the wait after the interrupt")
  if (!row.restored) {
    await Bun.sleep(500)
    expect(setup.actions().filter((action) => action.startsWith("stage"))).toEqual([])
    return
  }
  await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
  expect(setup.actions().filter((action) => action.startsWith("stage"))).toEqual([
    `stage ${JSON.stringify({ messageID: "msg_0007", files: false })}`,
  ])
})

// The class matrix (class 12, fix loop 7): every way to the picker or to a rewind, against every kind of row the
// conversation can show, each cell decided by what the reference does. A person's prompt still waiting in the inbox
// (steer or queue) is drawn in the transcript and listed by the timeline, but it is no message yet: it is no row of
// the picker, its message dialog's Rewind interrupts, asks and changes nothing, and after another prompt it does not
// count as something a person would miss (the reference's selector never lists queued commands, and its skip test
// ignores them). Esc twice and the interrupt path still stand back while one waits, as the reference's do. Notices
// and compaction checkpoints are no rows and do not count after a prompt; a `!` command is a row and does count. Rows
// a staged revert took back are there for no entry point. The message dialog opens only on a person's prompt, so for
// the other kinds its cell is the timeline listing no such row.
const waiting = (delivery: "steer" | "queue") => ({
  id: "msg_waiting",
  sessionID,
  type: "user",
  delivery,
  payload: { text: "Waiting prompt" },
  time: { created: Date.now() },
})
const notice = {
  id: "msg_0009",
  type: "synthetic",
  text: "Background job finished",
  time: { created: Date.now() - 50_000 },
}
const checkpoint = {
  id: "msg_0009",
  type: "compaction",
  status: "completed",
  reason: "manual",
  summary: "Summary of the earlier work",
  recent: "",
  time: { created: Date.now() - 50_000 },
}
const shellCommand = "make build"
const prompts = ["Add the parser", "Rename the helper", "Fix the", "(current)"]
// The newest prompt with a reply that has nothing in it (still running when the session runs), then `after`.
const emptyReply = (after: unknown[], running = false) => [...conversation, quick, reply([], !running), ...after]
// The kinds of reply the newest prompt can get, each checked against the reference's rule that only messages a person
// would not miss may follow (fix loop 8). A reply that failed with a provider error draws that error, as the
// reference's error reply (a text block holding it) does, so it counts; so does a reply holding only a tool call, and a
// `!` command whose output is drawn. A reply that shows only that it was interrupted (its error is `aborted`), one
// still waiting to retry, and one holding only reasoning do not.
const replyOf = (fields: Record<string, unknown>, running = false) => [
  ...conversation,
  quick,
  { ...reply([], !running), ...fields },
]
const failed = { finish: "error", error: { type: "api", message: "Rate limit reached for this model" } }
const interrupted = { finish: "error", error: { type: "aborted", message: "Step interrupted" } }
const retrying = {
  retry: { attempt: 1, at: Date.now() - 58_000, error: { type: "api", message: "Overloaded, trying again" } },
}
const reasoningOnly = { content: [{ type: "reasoning", text: "Weighing the options" }] }
const toolOnly = {
  content: [
    {
      type: "tool",
      id: "call-read",
      name: "read",
      state: { status: "running", input: {}, metadata: {} },
      time: { created: 1 },
    },
  ],
}
const ranWithOutput = { ...ranAfter, output: { output: "built\n", cursor: 6, size: 6, truncated: false } }

type Cell = {
  entry: "Esc twice" | "/rewind" | "/checkpoint" | "the message dialog" | "the skip-picker shortcut" | "an interrupt"
  row: string
  messages?: unknown[]
  inbox?: unknown[]
  revert?: string
  running?: boolean
  /** The prompt the message dialog is opened on, or what the timeline is filtered by. */
  target?: string
  /**
   * `list`: the picker's list, showing `shows` and not `hides`; `nothing`: the picker says there is nothing to rewind;
   * `step 2`: the confirm step for `target`; `restored`: the newest prompt's conversation rewound with no picker;
   * `none`: no picker and no request but `actions`; `no timeline row`: the timeline lists nothing for `target`.
   */
  expect: "list" | "nothing" | "step 2" | "restored" | "none" | "no timeline row"
  shows?: string[]
  hides?: string[]
  actions?: string[]
}

const matrix: Cell[] = [
  { entry: "Esc twice", row: "a delivered prompt", expect: "list", shows: prompts },
  { entry: "Esc twice", row: "a prompt waiting to steer", inbox: [waiting("steer")], expect: "none" },
  { entry: "Esc twice", row: "a prompt waiting in the queue", inbox: [waiting("queue")], expect: "none" },
  {
    entry: "Esc twice",
    row: "a notice",
    messages: [...conversation, notice],
    expect: "list",
    shows: prompts,
    hides: ["Background job"],
  },
  {
    entry: "Esc twice",
    row: "a shell row",
    messages: withShell(shellCommand),
    expect: "list",
    shows: [`! ${shellCommand}`, ...prompts],
  },
  {
    entry: "Esc twice",
    row: "a compaction checkpoint",
    messages: [...conversation, checkpoint],
    expect: "list",
    shows: prompts,
    hides: ["Summary of"],
  },
  {
    entry: "Esc twice",
    row: "rows behind a staged revert",
    revert: "msg_0003",
    expect: "list",
    shows: ["Add the parser", "(current)"],
    hides: ["Rename the helper", "Fix the"],
  },
  { entry: "Esc twice", row: "an empty visible conversation", revert: "msg_0001", expect: "none" },

  { entry: "/rewind", row: "a delivered prompt", expect: "list", shows: prompts },
  {
    entry: "/rewind",
    row: "a prompt waiting to steer",
    inbox: [waiting("steer")],
    expect: "list",
    shows: prompts,
    hides: ["Waiting prompt"],
  },
  {
    entry: "/rewind",
    row: "a prompt waiting in the queue",
    inbox: [waiting("queue")],
    expect: "list",
    shows: prompts,
    hides: ["Waiting prompt"],
  },
  {
    entry: "/rewind",
    row: "a notice",
    messages: [...conversation, notice],
    expect: "list",
    shows: prompts,
    hides: ["Background job"],
  },
  {
    entry: "/rewind",
    row: "a shell row",
    messages: withShell(shellCommand),
    expect: "list",
    shows: [`! ${shellCommand}`, ...prompts],
  },
  {
    entry: "/rewind",
    row: "a compaction checkpoint",
    messages: [...conversation, checkpoint],
    expect: "list",
    shows: prompts,
    hides: ["Summary of"],
  },
  {
    entry: "/rewind",
    row: "rows behind a staged revert",
    revert: "msg_0003",
    expect: "list",
    shows: ["Add the parser", "(current)"],
    hides: ["Rename the helper", "Fix the"],
  },
  { entry: "/rewind", row: "an empty visible conversation", revert: "msg_0001", expect: "nothing" },
  { entry: "/checkpoint", row: "a delivered prompt", expect: "list", shows: prompts },
  {
    entry: "/checkpoint",
    row: "a prompt waiting to steer",
    inbox: [waiting("steer")],
    expect: "list",
    shows: prompts,
    hides: ["Waiting prompt"],
  },
  { entry: "/checkpoint", row: "an empty visible conversation", revert: "msg_0001", expect: "nothing" },

  { entry: "the message dialog", row: "a delivered prompt", target: "Rename the helper", expect: "step 2" },
  {
    entry: "the message dialog",
    row: "a prompt waiting to steer",
    running: true,
    inbox: [waiting("steer")],
    target: "Waiting prompt",
    expect: "none",
  },
  {
    entry: "the message dialog",
    row: "a prompt waiting in the queue",
    running: true,
    inbox: [waiting("queue")],
    target: "Waiting prompt",
    expect: "none",
  },
  {
    entry: "the message dialog",
    row: "a notice",
    messages: [...conversation, notice],
    target: "Background",
    expect: "no timeline row",
  },
  {
    entry: "the message dialog",
    row: "a shell row",
    messages: withShell(shellCommand),
    target: shellCommand,
    expect: "no timeline row",
  },
  {
    entry: "the message dialog",
    row: "a compaction checkpoint",
    messages: [...conversation, checkpoint],
    target: "Summary",
    expect: "no timeline row",
  },
  {
    entry: "the message dialog",
    row: "rows behind a staged revert",
    revert: "msg_0005",
    target: "Fix the",
    expect: "none",
  },
  {
    entry: "the message dialog",
    row: "an empty visible conversation",
    revert: "msg_0001",
    target: "Add the parser",
    expect: "none",
  },

  {
    entry: "the skip-picker shortcut",
    row: "a delivered prompt with an empty reply",
    messages: emptyReply([]),
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a prompt waiting to steer after it",
    messages: emptyReply([]),
    inbox: [waiting("steer")],
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a prompt waiting in the queue after it",
    messages: emptyReply([]),
    inbox: [waiting("queue")],
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a notice after it",
    messages: emptyReply([notice]),
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a shell row after it",
    messages: emptyReply([ranAfter]),
    target: "Quick question",
    expect: "step 2",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a compaction checkpoint after it",
    messages: emptyReply([checkpoint]),
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a reply that failed with a provider error",
    messages: replyOf(failed),
    target: "Quick question",
    expect: "step 2",
  },
  {
    entry: "the skip-picker shortcut",
    row: "an interrupted reply",
    messages: replyOf(interrupted),
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a reply waiting to retry",
    messages: replyOf(retrying),
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a reply holding only reasoning",
    messages: replyOf(reasoningOnly),
    target: "Quick question",
    expect: "restored",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a reply holding only a tool call",
    messages: replyOf(toolOnly),
    target: "Quick question",
    expect: "step 2",
  },
  {
    entry: "the skip-picker shortcut",
    row: "a shell row with output after it",
    messages: emptyReply([ranWithOutput]),
    target: "Quick question",
    expect: "step 2",
  },
  {
    entry: "the skip-picker shortcut",
    row: "rows behind a staged revert",
    messages: emptyReply([]),
    revert: "msg_0007",
    target: "Quick question",
    expect: "none",
  },

  {
    entry: "an interrupt",
    row: "a delivered prompt with an empty reply",
    running: true,
    messages: emptyReply([], true),
    expect: "restored",
  },
  {
    entry: "an interrupt",
    row: "a prompt waiting to steer",
    running: true,
    messages: emptyReply([], true),
    inbox: [waiting("steer")],
    expect: "none",
    actions: ["interrupt", "wait"],
  },
  {
    entry: "an interrupt",
    row: "a prompt waiting in the queue",
    running: true,
    messages: emptyReply([], true),
    inbox: [waiting("queue")],
    expect: "none",
    actions: ["interrupt", "wait"],
  },
  {
    entry: "an interrupt",
    row: "a notice after the empty reply",
    running: true,
    messages: emptyReply([notice], true),
    expect: "restored",
  },
  {
    entry: "an interrupt",
    row: "a shell row after the empty reply",
    running: true,
    messages: emptyReply([ranAfter], true),
    expect: "none",
    actions: ["interrupt", "wait"],
  },
  {
    entry: "an interrupt",
    row: "a compaction checkpoint after the empty reply",
    running: true,
    messages: emptyReply([checkpoint], true),
    expect: "restored",
  },
  {
    entry: "an interrupt",
    row: "a reply that failed with a provider error",
    running: true,
    messages: replyOf(failed, true),
    expect: "none",
    actions: ["interrupt", "wait"],
  },
  {
    entry: "an interrupt",
    row: "an interrupted reply",
    running: true,
    messages: replyOf(interrupted, true),
    expect: "restored",
  },
  {
    entry: "an interrupt",
    row: "a reply waiting to retry",
    running: true,
    messages: replyOf(retrying, true),
    expect: "restored",
  },
  {
    entry: "an interrupt",
    row: "a reply holding only reasoning",
    running: true,
    messages: replyOf(reasoningOnly, true),
    expect: "restored",
  },
  {
    entry: "an interrupt",
    row: "a reply holding only a tool call",
    running: true,
    messages: replyOf(toolOnly, true),
    expect: "none",
    actions: ["interrupt", "wait"],
  },
  {
    entry: "an interrupt",
    row: "a shell row with output after the empty reply",
    running: true,
    messages: emptyReply([ranWithOutput], true),
    expect: "none",
    actions: ["interrupt", "wait"],
  },
  {
    entry: "an interrupt",
    row: "rows behind a staged revert",
    running: true,
    messages: emptyReply([], true),
    revert: "msg_0007",
    expect: "none",
    actions: ["interrupt", "wait"],
  },
  {
    entry: "an interrupt",
    row: "an empty visible conversation",
    running: true,
    messages: [],
    expect: "none",
    actions: ["interrupt", "wait"],
  },
]

/** The lines of a frame from the picker's list heading to its footer. */
const listBlock = (frame: string) => {
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => line.includes(listHeading))
  const end = lines.findIndex((line, index) => index > start && line.includes("enter continue"))
  return lines.slice(start, end + 1).join("\n")
}

test.each(matrix)("$entry on $row", async (cell) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    running: cell.running,
    messages: cell.messages,
    revert: cell.revert,
    answer: (request) => (request.path.endsWith("/inbox") ? json({ data: cell.inbox ?? [] }) : undefined),
  })
  // A running session is ready once its interrupt hint shows (an interrupted reply's footer also says "interrupted"); a
  // waiting prompt once the transcript draws it.
  await setup.waitForFrame(
    (frame) =>
      frame.includes("Rewind fixture") &&
      (!cell.running || frame.includes("esc interrupt")) &&
      (!cell.inbox?.length || frame.includes("Waiting prompt")),
    { maxPasses: 200 },
  )

  if (cell.expect === "no timeline row") {
    await setup.mockInput.typeText("/timeline")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Timeline"))
    await Bun.sleep(50)
    await setup.mockInput.typeText(cell.target!)
    await setup.waitForFrame((frame) => frame.includes("No results found"))
    expect(setup.actions()).toEqual([])
    return
  }
  if (cell.entry === "Esc twice" || cell.entry === "an interrupt") {
    setup.mockInput.pressEscape()
    setup.mockInput.pressEscape()
  }
  if (cell.entry === "/rewind" || cell.entry === "/checkpoint") {
    await setup.mockInput.typeText(cell.entry)
    setup.mockInput.pressEnter()
  }
  if (cell.entry === "the message dialog" || cell.entry === "the skip-picker shortcut") {
    await openFromTimeline(setup, cell.target!)
    await setup.waitForFrame((frame) => !frame.includes("Message Actions"))
  }
  if (cell.entry === "an interrupt") await until(() => setup.actions().includes("wait"), "the wait after the interrupt")

  if (cell.expect === "list") {
    const block = listBlock(await setup.waitForFrame((frame) => frame.includes(listHeading), { maxPasses: 100 }))
    for (const text of cell.shows ?? []) expect(block).toContain(text)
    for (const text of cell.hides ?? []) expect(block).not.toContain(text)
    expect(setup.actions()).toEqual([])
    return
  }
  if (cell.expect === "nothing") {
    await setup.waitForFrame((frame) => frame.includes("Nothing to rewind yet."))
    expect(setup.actions()).toEqual([])
    return
  }
  if (cell.expect === "step 2") {
    const frame = await setup.waitForFrame((frame) => frame.includes("Never mind"))
    expect(frame).toContain("just before this prompt:")
    expect(frame).toContain("Conversation only")
    expect(frame).toContain(cell.target!)
    expect(setup.actions()).toEqual([])
    return
  }
  if (cell.expect === "restored") {
    await until(() => setup.actions().some((action) => action.startsWith("stage")), "the stage request")
    expect(setup.actions().filter((action) => action.startsWith("stage") || action.startsWith("files"))).toEqual([
      `stage ${JSON.stringify({ messageID: "msg_0007", files: false })}`,
    ])
    const frame = await setup.waitForFrame((frame) => linesWith(frame, "Quick question") === 2, { maxPasses: 200 })
    expect(frame).not.toContain("Never mind")
    return
  }
  await Bun.sleep(500)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).not.toContain(listHeading)
  expect(frame).not.toContain("Nothing to rewind yet.")
  expect(frame).not.toContain("Checking files")
  expect(frame).not.toContain("Never mind")
  expect(setup.dryRunsSent()).toEqual([])
  expect(setup.actions()).toEqual(cell.actions ?? [])
})
