import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRenderer } from "@opentui/core"
import { createRuntimeLifecycle } from "../../src/mini/runtime.lifecycle"
import type { MiniHost } from "../../src/mini/types"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const noop = () => () => {}

function host(platform: NodeJS.Platform): MiniHost {
  return {
    version: "test",
    terminal: { stdin: process.stdin },
    platform,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    files: { readText: async () => "" },
    editor: { open: async () => undefined },
    paths: { home: "/home" },
    signals: { sigint: { subscribe: noop }, sigusr2: { subscribe: noop } },
    startup: { showTiming: false, now: () => 0 },
    diagnostics: {},
    preferences: { resolveVariant: async () => undefined, saveVariant: async () => {} },
  }
}

async function start(
  platform: NodeJS.Platform,
  sessionTitle?: string,
  attention?: NonNullable<Parameters<typeof createTuiResolvedConfig>[0]>["attention"],
) {
  const app = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
  })
  const titles: string[] = []
  const setTitle = app.renderer.setTerminalTitle.bind(app.renderer)
  app.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const lifecycle = await createRuntimeLifecycle({
    host: host(platform),
    createRenderer: async () => app.renderer as CliRenderer,
    getDirectory: () => "/project",
    findFiles: async () => [],
    agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
    references: [],
    sessionID: "ses_1",
    sessionTitle,
    first: true,
    history: [],
    agent: "build",
    model: undefined,
    variant: undefined,
    tuiConfig: createTuiResolvedConfig({ attention }),
    onPermissionReply: () => {},
    onFormReply: () => {},
    onFormCancel: () => {},
  })
  const notified: Array<{ message: string; title?: string }> = []
  app.renderer.triggerNotification = (message, title) => {
    notified.push({ message, title })
    return true
  }
  return { app, lifecycle, titles, notified }
}

const asked = (id: string, sessionID = "ses_1") => ({ type: "permission.asked", data: { id, sessionID } })

// The Mini footer reports what it is doing; the lifecycle turns that into the window title (Linux only).
test("the Mini window title follows the footer on Linux, with the title cleaned", async () => {
  const { app, lifecycle, titles } = await start("linux", "Fix bug")
  try {
    expect(titles.at(-1)).toBe("Orbit · Fix bug")
    lifecycle.footer.event({ type: "stream.patch", patch: { phase: "running" } })
    expect(titles.at(-1)).toBe("Orbit · Fix bug · working")
    lifecycle.footer.event({
      type: "stream.view",
      view: {
        type: "form",
        request: {
          id: "form_1",
          sessionID: "ses_1",
          title: "Question",
          fields: [{ key: "authorization", type: "external", url: "https://example.com" }],
        },
      },
    })
    expect(titles.at(-1)).toBe("Orbit · Fix bug · needs input")
    lifecycle.footer.event({ type: "stream.view", view: { type: "prompt" } })
    lifecycle.footer.event({ type: "stream.patch", patch: { phase: "idle" } })
    expect(titles.at(-1)).toBe("Orbit · Fix bug")
    // A hostile title never reaches the terminal with its control bytes.
    lifecycle.setTitle("evil\x07\x1b]0;pwned\x07title")
    expect(titles.at(-1)).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(titles.at(-1)).toContain("evil")
  } finally {
    lifecycle.footer.destroy()
    app.renderer.destroy()
  }
})

test("the hostile session title given at start is cleaned too", async () => {
  const { app, lifecycle, titles } = await start("linux", "a\x07b\x1b]0;x\x07")
  try {
    expect(titles.length).toBeGreaterThan(0)
    for (const title of titles) expect(title).not.toMatch(/[\x00-\x1f\x7f]/)
  } finally {
    lifecycle.footer.destroy()
    app.renderer.destroy()
  }
})

test.each(["win32", "darwin"] as const)("the Mini window title is left alone on %s", async (platform) => {
  const { app, lifecycle, titles } = await start(platform, "Fix bug")
  try {
    lifecycle.footer.event({ type: "stream.patch", patch: { phase: "running" } })
    lifecycle.setTitle("Other")
    expect(titles).toEqual([])
  } finally {
    lifecycle.footer.destroy()
    app.renderer.destroy()
  }
})

describe("attention in Mini", () => {
  test("notifies once for an ask while blurred, and not while focused or when switched off", async () => {
    const blurred = await start("linux", undefined, { notifications: true })
    try {
      blurred.app.renderer.emit("blur")
      blurred.lifecycle.observe?.(asked("perm_1"))
      blurred.lifecycle.observe?.(asked("perm_1"))
      await Bun.sleep(20)
      expect(blurred.notified).toEqual([{ message: "Permission needs input", title: "Orbit" }])
      // A subagent's ask notifies like the root's.
      blurred.lifecycle.observe?.(asked("perm_2", "ses_child"))
      await Bun.sleep(20)
      expect(blurred.notified).toHaveLength(2)
    } finally {
      blurred.lifecycle.footer.destroy()
      blurred.app.renderer.destroy()
    }

    const focused = await start("linux", undefined, { notifications: true })
    try {
      focused.app.renderer.emit("focus")
      focused.lifecycle.observe?.(asked("perm_1"))
      await Bun.sleep(20)
      expect(focused.notified).toEqual([])
    } finally {
      focused.lifecycle.footer.destroy()
      focused.app.renderer.destroy()
    }

    const off = await start("linux", undefined, { notifications: false })
    try {
      off.app.renderer.emit("blur")
      off.lifecycle.observe?.(asked("perm_1"))
      await Bun.sleep(20)
      expect(off.notified).toEqual([])
    } finally {
      off.lifecycle.footer.destroy()
      off.app.renderer.destroy()
    }
  })

  test("titles the notification with the session title the footer last received", async () => {
    const harness = await start("linux", "First", { notifications: true })
    try {
      harness.app.renderer.emit("blur")
      harness.lifecycle.setTitle("Fix the build")
      harness.lifecycle.observe?.(asked("perm_1"))
      await Bun.sleep(20)
      expect(harness.notified).toEqual([{ message: "Permission needs input", title: "Fix the build" }])
    } finally {
      harness.lifecycle.footer.destroy()
      harness.app.renderer.destroy()
    }
  })

  test("cleans a hostile session title before it reaches a notification", async () => {
    const harness = await start("linux", "First", { notifications: true })
    try {
      harness.app.renderer.emit("blur")
      harness.lifecycle.setTitle("Fix‮evil\x1b]0;x\x07 build")
      harness.lifecycle.observe?.(asked("perm_1"))
      await Bun.sleep(20)
      expect(harness.notified.length).toBe(1)
      expect(harness.notified[0].title).toContain("build")
      expect(harness.notified[0].title ?? "").not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/)
    } finally {
      harness.lifecycle.footer.destroy()
      harness.app.renderer.destroy()
    }
  })

  // The footer's open view is what holds the reminder back: wiring `pending` to a constant false sends it anyway.
  test.each(["before the session ends", "after the reminder is scheduled"] as const)(
    "an open form view held %s keeps the idle reminder from being sent",
    async (when) => {
      const harness = await start("linux", undefined, { notifications: true, idle_reminder: 0.1 })
      try {
        harness.app.renderer.emit("blur")
        const form = () =>
          harness.lifecycle.footer.event({
            type: "stream.view",
            view: {
              type: "form",
              request: { id: "form_1", sessionID: "ses_1", title: "Question", fields: [{ key: "a", type: "text" }] },
            } as never,
          })
        if (when === "before the session ends") form()
        harness.lifecycle.observe?.({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
        if (when === "after the reminder is scheduled") form()
        await Bun.sleep(400)
        expect(harness.notified.map((item) => item.message)).toEqual(["Session done"])

        // Control: with the view closed the same ending sends the reminder.
        harness.lifecycle.footer.event({ type: "stream.view", view: { type: "prompt" } })
        harness.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_1" } })
        harness.lifecycle.observe?.({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
        await Bun.sleep(400)
        expect(harness.notified.map((item) => item.message)).toEqual([
          "Session done",
          "Session done",
          "The session has stopped and the next step is yours",
        ])
      } finally {
        harness.lifecycle.footer.destroy()
        harness.app.renderer.destroy()
      }
    },
  )

  test("the idle reminder fires once after the configured seconds and a keypress cancels it", async () => {
    const harness = await start("linux", undefined, { notifications: true, idle_reminder: 0.05 })
    try {
      harness.app.renderer.emit("blur")
      const done = { type: "session.execution.succeeded", data: { sessionID: "ses_1" } }
      harness.lifecycle.observe?.(done)
      await Bun.sleep(300)
      expect(harness.notified.map((item) => item.message)).toEqual(["Session done", "The session has stopped and the next step is yours"])

      harness.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_1" } })
      harness.lifecycle.observe?.(done)
      harness.app.renderer.keyInput.emit("keypress", { name: "a" } as never)
      await Bun.sleep(300)
      expect(harness.notified.map((item) => item.message)).toEqual([
        "Session done",
        "The session has stopped and the next step is yours",
        "Session done",
      ])
    } finally {
      harness.lifecycle.footer.destroy()
      harness.app.renderer.destroy()
    }
  })
})

// clients-ux-27: Mini is an interactive client too, so it asks for the away summary as the full TUI does: when focus
// has been gone for session.recap.after_minutes, not before the session's turn is over, and never once the person is
// back. The server decides whether a recap is due, so Mini sends only the request.
describe("away summary in Mini", () => {
  async function recapHarness(afterMinutes = 0.001, answer?: () => Promise<void>) {
    const app = await createTestRenderer({
      width: 100,
      height: 24,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
    })
    const asked: AbortSignal[] = []
    const lifecycle = await createRuntimeLifecycle({
      host: host("linux"),
      createRenderer: async () => app.renderer as CliRenderer,
      getDirectory: () => "/project",
      findFiles: async () => [],
      agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
      references: [],
      sessionID: "ses_1",
      first: true,
      history: [],
      agent: "build",
      model: undefined,
      variant: undefined,
      tuiConfig: createTuiResolvedConfig({ session: { recap: { after_minutes: afterMinutes } } }),
      onPermissionReply: () => {},
      onFormReply: () => {},
      onFormCancel: () => {},
      recap: (signal: AbortSignal) => {
        asked.push(signal)
        return answer ? answer() : new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()))
      },
    })
    return {
      app,
      lifecycle,
      asked,
      [Symbol.dispose]() {
        lifecycle.footer.destroy()
        app.renderer.destroy()
      },
    }
  }

  test("asks once after the delay and drops the request when the person comes back", async () => {
    using harness = await recapHarness()
    harness.app.renderer.emit("blur")
    const deadline = Date.now() + 3000
    while (harness.asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(harness.asked).toHaveLength(1)
    harness.app.renderer.emit("focus")
    expect(harness.asked[0]?.aborted).toBe(true)
  })

  test("closing Mini drops a request in flight", async () => {
    const harness = await recapHarness()
    harness.app.renderer.emit("blur")
    const deadline = Date.now() + 3000
    while (harness.asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(harness.asked).toHaveLength(1)
    await harness.lifecycle.close({ showExit: false })
    expect(harness.asked[0]?.aborted).toBe(true)
  })

  test("a subagent's turn neither holds the request nor ends Mini's own turn", async () => {
    {
      using harness = await recapHarness()
      harness.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_1" } })
      harness.app.renderer.emit("blur")
      await Bun.sleep(400)
      harness.lifecycle.observe?.({ type: "session.execution.succeeded", data: { sessionID: "ses_child" } })
      await Bun.sleep(100)
      expect(harness.asked).toHaveLength(0)
    }
    {
      using harness = await recapHarness()
      harness.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_child" } })
      harness.app.renderer.emit("blur")
      const deadline = Date.now() + 3000
      while (harness.asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect(harness.asked).toHaveLength(1)
    }
  })

  test("waits for the turn's end, asks nothing while focus is unknown, and 0 turns it off", async () => {
    // A turn that fails or is interrupted while the person is away ends it as surely as one that succeeds.
    const ends = [
      { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
      { type: "session.execution.failed", data: { sessionID: "ses_1", error: { message: "The provider is unavailable" } } },
      { type: "session.execution.interrupted", data: { sessionID: "ses_1" } },
    ] as const
    for (const end of ends) {
      using harness = await recapHarness()
      harness.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_1" } })
      harness.app.renderer.emit("blur")
      await Bun.sleep(400)
      expect(harness.asked).toHaveLength(0)
      harness.lifecycle.observe?.(end)
      const deadline = Date.now() + 3000
      while (harness.asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect({ end: end.type, asked: harness.asked.length }).toEqual({ end: end.type, asked: 1 })
    }
    {
      using harness = await recapHarness()
      await Bun.sleep(400)
      expect(harness.asked).toHaveLength(0)
    }
    {
      using harness = await recapHarness(0)
      harness.app.renderer.emit("blur")
      await Bun.sleep(400)
      expect(harness.asked).toHaveLength(0)
    }
  })

  // A session another client is running when Mini attaches sends no execution.started for Mini to see, so the status
  // read when the session loads holds the request until the turn ends.
  test("attaching to a session mid-turn holds the request until the turn ends", async () => {
    {
      using harness = await recapHarness()
      harness.lifecycle.setRunning?.(true)
      harness.app.renderer.emit("blur")
      await Bun.sleep(400)
      expect(harness.asked).toHaveLength(0)
      harness.lifecycle.observe?.({ type: "session.execution.succeeded", data: { sessionID: "ses_1" } })
      const deadline = Date.now() + 3000
      while (harness.asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect(harness.asked).toHaveLength(1)
    }
    {
      // A reload that finds the turn over (it ended while Mini was disconnected) sends the held request.
      using harness = await recapHarness()
      harness.lifecycle.setRunning?.(true)
      harness.app.renderer.emit("blur")
      await Bun.sleep(400)
      expect(harness.asked).toHaveLength(0)
      harness.lifecycle.setRunning?.(false)
      const deadline = Date.now() + 3000
      while (harness.asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect(harness.asked).toHaveLength(1)
    }
  })

  // Class 13: a refused recap (an untrusted folder, a server that is gone) is silent, as the reference's failures are.
  test("a refused recap shows nothing and leaves Mini running", async () => {
    using harness = await recapHarness(0.001, () => Promise.reject(new Error("UntrustedFolderError")))
    harness.app.renderer.emit("blur")
    const deadline = Date.now() + 3000
    while (harness.asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(harness.asked).toHaveLength(1)
    await Bun.sleep(100)
    expect(harness.app.renderer.isDestroyed).toBe(false)
  })
})
