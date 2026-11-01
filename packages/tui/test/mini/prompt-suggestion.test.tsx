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
