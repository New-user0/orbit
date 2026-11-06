/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider, resolve, type Info, type Interface } from "../../../src/config"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { emptyThemeSource } from "../../fixture/fixture"

// The real palette over a config held in memory. `linked` says whether an editor is linked, as the app passes it.
async function palette(linked?: () => boolean) {
  const state: { current: Info } = { current: {} }
  const service: Interface = {
    get: async () => state.current,
    update: async (update) => {
      const draft = structuredClone(state.current)
      update(draft)
      state.current = draft
      return state.current
    },
  }

  function Fixture() {
    const dialog = useDialog()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        {
          id: "session.new",
          title: "New session",
          group: "Session",
          palette: true,
          run() {},
        },
        {
          id: "model.list",
          title: "Switch model",
          group: "Agent",
          palette: true,
          run() {},
        },
      ],
    }))
    onMount(() => dialog.replace(() => <CommandPaletteDialog linked={linked} />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={resolve(state.current, { terminalSuspend: true })} service={service}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("New session"))
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
  return { app, state }
}

test("searches settings globally and opens the matching setting", async () => {
  const { app, state } = await palette()
  try {
    expect(app.captureCharFrame()).not.toContain("Animations")

    app.mockInput.pressArrow("down")
    for (const key of "image preview") app.mockInput.pressKey(key)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("Image previews"))
    app.mockInput.pressEnter()
    await app.waitFor(() => state.current.prompt?.image_preview === true)
  } finally {
    app.renderer.destroy()
  }
})

// clients-ux-15 part 3: the setting of where an edit approval's diff shows needs a linked editor, so the palette finds it
// only while one is linked, and the settings dialog it opens lists it too.
test("the palette finds Diff tool only while linked to an editor, and the settings it opens list it", async () => {
  // `undefined`: an opener that does not say, which gets the palette of an unlinked terminal UI.
  for (const linked of [true, false, undefined]) {
    const { app, state } = await palette(linked === undefined ? undefined : () => linked)
    try {
      for (const key of "diff tool") app.mockInput.pressKey(key)
      // Typing narrows the list to what matches; "Diff tool" is among it only while linked.
      await app.waitForFrame((frame) => !frame.includes("New session"))
      await Bun.sleep(100)
      expect([linked, app.captureCharFrame().includes("Diff tool")]).toEqual([linked, linked === true])
      if (!linked) continue
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("Settings") && frame.includes("Diff tool"))
      app.mockInput.pressEnter()
      await app.waitFor(() => state.current.diffs?.tool === "terminal")
    } finally {
      app.renderer.destroy()
    }
  }
})
