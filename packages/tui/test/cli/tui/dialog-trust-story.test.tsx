/** @jsxImportSource @opentui/solid */
import type { Context } from "@orbit/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider, useThemes } from "../../../src/context/theme"
import { dialogTrustStory } from "../../../src/feature-plugins/system/storybook/dialog-trust"
import { createDialogApi } from "../../../src/plugin/api"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// The trust dialog's story draws the real dialog for a folder that is not trusted, for each kind of root: a project,
// which a grant is kept for, and a home directory or filesystem root, which are trusted only until Orbit restarts. The
// story is drawn as the storybook draws it, with the parts of the plugin context it uses.
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
    return dialogTrustStory.render(context)
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
    { width: 110, height: 34, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("storybook / trust dialog"))
  return app
}

test("the story asks about each kind of root as the real dialog does, and its reset returns to the project", async () => {
  const app = await render()
  try {
    // A project: the dialog opens at once, and its grant is kept.
    const project = await app.waitForFrame(
      (frame) => frame.includes("Trust this folder?") && frame.includes("project · untrusted"),
    )
    expect(project).toContain("/Users/kit/code/orbit-app")
    expect(project).toContain("Trust this folder")
    expect(project).not.toContain("Trust until Orbit restarts")
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Trust this folder?") && frame.includes("dialog dismissed"))

    // A home directory: trusted only until Orbit restarts.
    app.mockInput.pressKey("r")
    await app.waitForFrame((frame) => frame.includes("home directory · untrusted"))
    app.mockInput.pressKey("o")
    const home = await app.waitForFrame((frame) => frame.includes("Trust until Orbit restarts"))
    expect(home).toContain("/Users/kit")
    expect(home).not.toContain("orbit-app")
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("Trust this folder?"))

    // The reset goes back to the project and opens its question again.
    app.mockInput.pressKey("x")
    const reset = await app.waitForFrame(
      (frame) => frame.includes("project · untrusted") && frame.includes("Trust this folder?"),
    )
    expect(reset).toContain("/Users/kit/code/orbit-app")
    expect(reset).not.toContain("Trust until Orbit restarts")
  } finally {
    app.renderer.destroy()
  }
})
