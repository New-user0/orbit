import { expect, test } from "bun:test"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"
import { conversation, linesWith, listHeading, rewindApp, until } from "./fixture/rewind"

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
  { label: "in a session with no messages", messages: [], inbox: [], typed: "", ready: "Rewind fixture" },
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

const openFromTimeline = async (setup: Awaited<ReturnType<typeof rewindApp>>, prompt: string) => {
  await setup.mockInput.typeText("/timeline")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Timeline"))
  await setup.mockInput.typeText(prompt)
  await setup.waitForFrame((frame) => frame.includes(prompt))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Message Actions"))
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
// goes straight back into the input with its conversation rewound. The control is the same prompt when the dry run
// says a file would change: step 2 opens and nothing is rewound yet.
test.each([
  { label: "no file would change", filesChanged: [], shortcut: true },
  { label: "a file would change", filesChanged: ["/tmp/orbit/packages/tui/src/quick.ts"], shortcut: false },
])("the message dialog rewinds at once when only an empty reply follows and $label", async (row) => {
  await using state = await tmpdir()
  await using setup = await rewindApp({
    state: state.path,
    messages: [...conversation, quick, reply([], true)],
    answer: (request) =>
      request.path.endsWith("/revert/files") && request.body?.dryRun && request.body.messageID === "msg_0007"
        ? json({ data: { canRewind: true, filesChanged: row.filesChanged, insertions: 0, deletions: 1 } })
        : undefined,
  })
  await setup.waitForFrame(loaded)
  await setup.waitForFrame((frame) => frame.includes("Quick question"))
  await openFromTimeline(setup, "Quick question")

  if (!row.shortcut) {
    const frame = await setup.waitForFrame((frame) => frame.includes("Code and conversation"))
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
  await setup.waitForFrame((frame) => frame.includes("Quick question"))
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
