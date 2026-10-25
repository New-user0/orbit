import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"
import { conversation, linesWith, listHeading, rewindApp, sessionID, until } from "./fixture/rewind"

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

// The controls: one Esc, two Esc presses further apart than the double-press window, and two quick ones while the
// prompt holds text, open nothing.
test("Esc once, Esc twice slowly, or Esc twice over a typed prompt does not open the picker", async () => {
  await using state = await tmpdir()
  await using setup = await rewindApp({ state: state.path })
  await setup.waitForFrame(loaded)
  setup.mockInput.pressEscape()
  await Bun.sleep(1000)
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
// messages, and one whose queued prompt waits in the inbox (Esc twice belongs to the picker only when none holds).
const queued = { id: "msg_queued", type: "user", delivery: "queue", payload: { text: "Later" }, time: { created: 5 } }
test.each([
  { label: "over a typed prompt", messages: undefined, inbox: [], typed: "draft", ready: "Renamed it." },
  { label: "in a session with no messages", messages: [] as unknown[], inbox: [], typed: "", ready: "Rewind fixture" },
  { label: "while a queued prompt waits", messages: undefined, inbox: [queued], typed: "", ready: "Renamed it." },
])("Esc twice $label does not open the picker", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    messages: row.messages,
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
