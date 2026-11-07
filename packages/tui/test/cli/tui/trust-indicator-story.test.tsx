/** @jsxImportSource @opentui/solid */
import type { Context } from "@orbit/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
import { trustIndicatorStory } from "../../../src/feature-plugins/system/storybook/trust-indicator"
import { createDialogApi } from "../../../src/plugin/api"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// The untrusted indicator's story activates the indicator the way the app does: the question opens for every folder the
// indicator is shown for, which under trust-first is every folder that is not trusted, whatever it holds, and nothing
// opens for a trusted folder. The story is drawn as the storybook draws it, with the parts of the plugin context it uses.
async function render() {
  function Story() {
    const themes = useThemes()
    const context = {
      get theme() {
        return themes.currentTokens()
      },
      keymap: { layer: Keymap.createLayer },
      ui: { dialog: createDialogApi(useDialog(), (draw) => draw()), router: { navigate: () => {} } },
    } as unknown as Context
    return trustIndicatorStory.render(context)
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
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("storybook / untrusted indicator"))
  return app
}

test("the story opens the question for an untrusted folder, and not for a trusted one", async () => {
  const app = await render()
  try {
    // The first state is a folder that is not trusted, which holds nothing back since nothing of it is read.
    await app.waitForFrame((frame) => frame.includes(" · untrusted · "))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("question opened") && frame.includes("Trust this folder?"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Trust this folder?"))

    // The other state is a trusted folder: no indicator, so nothing to open.
    app.mockInput.pressKey("t")
    await app.waitForFrame((frame) => frame.includes(" · trusted · "))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("the indicator is not shown, so there is nothing to activate"))
  } finally {
    app.renderer.destroy()
  }
})
