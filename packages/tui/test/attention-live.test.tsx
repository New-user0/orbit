/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
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
    const started = Date.now()
    const result = await attention.notify({ message: "Permission needs input" })
    expect(result).toMatchObject({ ok: true, bell: true })
    expect(written).toEqual([""])
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
  expect(written).toEqual([""])
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
