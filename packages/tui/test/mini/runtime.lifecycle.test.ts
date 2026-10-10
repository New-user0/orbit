import { expect, test } from "bun:test"
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

async function start(platform: NodeJS.Platform, sessionTitle?: string) {
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
    tuiConfig: createTuiResolvedConfig({}),
    onPermissionReply: () => {},
    onFormReply: () => {},
    onFormCancel: () => {},
  })
  return { app, lifecycle, titles }
}

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
