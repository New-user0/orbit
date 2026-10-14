import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createTestRenderer } from "@opentui/core/testing"
import { createTuiAttention } from "../src/attention"

type Settings = { bell: boolean; notifications?: boolean; sound?: boolean; backend?: "terminal" | "system" }

function setup(
  settings: Settings,
  idle: () => Promise<void> = async () => {},
  notifySystem?: (input: { title: string; message: string }) => Promise<boolean>,
) {
  const events = new EventEmitter()
  const written: string[] = []
  const triggered: Array<{ message: string; title?: string }> = []
  const renderer = {
    isDestroyed: false,
    on: (event: "focus" | "blur", listener: () => void) => events.on(event, listener),
    off: (event: "focus" | "blur", listener: () => void) => events.off(event, listener),
    triggerNotification: (message: string, title?: string) => {
      triggered.push({ message, title })
      return true
    },
    idle,
  }
  const attention = createTuiAttention({
    renderer,
    config: {
      attention: {
        notifications: settings.notifications ?? false,
        backend: settings.backend ?? "terminal",
        sound: settings.sound ?? false,
        bell: settings.bell,
        idle_reminder: 60,
        volume: 0.4,
        sound_pack: "orbit.default",
        sounds: {},
      },
    },
    writeBell: (text) => written.push(text),
    notifySystem,
  })
  return { attention, events, written, renderer, triggered }
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
          backend: "terminal",
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

describe("system backend", () => {
  const system = () => {
    const calls: Array<{ title: string; message: string }> = []
    return {
      calls,
      run: async (input: { title: string; message: string }) => {
        calls.push(input)
        return true
      },
    }
  }

  test("shows one operating system notification while blurred, without asking the terminal", async () => {
    const fake = system()
    const harness = setup({ bell: false, notifications: true, backend: "system" }, undefined, fake.run)
    harness.events.emit("blur")
    const result = await harness.attention.notify({ title: "Demo\u001b[31m", message: "Permission\nneeds input" })
    expect(fake.calls).toEqual([{ title: "Demo", message: "Permission needs input" }])
    expect(harness.triggered).toEqual([])
    expect(result).toMatchObject({ ok: true, notification: true })
  })

  test.each(["focus", undefined] as const)("shows nothing while focus is %p", async (event) => {
    const fake = system()
    const harness = setup({ bell: false, notifications: true, backend: "system" }, undefined, fake.run)
    if (event) harness.events.emit(event)
    await harness.attention.notify({ message: "Permission needs input" })
    expect(fake.calls).toEqual([])
    expect(harness.triggered).toEqual([])
  })

  test("falls back to the terminal when the operating system program fails", async () => {
    const harness = setup({ bell: false, notifications: true, backend: "system" }, undefined, async () => false)
    harness.events.emit("blur")
    const result = await harness.attention.notify({ message: "Permission needs input" })
    expect(harness.triggered).toEqual([{ message: "Permission needs input", title: "Orbit" }])
    expect(result).toMatchObject({ notification: true })
  })

  test("leaves the terminal backend alone", async () => {
    const fake = system()
    const harness = setup({ bell: false, notifications: true }, undefined, fake.run)
    harness.events.emit("blur")
    await harness.attention.notify({ message: "Permission needs input" })
    expect(fake.calls).toEqual([])
    expect(harness.triggered).toHaveLength(1)
  })

  test("does not delay the bell while the program runs", async () => {
    let finish!: (shown: boolean) => void
    const slow = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    const harness = setup({ bell: true, notifications: true, backend: "system" }, undefined, () => slow)
    harness.events.emit("blur")
    const pending = harness.attention.notify({ message: "Permission needs input" })
    await Bun.sleep(30)
    expect(harness.written).toEqual(["\x07"])
    finish(true)
    expect(await pending).toMatchObject({ notification: true, bell: true })
  })

  test("runs one program at a time and keeps only the newest waiting request", async () => {
    const started: string[] = []
    let active = 0
    let most = 0
    const releases: Array<() => void> = []
    const harness = setup({ bell: false, notifications: true, backend: "system" }, undefined, (input) => {
      started.push(input.message)
      active++
      most = Math.max(most, active)
      return new Promise<boolean>((resolve) => {
        releases.push(() => {
          active--
          resolve(true)
        })
      })
    })
    harness.events.emit("blur")
    const results = [1, 2, 3, 4, 5].map((n) => harness.attention.notify({ message: `ask ${n}` }))
    await Bun.sleep(20)
    expect(started).toEqual(["ask 1"])
    releases[0]()
    await Bun.sleep(20)
    expect(started).toEqual(["ask 1", "ask 5"])
    releases[1]()
    const settled = await Promise.all(results)
    expect(most).toBe(1)
    expect(settled.map((item) => item.notification)).toEqual([true, false, false, false, true])
    expect(harness.triggered).toEqual([])
  })
})
