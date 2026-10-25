/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@orbit/plugin/tui/context"
import { createSignal } from "solid-js"
import { PromptFooter } from "../../src/feature-plugins/prompt/footer"

test("prompt footer separates simultaneous subagent, shell, and usage status", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const subdued = RGBA.fromInts(100, 100, 100)
  const dispatched: string[] = []
  const context = {
    location: { directory: "/workspace" },
    theme: {
      text: {
        base: color,
        muted: subdued,
        feedback: { success: { base: color } },
      },
    },
    keymap: {
      shortcuts: (id: string) =>
        id === "session.child.first" ? ["ctrl+j"] : id === "command.palette.show" ? ["ctrl+p"] : [],
      dispatch: (id: string) => dispatched.push(id),
    },
    data: {
      session: {
        family: () => ["session", "child"],
        status: (id: string) => (id === "child" ? "running" : "idle"),
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 1,
        context: () => undefined,
        message: { list: () => [] },
      },
      shell: {
        list: () => [{ metadata: { sessionID: "session" } }],
      },
      location: {
        model: { list: () => [] },
      },
    },
  } as unknown as Context
  const app = await testRender(
    () => <PromptFooter context={context} sessionID="session" mode="normal" showDetails={true} />,
    {
      width: 80,
      height: 2,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("● 1 agent · 1 shell · $1.00")
    expect(app.captureCharFrame()).toContain("ctrl+p commands")

    await app.mockMouse.moveTo(2, 0)
    const live = app.renderer.root.getChildren()[0]?.getChildren()[0]?.getChildren()[0]
    expect(live).toBeInstanceOf(TextRenderable)
    expect((live as TextRenderable).fg.toInts()).toEqual(color.toInts())

    await app.mockMouse.click(2, 0)
    expect(dispatched).toEqual(["agent.map"])
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer can hide details", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const context = {
    location: { directory: "/workspace" },
    theme: {
      text: {
        base: color,
        muted: color,
      },
    },
    keymap: {
      shortcuts: (id: string) => {
        if (id === "command.palette.show") return ["ctrl+p"]
        if (id === "agent.cycle") return ["shift+tab"]
        return []
      },
    },
    data: {
      session: {
        family: () => ["session"],
        status: () => "running",
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 1,
        context: () => undefined,
        message: {
          list: () => [
            {
              id: "message",
              type: "assistant",
              model: { providerID: "provider", id: "model" },
              tokens: { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        },
      },
      shell: { list: () => [] },
      location: {
        model: { list: () => [{ providerID: "provider", id: "model", limit: { context: 10_000 } }] },
      },
    },
  } as unknown as Context
  const [showDetails, setShowDetails] = createSignal(true)
  const [sessionID, setSessionID] = createSignal<string | undefined>("session")
  const app = await testRender(
    () => (
      <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
        <PromptFooter context={context} sessionID={sessionID()} mode="normal" showDetails={showDetails()} />
      </box>
    ),
    {
      width: 80,
      height: 1,
    },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("▮▯▯▯▯▯▯▯ 10% · $1.00")
    expect(app.captureCharFrame()).toContain("ctrl+p commands")

    setShowDetails(false)
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).not.toContain("▮▯▯▯▯▯▯▯ 10%")
    expect(frame).not.toContain("$1.00")
    expect(frame).not.toContain("ctrl+p commands")

    setSessionID(undefined)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("shift+tab agents")
  } finally {
    app.renderer.destroy()
  }
})

test("prompt footer offers the agent and command shortcuts when nothing is running", async () => {
  const color = RGBA.fromInts(200, 200, 200)
  const context = {
    location: { directory: "/workspace" },
    theme: { text: { base: color, muted: color } },
    keymap: {
      shortcuts: (id: string) => {
        if (id === "command.palette.show") return ["ctrl+p"]
        if (id === "agent.cycle") return ["shift+tab"]
        return []
      },
    },
    data: {
      session: {
        family: () => ["session"],
        status: () => "idle",
        get: () => ({ id: "session", location: { directory: "/workspace" } }),
        cost: () => 0,
        context: () => undefined,
        message: { list: () => [] },
      },
      shell: { list: () => [] },
      location: { model: { list: () => [] } },
    },
  } as unknown as Context
  const app = await testRender(
    () => (
      <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
        <PromptFooter context={context} sessionID="session" mode="normal" showDetails={true} />
      </box>
    ),
    { width: 80, height: 1 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("shift+tab agents")
    expect(app.captureCharFrame()).toContain("ctrl+p commands")
  } finally {
    app.renderer.destroy()
  }
})

// The context line is the only footer output decided by a report. This file imports the footer directly, so the line's
// branches run in the module instance that a merged parallel coverage run keeps for it.
test("prompt footer draws the context line in the color of its state and hides it for a staged revert", async () => {
  const muted = RGBA.fromInts(100, 100, 100)
  const warning = RGBA.fromInts(220, 180, 40)
  const error = RGBA.fromInts(220, 40, 40)
  const base = RGBA.fromInts(200, 200, 200)
  const make = (input: { auto: boolean; state: string; percentLeft: number }) => ({
    sessionID: "session",
    used: 1,
    window: 1,
    threshold: 1,
    paused: false,
    stale: false,
    ...input,
  })
  const [current, setCurrent] = createSignal<ReturnType<typeof make> | undefined>()
  const [revert, setRevert] = createSignal<{ messageID: string } | undefined>()
  const context = {
    location: { directory: "/workspace" },
    theme: { text: { base, muted, feedback: { warning: { base: warning }, error: { base: error } } } },
    keymap: { shortcuts: () => [] },
    data: {
      session: {
        family: () => ["session"],
        status: () => "idle",
        get: () => ({ id: "session", location: { directory: "/workspace" }, revert: revert() }),
        cost: () => 0,
        context: () => current(),
        message: { list: () => [] },
      },
      shell: { list: () => [] },
      location: { model: { list: () => [] } },
    },
  } as unknown as Context
  const app = await testRender(
    () => (
      <box width="100%" flexDirection="row" gap={2}>
        <PromptFooter context={context} sessionID="session" mode="normal" showDetails={true} />
      </box>
    ),
    { width: 80, height: 1 },
  )
  const colorOf = () => {
    const text = app.renderer.root.getChildren()[0]?.getChildren()[0]
    expect(text).toBeInstanceOf(TextRenderable)
    return (text as TextRenderable).fg.toInts()
  }

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("left")

    setCurrent(make({ auto: true, state: "warning", percentLeft: 9 }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("9% left before auto-compaction")
    expect(colorOf()).toEqual(muted.toInts())

    setCurrent(make({ auto: false, state: "warning", percentLeft: 8 }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Context almost full (8% left) · run /compact")
    expect(colorOf()).toEqual(warning.toInts())

    setCurrent(make({ auto: false, state: "error", percentLeft: 2 }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Context almost full (2% left) · run /compact")
    expect(colorOf()).toEqual(error.toInts())

    setCurrent(make({ auto: false, state: "ok", percentLeft: 60 }))
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("left")

    setCurrent(make({ auto: false, state: "error", percentLeft: 2 }))
    setRevert({ messageID: "message" })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Context almost full")
  } finally {
    app.renderer.destroy()
  }
})
