import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createTestRenderer } from "@opentui/core/testing"
import { createTuiAttention } from "../src/attention"

type Settings = { bell: boolean; notifications?: boolean; sound?: boolean }

function setup(settings: Settings, idle: () => Promise<void> = async () => {}) {
  const events = new EventEmitter()
  const written: string[] = []
  const renderer = {
    isDestroyed: false,
    on: (event: "focus" | "blur", listener: () => void) => events.on(event, listener),
    off: (event: "focus" | "blur", listener: () => void) => events.off(event, listener),
    triggerNotification: () => true,
    idle,
  }
  const attention = createTuiAttention({
    renderer,
    config: {
      attention: {
        notifications: settings.notifications ?? false,
        sound: settings.sound ?? false,
        bell: settings.bell,
        idle_reminder: 60,
        volume: 0.4,
        sound_pack: "orbit.default",
        sounds: {},
      },
    },
    writeBell: (text) => written.push(text),
  })
  return { attention, events, written, renderer }
}

test("rings the bell only after the renderer is idle", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const harness = setup({ bell: true }, () => gate)
  const pending = harness.attention.notify({ message: "Session done" })
  await Bun.sleep(10)
  expect(harness.written).toEqual([])
  release()
  const result = await pending
  expect(harness.written).toEqual(["\x07"])
  expect(result).toMatchObject({ ok: true, bell: true })
})

test.each([
  ["unknown", undefined, true],
  ["blurred", "blur", true],
  ["focused", "focus", false],
] as const)("with focus %s the bell rings: %p", async (_name, event, rings) => {
  const harness = setup({ bell: true })
  if (event) harness.events.emit(event)
  const result = await harness.attention.notify({ message: "Permission needs input" })
  expect(harness.written).toEqual(rings ? ["\x07"] : [])
  expect(Boolean(result.bell)).toBe(rings)
  if (!rings) expect(result.skipped).toBe("focused")
})

test("stays silent when the bell is off, and for requests that opt out of notifications", async () => {
  const off = setup({ bell: false, sound: false, notifications: true })
  await off.attention.notify({ message: "Session done" })
  const subagent = setup({ bell: true })
  await subagent.attention.notify({ message: "Session done", notification: false })
  expect(off.written).toEqual([])
  expect(subagent.written).toEqual([])
})

test("waits for a real renderer to be idle before it writes", async () => {
  const setupRenderer = await createTestRenderer({ width: 40, height: 10 })
  try {
    const written: string[] = []
    const attention = createTuiAttention({
      renderer: setupRenderer.renderer,
      config: {
        attention: {
          notifications: false,
          sound: false,
          bell: true,
          idle_reminder: 60,
          volume: 0.4,
          sound_pack: "orbit.default",
          sounds: {},
        },
      },
      writeBell: (text) => written.push(text),
    })
    expect(await attention.notify({ message: "Session done" })).toMatchObject({ bell: true })
    expect(written).toEqual(["\x07"])
    attention.dispose()
  } finally {
    setupRenderer.renderer.destroy()
  }
})
