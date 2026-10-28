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
import { controlFree } from "../../fixture/rewind"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// clients-ux-23: the `/context` view's story draws the real view from fixtures and asks no server. Its fixtures cover a
// usual session, one near full with suggestions, automatic compaction off, a million-token window, an unknown window
// and names that carry terminal control characters. It is drawn as `ORBIT_STORY=context` draws it: the storybook
// plugin's route, asked for the story with the id `context`, with the parts of the plugin context the stories use.
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
    return pages.find((page) => page.name === "storybook")?.render({ data: { story: "context" } })
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
    { width, height: 80, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("storybook / context"))
  return app
}

const fixture = (frame: string) => frame.match(/fixture: ([a-zA-Z0-9 ]+?)(?: ·|\s{2}|$)/m)?.[1]?.trim()

test.each([64, 120])("the story draws the real view for each fixture and resets, at %i columns", async (width) => {
  const app = await render(width)
  try {
    const first = await app.waitForFrame((frame) => frame.includes("Estimated usage by category") && fixture(frame) === "typical")
    for (const control of ["ctrl+g", "ctrl+x"]) expect(first).toContain(control)
    expect(first).toContain("ORBIT.md")

    // Each fixture is reached with the next-fixture key; the hostile one draws its names written out (class 9).
    const seen = new Set<string>(["typical"])
    let last = "typical"
    for (let press = 0; press < 8 && !seen.has("hostile names"); press++) {
      app.mockInput.pressKey("g", { ctrl: true })
      const frame = await app.waitForFrame((frame) => fixture(frame) !== undefined && fixture(frame) !== last)
      last = fixture(frame)!
      seen.add(last)
      if (last === "near full") expect(frame).toContain("Suggestions")
      if (last === "hostile names") {
        expect(controlFree(frame)).toBe(true)
        expect(frame).toContain("\\x1b")
      }
    }
    expect([...seen]).toEqual(["typical", "near full", "auto compaction off", "1M window", "unknown window", "hostile names"])

    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => fixture(frame) === "typical")
  } finally {
    app.renderer.destroy()
  }
})
