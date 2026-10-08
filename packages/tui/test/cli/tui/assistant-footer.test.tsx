/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { assistantFooterFixtures } from "../../../src/feature-plugins/system/storybook/assistant-footer.fixtures"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { AssistantFooter } from "../../../src/routes/session/assistant-footer"
import { footerOutcome, turnDuration } from "../../../src/routes/session/rows"
import { errorMessage } from "../../../src/util/error"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function draw(label: string) {
  const fixture = assistantFooterFixtures().find((item) => item.label === label)!
  const position = fixture.messages.findIndex((message) => message.id === fixture.target)
  const message = fixture.messages[position]
  if (message.type !== "assistant") throw new Error("Expected an assistant")
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <box flexDirection="column">
                <AssistantFooter
                  agent={message.agent}
                  color={RGBA.fromInts(255, 255, 255)}
                  model="Fixture model"
                  duration={turnDuration(message, fixture.messages, position, false)}
                  tokensPerSecond={undefined}
                  error={message.error ? errorMessage(message.error) : undefined}
                  retry={message.retry}
                  interrupted={false}
                  outcome={footerOutcome(fixture.messages, position)}
                  width={100}
                />
              </box>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 6 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("Build"))
  const frame = app.captureCharFrame()
  app.renderer.destroy()
  return frame
}

test.each([
  ["plain", [], ["Error:", "· continued", "· retried", "truncated"]],
  ["recovered error", ["· continued"], ["Error:", "provider closed"]],
  ["continued after output limit", ["· continued"], ["truncated"]],
  ["retried attempt", ["· retried"], ["truncated", "· continued"]],
  ["final truncation", ["· truncated at output limit"], ["Error:"]],
  ["terminal error", ["Error: The provider closed the stream"], ["· continued", "truncated"]],
  ["retrying", ["attempt 2"], ["· continued", "truncated"]],
])("the %s fixture draws its footer", async (label, shown, hidden) => {
  const frame = await draw(label)
  shown.forEach((text) => expect(frame).toContain(text))
  hidden.forEach((text) => expect(frame).not.toContain(text))
})
