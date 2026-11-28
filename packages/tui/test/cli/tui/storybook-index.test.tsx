/** @jsxImportSource @opentui/solid */
import type { Context, Page } from "@orbit/plugin/tui/context"
import { testRenderTimed } from "../../fixture/render"
import { expect, spyOn, test } from "bun:test"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
import Storybook from "../../../src/feature-plugins/system/storybook"
import { createDialogApi } from "../../../src/plugin/api"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { until } from "../../fixture/rewind"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// m5-quality: the storybook's index opens each story with a key of its own. It bound the digits 1 to 14 in one layer,
// where "10" to "14" are two strokes that start with "1", so the keymap refused those bindings with a
// binding-compile-error and the stories after the ninth had no key. Each story now has one key: the digits 1 to 9, then
// the letters from a, leaving out j and k, which move the selection. The index draws each story's key in front of its
// title, the key opens that story (the one Enter opens on that row), and the layer compiles with no error. Drawn as
// `ORBIT_STORY=1` draws it: the storybook plugin's route with no story asked for.
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e"]

async function render() {
  const opened: string[] = []
  function Index() {
    const themes = useThemes()
    const pages: Page[] = []
    const context = {
      get theme() {
        return themes.currentTokens()
      },
      keymap: { layer: Keymap.createLayer },
      ui: {
        dialog: createDialogApi(useDialog(), (draw) => draw()),
        router: {
          navigate: (route: { data?: { story?: string } }) => {
            if (route.data?.story) opened.push(route.data.story)
          },
          register: (page: Page) => {
            pages.push(page)
            return () => {}
          },
        },
        slot: () => () => {},
      },
    } as unknown as Context
    void Storybook.setup(context)
    return pages.find((page) => page.name === "storybook")?.render({ data: undefined })
  }
  const app = await testRenderTimed(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ThemeProvider mode="dark" source={emptyThemeSource}>
                <DialogProvider>
                  <Index />
                </DialogProvider>
              </ThemeProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 34, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("fixture-driven simulations"))
  return { app, opened }
}

// The index's rows: the key drawn in front of each title, in order.
const rows = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.match(/^\s*(?:› )?\s*(\S) (\S.*?)\s*$/))
    .filter((found): found is RegExpMatchArray => found !== null && found[1] !== undefined)
    .map((found) => ({ key: found[1]!, title: found[2]! }))
    .filter((row) => KEYS.includes(row.key) || /^\d+$/.test(row.key))

test("each story has a key of its own, drawn on its row, that opens it, and the index's keys all compile", async () => {
  const errors = spyOn(console, "error")
  try {
    const { app, opened } = await render()
    try {
      const frame = await app.waitForFrame((frame) => frame.includes("storybook"))
      // Fourteen stories, each drawn behind its key.
      expect(rows(frame).map((row) => row.key)).toEqual(KEYS)

      // Enter on each row, from the first down, opens the stories in order: the truth each key is held to.
      for (let index = 0; index < KEYS.length; index++) {
        app.mockInput.pressEnter()
        await until(() => opened.length === index + 1, `story ${index + 1} opened`)
        app.mockInput.pressArrow("down")
      }
      const byEnter = [...opened]
      expect(new Set(byEnter).size).toBe(KEYS.length)

      opened.length = 0
      for (const [index, key] of KEYS.entries()) {
        app.mockInput.pressKey(key)
        await until(() => opened.length === index + 1, `story ${index + 1} opened`)
      }
      expect(opened).toEqual(byEnter)
    } finally {
      app.renderer.destroy()
    }
    const compile = errors.mock.calls.filter((call) => String(call[0]).includes("binding-compile-error"))
    expect(compile).toEqual([])
  } finally {
    errors.mockRestore()
  }
})
