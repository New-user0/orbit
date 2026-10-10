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

  test("the idle reminder fires once after the configured seconds and a keypress cancels it", async () => {
    const harness = await start("linux", undefined, { notifications: true, idle_reminder: 0.05 })
    try {
      harness.app.renderer.emit("blur")
      const done = { type: "session.execution.succeeded", data: { sessionID: "ses_1" } }
      harness.lifecycle.observe?.(done)
      await Bun.sleep(300)
      expect(harness.notified.map((item) => item.message)).toEqual(["Session done", "Orbit is waiting for your input"])

      harness.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_1" } })
      harness.lifecycle.observe?.(done)
      harness.app.renderer.keyInput.emit("keypress", { name: "a" } as never)
      await Bun.sleep(300)
      expect(harness.notified.map((item) => item.message)).toEqual([
        "Session done",
        "Orbit is waiting for your input",
        "Session done",
      ])
    } finally {
      harness.lifecycle.footer.destroy()
      harness.app.renderer.destroy()
    }
  })
})
