import { describe, expect, test } from "bun:test"
import { createAttentionEvents, type AttentionEvent } from "../src/attention-events"

// FU-M3-067: the idle reminder is decided from the live state of the dialogs when it is due, and only a root session
// starting (or a key press) ends the idle period.
function setup(input: { pending?: () => boolean } = {}) {
  const reminders: unknown[] = []
  const notices: unknown[] = []
  const events = createAttentionEvents({
    attention: {
      idleReminder: 0.03,
      notify: async (notice) => {
        if (notice.title === "Orbit") reminders.push(notice)
        else notices.push(notice)
        return { ok: true } as never
      },
    },
    session: (sessionID) => (sessionID.startsWith("sub") ? { parentID: "root-b" } : { title: sessionID }),
    pending: input.pending ?? (() => false),
  })
  return { events, reminders, notices }
}

const ended = (sessionID: string): AttentionEvent => ({ type: "session.execution.succeeded", data: { sessionID } })
const started = (sessionID: string): AttentionEvent => ({ type: "session.execution.started", data: { sessionID } })
const wait = () => Bun.sleep(120)

describe("the idle reminder", () => {
  test("fires after a request whose answer was never seen, when the live state has none open", async () => {
    const harness = setup()
    harness.events.handle({ type: "permission.asked", data: { id: "per_1", sessionID: "root-a" } })
    harness.events.handle(ended("root-a"))
    await wait()
    expect(harness.reminders).toHaveLength(1)
    harness.events.dispose()
  })

  test("control: waits while the live state has a request open, at the end and when it is due", async () => {
    let open = true
    const harness = setup({ pending: () => open })
    harness.events.handle(ended("root-a"))
    await wait()
    expect(harness.reminders).toHaveLength(0)

    open = false
    harness.events.handle({ type: "session.execution.started", data: { sessionID: "root-a" } })
    harness.events.handle(ended("root-a"))
    open = true
    await wait()
    expect(harness.reminders).toHaveLength(0)
    harness.events.dispose()
  })

  test("a subagent of another root starting leaves the reminder alone", async () => {
    const harness = setup()
    harness.events.handle(ended("root-a"))
    harness.events.handle(started("sub-1"))
    await wait()
    expect(harness.reminders).toHaveLength(1)
    harness.events.dispose()
  })

  test("control: a root session starting ends the idle period", async () => {
    const harness = setup()
    harness.events.handle(ended("root-a"))
    harness.events.handle(started("root-b"))
    await wait()
    expect(harness.reminders).toHaveLength(0)
    harness.events.dispose()
  })

  test("control: a key press ends the idle period", async () => {
    const harness = setup()
    harness.events.handle(ended("root-a"))
    harness.events.keypress()
    await wait()
    expect(harness.reminders).toHaveLength(0)
    harness.events.dispose()
  })
})
