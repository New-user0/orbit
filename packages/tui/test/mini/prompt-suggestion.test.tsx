/** @jsxImportSource @opentui/solid */
// clients-ux-37 part 2: Mini draws a held next-prompt suggestion as dimmed text in its empty prompt, and Tab, Right and
// Enter take exactly the escaped text it draws (classes 8 and 9).
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { plain } from "@orbit/util/plain"
import { Keymap } from "../../src/context/keymap"
import { resolve } from "../../src/config"
import { RunFooterView } from "../../src/mini/footer.view"
import { RUN_THEME_FALLBACK } from "../../src/mini/theme"
import type { FooterState, FooterSubagentState, FooterView, RunPrompt } from "../../src/mini/types"

const suggestion = "run the tests"

async function render(text: string, width = 100, options: { phase?: FooterState["phase"]; subagent?: boolean } = {}) {
  const [state] = createSignal<FooterState>({
    phase: options.phase ?? "idle",
    status: "",
    notice: "",
    model: "gpt-5",
    usage: undefined,
    first: false,
    interrupt: 0,
    exit: 0,
  })
  const [view] = createSignal<FooterView>({ type: "prompt" })
  const [subagents] = createSignal<FooterSubagentState>({
    tabs: options.subagent
      ? [{ sessionID: "subagent-1", label: "Explore", description: "Inspect the keymap", status: "running" }]
      : [],
    details: {},
    permissions: [],
    forms: [],
  })
  const [held, setHeld] = createSignal<string | undefined>(text)
  const config = resolve({ keybinds: { "prompt.editor": "none" } }, { terminalSuspend: true })
  const submitted: RunPrompt[] = []
  const events: string[] = []

  function Harness() {
    return (
      <Keymap.Provider config={config}>
        <RunFooterView
          directory={() => "/tmp"}
          findFiles={async () => []}
          agents={() => []}
          references={() => []}
          commands={() => []}
          providers={() => undefined}
          currentAgent={() => "Build"}
          currentAgentID={() => "build"}
          currentModel={() => undefined}
          variants={() => []}
          currentVariant={() => undefined}
          state={state}
          view={view}
          subagent={subagents}
          theme={() => RUN_THEME_FALLBACK}
          tuiConfig={config}
          miniSettings={() => ({
            thinking: "hide",
            tools: "show",
            shell_output: "hide",
            turn_summary: "show",
            footer: "show",
            splash: "show",
            work_spinner: "block-soft-slide",
            mono: false,
          })}
          mono={false}
          suggestion={{
            text: held,
            changed: () => events.push("changed"),
            submitted: () => {
              events.push("submitted")
              setHeld(undefined)
            },
          }}
          onSubmit={(prompt) => {
            submitted.push(prompt)
            return true
          }}
          onPermissionReply={() => {}}
          onFormReply={() => {}}
          onFormCancel={() => {}}
          onCycle={() => {}}
          onInterrupt={() => false}
          onEditorOpen={async () => undefined}
          onInputClear={() => {}}
          onExit={() => {}}
          onAgentSelect={() => {}}
          onModelSelect={() => {}}
          onVariantSelect={() => {}}
          onRows={() => {}}
          onLayout={() => {}}
          onStatus={() => {}}
          onMiniSettingChange={() => {}}
        />
      </Keymap.Provider>
    )
  }

  const app = await testRender(() => <Harness />, { width, height: 8, kittyKeyboard: true })
  const settle = async () => {
    await app.renderOnce()
    await Bun.sleep(20)
    await app.renderOnce()
  }
  await settle()
  return {
    app,
    submitted,
    events,
    settle,
    text: () => app.renderer.currentFocusedEditor?.plainText,
    async [Symbol.asyncDispose]() {
      app.renderer.currentFocusedRenderable?.blur()
      app.renderer.currentFocusedEditor?.blur()
      app.renderer.destroy()
    },
  }
}

const spellings = [
  { name: "plain text", text: "run the tests" },
  { name: "CSI", text: "\x1b[2Jrun the tests" },
  { name: "OSC with BEL", text: "\x1b]0;owned\x07run the tests" },
  { name: "U+009B", text: "\u009b2Jrun the tests" },
  { name: "U+202E", text: "run the ‮tests" },
  { name: "U+200B", text: "run​ the tests" },
  { name: "CR", text: "run the tests\rrm -rf ~" },
  { name: "LF", text: "run the tests\nrm -rf ~" },
]
const raw = /[\x00-\x08\x0b-\x1f\x7f-\x9f​‮]/

test.each(spellings)("the ghost text is drawn escaped: $name", async ({ text }) => {
  await using footer = await render(text)
  const frame = footer.app.captureCharFrame()
  expect(frame).toContain(plain(text))
  expect(frame).not.toMatch(raw)
  expect(footer.text()).toBe("")
})

const keys = [
  { key: "Tab", press: (footer: Awaited<ReturnType<typeof render>>) => footer.app.mockInput.pressTab() },
  { key: "Right", press: (footer: Awaited<ReturnType<typeof render>>) => footer.app.mockInput.pressArrow("right") },
  { key: "Enter", press: (footer: Awaited<ReturnType<typeof render>>) => footer.app.mockInput.pressEnter() },
]

test.each(keys.flatMap((key) => spellings.map((spelling) => ({ ...key, ...spelling }))))(
  "$key takes the drawn text: $name",
  async ({ key, press, text }) => {
    await using footer = await render(text)
    expect(footer.app.captureCharFrame()).toContain(plain(text))
    press(footer)
    await footer.settle()
    if (key === "Enter") {
      expect(footer.submitted.map((prompt) => prompt.text)).toEqual([plain(text)])
      expect(footer.submitted[0]?.mode).toBeUndefined()
      expect(footer.events).toContain("submitted")
      return
    }
    expect(footer.text()).toBe(plain(text))
    expect(footer.submitted).toEqual([])
  },
)

test("a ghost cut to the row is filled by Enter, not sent", async () => {
  const long = "please run every test in the package again and then tell me about each failure you find"
  await using footer = await render(long, 40)
  const frame = footer.app.captureCharFrame()
  expect(frame).toContain("please run every")
  expect(frame).not.toContain("each failure you find")
  footer.app.mockInput.pressEnter()
  await footer.settle()
  expect(footer.submitted).toEqual([])
  expect(footer.text()).toBe(long)
  footer.app.mockInput.pressEnter()
  await footer.settle()
  expect(footer.submitted.map((prompt) => prompt.text)).toEqual([long])
})

test("Enter sends a suggestion only when the whole of it fits the input row", async () => {
  // The row's width as drawn: the longest start of a long suggestion that the frame shows.
  const digits = "0123456789".repeat(9)
  const width = await (async () => {
    await using footer = await render(digits, 40)
    const frame = footer.app.captureCharFrame()
    const shown = [...digits]
      .map((_, index) => digits.length - index)
      .find((length) => frame.includes(digits.slice(0, length)))
    // The ghost is cut where the input's own text area ends, not before it.
    expect(shown).toBe(footer.app.renderer.currentFocusedEditor?.width)
    return shown!
  })()
  expect(width).toBeGreaterThan(10)
  expect(width).toBeLessThan(40)
  // A suggestion that fills the row is sent; one a cell wider is put in the input to be read first.
  for (const row of [
    { length: width, sent: true },
    { length: width + 1, sent: false },
  ]) {
    const text = digits.slice(0, row.length)
    await using footer = await render(text, 40)
    expect(footer.app.captureCharFrame()).toContain(digits.slice(0, width))
    footer.app.mockInput.pressEnter()
    await footer.settle()
    expect({ length: row.length, sent: footer.submitted.map((prompt) => prompt.text) }).toEqual({
      length: row.length,
      sent: row.sent ? [text] : [],
    })
    if (!row.sent) expect(footer.text()).toBe(text)
  }
})

test("shell mode draws no ghost and Enter sends no suggestion", async () => {
  await using footer = await render(suggestion)
  // Control: the ghost is drawn in normal mode.
  expect(footer.app.captureCharFrame()).toContain(suggestion)
  footer.app.mockInput.pressKey("!")
  await footer.settle()
  expect(footer.app.captureCharFrame()).not.toContain(suggestion)
  footer.app.mockInput.pressEnter()
  await footer.settle()
  expect(footer.submitted).toEqual([])
  expect(footer.text()).toBe("")
})

test("a suggestion starting with ! is taken into shell mode by Tab and sent as text by Enter", async () => {
  {
    await using footer = await render("!git status")
    footer.app.mockInput.pressTab()
    await footer.settle()
    expect(footer.text()).toBe("git status")
    footer.app.mockInput.pressEnter()
    await footer.settle()
    expect(footer.submitted.map((prompt) => [prompt.text, prompt.mode])).toEqual([["git status", "shell"]])
  }
  {
    await using footer = await render("!git status")
    footer.app.mockInput.pressEnter()
    await footer.settle()
    expect(footer.submitted.map((prompt) => [prompt.text, prompt.mode])).toEqual([["!git status", undefined]])
  }
})

test("typing hides the ghost and erasing shows it again, and nothing hidden is taken", async () => {
  {
    await using footer = await render(suggestion)
    expect(footer.app.captureCharFrame()).toContain(suggestion)
    footer.app.mockInput.pressKey("x")
    await footer.settle()
    expect(footer.events).toContain("changed")
    expect(footer.app.captureCharFrame()).not.toContain(suggestion)
    footer.app.mockInput.pressArrow("right")
    await footer.settle()
    expect(footer.text()).toBe("x")
    footer.app.mockInput.pressBackspace()
    await footer.settle()
    expect(footer.app.captureCharFrame()).toContain(suggestion)
  }
  // While a turn runs nothing is drawn, and no key takes it.
  for (const press of keys) {
    await using footer = await render(suggestion, 100, { phase: "running" })
    expect(footer.app.captureCharFrame()).not.toContain(suggestion)
    press.press(footer)
    await footer.settle()
    expect({ key: press.key, text: footer.text() }).toEqual({ key: press.key, text: "" })
    expect({ key: press.key, sent: footer.submitted }).toEqual({ key: press.key, sent: [] })
  }
})

// A command run from the list is a submit, so it ends the suggestion even when it runs without sending a prompt.
test.each(["settings", "editor"])("/%s run from the list ends the suggestion", async (name) => {
  await using footer = await render(suggestion)
  expect(footer.app.captureCharFrame()).toContain(suggestion)
  footer.app.mockInput.typeText(`/${name}`)
  await footer.settle()
  footer.app.mockInput.pressEnter()
  await footer.settle()
  expect(footer.events).toContain("submitted")
  footer.app.mockInput.pressEscape()
  await footer.settle()
  await Bun.sleep(50)
  await footer.settle()
  expect(footer.submitted).toEqual([])
  expect(footer.app.captureCharFrame()).not.toContain(suggestion)
})

// Control: a typed draft only hides the suggestion, and erasing it draws the held one again.
test("a typed slash draft hides the suggestion without ending it", async () => {
  await using footer = await render(suggestion)
  footer.app.mockInput.typeText("/settings")
  await footer.settle()
  expect(footer.app.captureCharFrame()).not.toContain(suggestion)
  "/settings".split("").forEach(() => footer.app.mockInput.pressBackspace())
  await footer.settle()
  await Bun.sleep(50)
  await footer.settle()
  expect(footer.events).not.toContain("submitted")
  expect(footer.app.captureCharFrame()).toContain(suggestion)
})

test("a menu over the prompt takes no suggestion", async () => {
  await using footer = await render(suggestion, 100, { subagent: true })
  expect(footer.app.captureCharFrame()).toContain(suggestion)
  footer.app.mockInput.pressArrow("down")
  await footer.settle()
  expect(footer.app.captureCharFrame()).toContain("Select subagent")
  footer.app.mockInput.pressTab()
  await footer.settle()
  footer.app.mockInput.pressEscape()
  await footer.settle()
  await Bun.sleep(50)
  await footer.settle()
  expect(footer.text()).toBe("")
  expect(footer.app.captureCharFrame()).toContain(suggestion)
})
