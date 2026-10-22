/** @jsxImportSource @opentui/solid */
import type { TrustStatus, TrustWithheld } from "@orbit/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { TrustIndicator } from "../../../src/component/trust-indicator"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { emptyThemeSource } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const untrusted: TrustStatus = {
  directory: "/projects/app",
  trusted: false,
  persistent: true,
  changed: [],
  withheld: [{ path: "/projects/app/orbit.json", kinds: ["hooks"] }],
}

async function render(status: TrustStatus | undefined, width: number, onOpen = () => {}) {
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <box flexDirection="row" gap={1}>
                <text>footer</text>
                <TrustIndicator status={status} onOpen={onOpen} />
              </box>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 3 },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes("footer"))
  return app
}

test.each([
  [100, "⊙ Untrusted /trust"],
  [60, "⊙ Untrusted"],
])("an untrusted folder that holds something back is marked at %s columns", async (width, text) => {
  const app = await render(untrusted, width)

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain(text)
    // The hint is for a terminal wide enough to spare it.
    expect(frame.includes("/trust")).toBe(width >= 80)
  } finally {
    app.renderer.destroy()
  }
})

// What sits in a folder above the project is turned on by that folder's own trust, so trusting this one would do nothing.
const above: TrustWithheld = { path: "/projects/orbit.json", kinds: ["hooks"], directory: "/projects" }

// trust-first: a folder that is not trusted is marked whatever it holds, because nothing of it loads until it is.
test.each([
  ["an untrusted folder that holds nothing back", { ...untrusted, withheld: [] }],
  ["an untrusted folder whose only held-back config is above it", { ...untrusted, withheld: [above] }],
])("%s is marked", async (_, status) => {
  const app = await render(status, 100)

  try {
    expect(app.captureCharFrame()).toContain("⊙ Untrusted")
  } finally {
    app.renderer.destroy()
  }
})

test.each([
  ["a trusted folder", { ...untrusted, trusted: true, source: "saved" as const, withheld: [] }],
  ["a trusted folder with config above it held back", { ...untrusted, trusted: true, withheld: [above] }],
  ["a folder whose status is not known", undefined],
])("%s is not marked", async (_, status) => {
  const app = await render(status, 100)

  try {
    expect(app.captureCharFrame()).not.toContain("Untrusted")
  } finally {
    app.renderer.destroy()
  }
})

test("an untrusted folder with config above it as well as its own is marked", async () => {
  const app = await render({ ...untrusted, withheld: [above, ...untrusted.withheld] }, 100)

  try {
    expect(app.captureCharFrame()).toContain("⊙ Untrusted")
  } finally {
    app.renderer.destroy()
  }
})

test("clicking the mark opens the question", async () => {
  let opened = 0
  const app = await render(untrusted, 100, () => opened++)

  try {
    const lines = app.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("⊙ Untrusted"))
    await app.mockMouse.click(lines[row]!.indexOf("⊙ Untrusted"), row)
    expect(opened).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
