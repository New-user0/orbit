/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { createTuiAttention } from "../src/attention"

const config = {
  attention: {
    notifications: false,
    sound: false,
    bell: true,
    idle_reminder: 60,
    volume: 0.4,
    sound_pack: "orbit.default",
    sounds: {},
  },
}

// A busy session in another tab keeps its tab pulse live, which keeps the renderer running and never idle.
test("the bell rings between frames while a live tab pulse keeps the renderer running", async () => {
  const { TabPulse } = await import("../src/component/tab-pulse")
  const color = RGBA.fromHex("#ffcc00")
  const app = await testRender(() => <TabPulse active color={color} backgroundColor={RGBA.fromHex("#101010")} />, {
    width: 8,
    height: 1,
  })
  try {
    await app.renderOnce()
    expect(app.renderer.root.liveCount).toBe(1)
    expect(app.renderer.isRunning).toBe(true)
    const written: string[] = []
    const attention = createTuiAttention({ renderer: app.renderer, config, writeBell: (text) => written.push(text) })
    // Count frames drawn after notify starts; the bell must not be written before the first one.
    let frames = 0
    app.renderer.on("frame", () => frames++)
    let framesAtWrite = -1
    const attention2 = createTuiAttention({
      renderer: app.renderer,
      config,
      writeBell: () => {
        framesAtWrite = frames
      },
    })
    await attention2.notify({ message: "Permission needs input" })
    expect(framesAtWrite).toBeGreaterThanOrEqual(1)
    attention2.dispose()
    const started = Date.now()
    const result = await attention.notify({ message: "Permission needs input" })
    expect(result).toMatchObject({ ok: true, bell: true })
    expect(written).toEqual(["\x07"])
    expect(Date.now() - started).toBeLessThan(1000)
    attention.dispose()
  } finally {
    app.renderer.destroy()
  }
})

// A frame is pending when a live animation starts: idle() would never resolve, so the next frame must end the wait.
test("the bell rings when a pending frame starts a live animation", async () => {
  const { TabPulse } = await import("../src/component/tab-pulse")
  const [active, setActive] = createSignal(false)
  const app = await testRender(
    () => <TabPulse active={active()} color={RGBA.fromHex("#ffcc00")} backgroundColor={RGBA.fromHex("#101010")} />,
    { width: 8, height: 1 },
  )
  try {
    await app.renderOnce()
    const written: string[] = []
    const attention = createTuiAttention({ renderer: app.renderer, config, writeBell: (text) => written.push(text) })
    app.renderer.requestRender()
    const result = attention.notify({ message: "Permission needs input" })
    setActive(true)
    const started = Date.now()
    await result
    expect(written).toEqual(["\x07"])
    expect(Date.now() - started).toBeLessThan(1000)
    attention.dispose()
  } finally {
    app.renderer.destroy()
  }
})

// The idle reminder asks for a bell only while the terminal is blurred; a terminal that never reports focus is not blurred.
test("the idle reminder's options ring only a blurred terminal", async () => {
  // notifications.test.ts pins that the plugin sends exactly these options.
  const options = {
    title: "Orbit",
    message: "Orbit is waiting for your input",
    notification: { when: "blurred" as const },
    sound: { name: "default" as const, when: "blurred" as const },
    bell: { when: "blurred" as const },
  }
  const listeners = new Map<string, () => void>()
  const written: string[] = []
  const attention = createTuiAttention({
    renderer: {
      isDestroyed: false,
      on: (event, listener) => listeners.set(event, listener),
      off: () => {},
      triggerNotification: () => true,
      idle: async () => {},
    },
    config,
    writeBell: (text) => written.push(text),
  })
  expect(await attention.notify(options)).toMatchObject({ ok: false, skipped: "focus_unknown" })
  expect(written).toEqual([])
  listeners.get("focus")?.()
  expect(await attention.notify(options)).toMatchObject({ ok: false, skipped: "focused" })
  listeners.get("blur")?.()
  expect(await attention.notify(options)).toMatchObject({ ok: true, bell: true })
  expect(written).toEqual(["\x07"])
  // Without the request option, unknown focus still rings.
  const fresh = createTuiAttention({
    renderer: {
      isDestroyed: false,
      on: () => {},
      off: () => {},
      triggerNotification: () => true,
      idle: async () => {},
    },
    config,
    writeBell: (text) => written.push(text),
  })
  expect(await fresh.notify({ message: "Session done" })).toMatchObject({ bell: true })
})
