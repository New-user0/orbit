/** @jsxImportSource @opentui/solid */
import type { Context, Page } from "@orbit/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
import Storybook from "../../../src/feature-plugins/system/storybook"
import { createDialogApi } from "../../../src/plugin/api"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { controlFree, listHeading } from "../../fixture/rewind"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// clients-ux-5 part 2: the rewind picker's story draws the real picker from fixtures, with every request answered and
// every option acted on inside the story, so exploring it changes nothing. Its fixtures cover a session with edits, one
// with nothing to rewind, one whose code cannot be rewound, and hostile names. It is drawn as `ORBIT_STORY=rewind`
// draws it: the storybook plugin's route, asked for the story with the id `rewind`, with the parts of the plugin
// context the stories use. (The storybook draws its index for an id it does not know.)
async function render(width: number) {
  function Story() {
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
          navigate: () => {},
          register: (page: Page) => {
            pages.push(page)
            return () => {}
          },
        },
        slot: () => () => {},
      },
    } as unknown as Context
    void Storybook.setup(context)
    return pages.find((page) => page.name === "storybook")?.render({ data: { story: "rewind" } })
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <ThemeProvider mode="dark" source={emptyThemeSource}>
                <DialogProvider>
                  <Story />
                </DialogProvider>
              </ThemeProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 34, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("storybook / rewind"))
  return app
}

test.each([64, 120])("the story draws the real picker for each fixture and resets, at %i columns", async (width) => {
  const app = await render(width)
  try {
    const first = await app.waitForFrame((frame) => frame.includes(listHeading) && frame.includes("(current)"))
    for (const control of ["ctrl+g", "ctrl+r"]) expect(first).toContain(control)

    // Each fixture is reached with the next-fixture key; the hostile one draws its names written out (class 9).
    const seen = new Set<string>()
    for (let press = 0; press < 8 && !seen.has("hostile names"); press++) {
      app.mockInput.pressKey("g", { ctrl: true })
      const frame = await app.waitForFrame((frame) => /fixture: [a-z ]+/.test(frame))
      const label = frame.match(/fixture: ([a-z ]+?)(?: ·|\s{2}|$)/m)?.[1]?.trim()
      if (label) seen.add(label)
      if (label === "hostile names") {
        expect(controlFree(frame)).toBe(true)
        expect(frame).toContain("\\x1b")
      }
      if (label === "nothing to rewind") expect(frame).toContain("Nothing to rewind yet.")
    }
    expect(seen).toContain("hostile names")
    expect(seen).toContain("nothing to rewind")

    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(listHeading) && frame.includes("(current)"))
  } finally {
    app.renderer.destroy()
  }
})
