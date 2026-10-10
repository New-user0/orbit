/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { StatusLine, type StatusLineBus } from "../../../src/component/prompt/status-line"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function setup(options: { sessionID?: string; colors?: boolean; outputs: string[] }) {
  const handlers = new Map<string, Array<(event: { data: { sessionID: string } }) => void>>()
  const bus: StatusLineBus = (type, handler) => {
    handlers.set(type, [...(handlers.get(type) ?? []), handler])
    return () =>
      handlers.set(
        type,
        (handlers.get(type) ?? []).filter((item) => item !== handler),
      )
  }
  const [model, setModel] = createSignal("m1")
  const runs = { count: 0 }
  return {
    handlers,
    emit: (type: string, sessionID: string) =>
      handlers.get(type)?.forEach((handler) => handler({ data: { sessionID } })),
    setModel,
    runs,
    element: () => (
      <StatusLine
        sessionID={options.sessionID}
        command={() => "status"}
        interval={() => 60_000}
        colors={() => options.colors}
        payload={() => ({})}
        on={bus}
        watch={() => [model()]}
        fg={RGBA.fromHex("#808080")}
        run={async () => options.outputs[Math.min(runs.count++, options.outputs.length - 1)]}
      />
    ),
  }
}

async function draw(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  return app.captureCharFrame()
}

test("an emitted step end of this session changes the drawn line, and another session's does not", async () => {
  const test = setup({ sessionID: "ses_1", outputs: ["first\n", "second\n", "third\n"] })
  const app = await testRender(test.element, { width: 30, height: 2 })
  try {
    await wait(50)
    expect(await draw(app)).toContain("first")
    test.emit("session.step.ended", "ses_other")
    await wait(450)
    expect(await draw(app)).toContain("first")
    test.emit("session.step.ended", "ses_1")
    await wait(450)
    const frame = await draw(app)
    expect(frame).toContain("second")
    expect(frame).not.toContain("first")
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  "session.step.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])("%s refreshes the line, on the home screen for any session", async (type) => {
  const test = setup({ outputs: ["before\n", "after\n"] })
  const app = await testRender(test.element, { width: 30, height: 2 })
  try {
    await wait(50)
    expect(await draw(app)).toContain("before")
    test.emit(type, "ses_any")
    await wait(450)
    expect(await draw(app)).toContain("after")
  } finally {
    app.renderer.destroy()
  }
})

test("a change of what the line watches (the selected model) refreshes it", async () => {
  const test = setup({ sessionID: "ses_1", outputs: ["before\n", "after\n"] })
  const app = await testRender(test.element, { width: 30, height: 2 })
  try {
    await wait(50)
    expect(await draw(app)).toContain("before")
    test.setModel("m2")
    await wait(450)
    expect(await draw(app)).toContain("after")
  } finally {
    app.renderer.destroy()
  }
})

test("unmounting removes the event subscriptions", async () => {
  const test = setup({ sessionID: "ses_1", outputs: ["x\n"] })
  const app = await testRender(test.element, { width: 30, height: 2 })
  await wait(50)
  expect([...test.handlers.values()].flat().length).toBe(5)
  app.renderer.destroy()
  await wait(50)
  expect([...test.handlers.values()].flat().length).toBe(0)
})

// The Private Use Area (Powerline, Nerd Font) and the zero-width joiner are the status line's usual glyphs and are drawn.
test.each([
  ["U+E0A0 Powerline branch", "\u{e0a0}"],
  ["U+E0B0 Powerline arrow", "\u{e0b0}"],
  ["U+F0001 supplementary Private Use Area", "\u{f0001}"],
  ["emoji sequence with U+200D", "\u{1f468}\u{200d}\u{1f4bb}"],
])("%s is drawn unchanged, with colors on and off", async (_name, glyph) => {
  for (const colors of [true, false]) {
    const test = setup({ colors, outputs: [`main ${glyph} ok\n`] })
    const app = await testRender(test.element, { width: 40, height: 2 })
    try {
      await wait(50)
      const frame = await draw(app)
      expect(frame).toContain(glyph)
      expect(frame).not.toContain("\\u{")
    } finally {
      app.renderer.destroy()
    }
  }
})

test("colors are drawn only when status_line.colors is on", async () => {
  const red = RGBA.fromHex("#cd0000")
  const spansOf = async (colors: boolean) => {
    const test = setup({ colors, outputs: ["\u001b[31mred\u001b[0m plain\n"] })
    const app = await testRender(test.element, { width: 30, height: 2 })
    try {
      await wait(50)
      await app.renderOnce()
      const line = app.renderer.currentRenderBuffer.getSpanLines()[0]!
      return line.spans.filter((span) => span.text.includes("red"))
    } finally {
      app.renderer.destroy()
    }
  }
  const on = await spansOf(true)
  expect(on.length).toBeGreaterThan(0)
  expect(on.every((span) => span.fg.equals(red))).toBeTrue()
  const off = await spansOf(false)
  expect(off.length).toBeGreaterThan(0)
  expect(off.some((span) => span.fg.equals(red))).toBeFalse()
})

// Class 9: what a repository can put in a branch name or session title reaches the script and comes back to the frame.
test.each([
  ["U+202E right-to-left override", "\u{202e}", "\\u{202e}"],
  ["U+200B zero-width space", "\u{200b}", "\\u{200b}"],
  ["U+2066 isolate", "\u{2066}", "\\u{2066}"],
  ["escape sequence (title change)", "\u001b]0;pwned\u0007", ""],
  ["ordinary text (control)", "", ""],
])("%s is not drawn raw, with colors on and off", async (_name, char, written) => {
  for (const colors of [true, false]) {
    const test = setup({ colors, outputs: [`main${char}txt.exe\n`] })
    const app = await testRender(test.element, { width: 40, height: 2 })
    try {
      await wait(50)
      const frame = await draw(app)
      expect(frame).toContain(`main${written}txt.exe`)
      expect(frame).not.toContain(char || "\u0000")
    } finally {
      app.renderer.destroy()
    }
  }
})
