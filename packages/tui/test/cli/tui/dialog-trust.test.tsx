/** @jsxImportSource @opentui/solid */
import type { TrustStatus, TrustWithheld } from "@orbit/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider } from "../../../src/context/location"
import { RouteProvider } from "../../../src/context/route"
import { ThemeProvider } from "../../../src/context/theme"
import { TrustProvider, useTrust, useTrustPrompt } from "../../../src/context/trust"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DialogAlert } from "../../../src/ui/dialog-alert"
import { ToastProvider, useToast } from "../../../src/ui/toast"
import { emptyThemeSource } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const project: TrustStatus = {
  directory: "/tmp/orbit",
  trusted: false,
  persistent: true,
  withheld: [
    { path: "/tmp/orbit/.orbit", kinds: ["plugins", "commands"] },
    { path: "/tmp/orbit/orbit.json", kinds: ["hooks", "mcp"] },
  ],
}

// The home directory, which is never trusted for good.
const home: TrustStatus = { ...project, directory: "/tmp/orbit/home", persistent: false }

// A project with config of its own and in the folder above it. Discovery goes from the outermost folder in, so what sits
// above can be reported ahead of the project's own, and each folder is trusted on its own.
const above: TrustWithheld = { path: "/tmp/orbit/orbit.json", kinds: ["hooks"], directory: "/tmp/orbit" }
const layered: TrustStatus = {
  ...project,
  directory: "/tmp/orbit/app",
  withheld: [above, { path: "/tmp/orbit/app/orbit.json", kinds: ["mcp"] }],
}

const title = "Trust this folder?"
// The choice, as opposed to the question that carries the same words.
const choice = /Trust this folder(?!\?)/

test("a folder that can be remembered offers trust and not now, and trusting it sends persist", async () => {
  const fixture = await renderTrust(project)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("⊙ Untrusted")
    expect(frame).toContain("plugins, shell snippets")
    expect(frame).toContain("orbit.json")
    expect(frame).toContain("hooks, MCP servers")
    expect(frame).toMatch(choice)
    expect(frame).toContain("Not now")
    // That the choice is kept, and what takes it back.
    expect(frame).toContain("It stays trusted until")
    expect(frame).toMatch(/orb\s+trust\s+--\s*revoke/)

    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.updates).toEqual([{ trust: true, persist: true }])
    expect(fixture.status().trusted).toBe(true)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("config above the folder is listed after the folder's own, with the command that trusts the folder that holds it", async () => {
  const fixture = await renderTrust(layered)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    const frame = fixture.app.captureCharFrame()
    // What this choice turns on comes first, though the server reported it second.
    expect(frame).toContain("MCP servers")
    expect(frame).toContain("/tmp/orbit/orbit.json")
    expect(frame.indexOf("MCP servers")).toBeLessThan(frame.indexOf("hooks"))
    // Trusting this folder does not turn the rest on, and what does is named, as the commands name it.
    expect(frame).toMatch(/Config\s+above\s+this\s+folder\s+stays\s+off\s+until\s+its\s+own\s+folder\s+is\s+trusted/)
    expect(frame).toMatch(/orb\s+trust\s+\/tmp\/orbit`/)
    expect(frame).toMatch(choice)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a folder with no config above it does not mention one", async () => {
  const fixture = await renderTrust(project)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    expect(fixture.app.captureCharFrame()).not.toContain("Config above this folder")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("trusting the folder says what stays off above it, and that its own folder has to be trusted for it", async () => {
  const fixture = await renderTrust(layered, { leaves: [above] })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await until(() => fixture.toast().currentToast !== null)

    expect(fixture.toast().currentToast).toMatchObject({
      variant: "success",
      message:
        "Trusted /tmp/orbit/app. Config above it stays off until its own folder is trusted: `orb trust /tmp/orbit`",
    })
    expect(fixture.updates).toEqual([{ trust: true, persist: true }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("trusting a folder with nothing above it says only that it is trusted", async () => {
  const fixture = await renderTrust(project)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await until(() => fixture.toast().currentToast !== null)

    expect(fixture.toast().currentToast).toMatchObject({ variant: "success", message: "Trusted /tmp/orbit" })
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("enter on its own is not now, so a keystroke typed ahead of the dialog never trusts the folder", async () => {
  const fixture = await renderTrust(project)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.updates).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a home directory offers only trust until restart, which never sends persist", async () => {
  const fixture = await renderTrust(home)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("Trust until Orbit restarts")
    expect(frame).not.toMatch(choice)
    expect(frame).toContain("Not now")
    // What the choice costs: how long it lasts, on the shared service, and what ends it early.
    expect(frame).toContain("until the service restarts")
    expect(frame).toMatch(/orb\s+trust\s+--\s*revoke/)

    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.updates).toEqual([{ trust: true, persist: false }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test.each([
  ["not now is chosen", (fixture: Fixture) => fixture.app.mockInput.pressEnter()],
  ["the dialog is dismissed", (fixture: Fixture) => fixture.app.mockInput.pressEscape()],
])("it does not reopen on the next status refresh once %s", async (_, answer) => {
  const fixture = await renderTrust(project)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    answer(fixture)
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    // Both events that make the status be read again, one after the other.
    const before = fixture.reads()
    fixture.events.emit({ id: "evt_config", created: 1, type: "config.updated", data: {} })
    await until(() => fixture.reads() > before)
    fixture.events.emit({
      id: "evt_trust",
      created: 2,
      type: "trust.updated",
      data: { directory: "/tmp/orbit", trusted: false },
    })
    await until(() => fixture.reads() > before + 1)
    await fixture.app.renderOnce()

    expect(fixture.app.captureCharFrame()).not.toContain(title)
    expect(fixture.updates).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a grant the server refuses is reported and leaves the question open", async () => {
  const fixture = await renderTrust(project, { refuse: true })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await until(() => fixture.toast().currentToast !== null)

    expect(fixture.toast().currentToast).toMatchObject({ variant: "error", message: expect.stringContaining("503") })
    expect(fixture.app.captureCharFrame()).toContain(title)
    expect(fixture.updates).toEqual([{ trust: true, persist: true }])
    expect(fixture.status().trusted).toBe(false)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("the question can be asked again after not now", async () => {
  const fixture = await renderTrust(project)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.trust().held()).toBe(true)
    fixture.trust().open()
    await fixture.app.waitForFrame((frame) => frame.includes(title))
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a folder that holds nothing of its own back, or is trusted, is not asked about", async () => {
  for (const status of [
    { ...project, withheld: [] },
    // Trusting this folder would turn nothing on, as the one file that is held back is decided by the folder above.
    { ...layered, withheld: [above] },
    { ...project, trusted: true, source: "saved" as const, withheld: [] },
    { ...layered, trusted: true, source: "saved" as const, withheld: [above] },
  ]) {
    const fixture = await renderTrust(status)

    try {
      await until(() => fixture.reads() > 0)
      await fixture.app.renderOnce()
      expect(fixture.app.captureCharFrame()).not.toContain(title)
      expect(fixture.trust().held()).toBe(false)
    } finally {
      fixture.app.renderer.destroy()
    }
  }
})

test("the question waits for the dialog a person is already in", async () => {
  const fixture = await renderTrust(project, { busy: true })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Busy"))
    await until(() => fixture.trust().pending() !== undefined)
    await fixture.app.renderOnce()
    expect(fixture.app.captureCharFrame()).not.toContain(title)

    fixture.app.mockInput.pressEscape()
    await fixture.app.waitForFrame((frame) => frame.includes(title))
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("trusting the folder somewhere else closes the question", async () => {
  const fixture = await renderTrust(project)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.trustElsewhere()
    fixture.events.emit({
      id: "evt_trust",
      created: 1,
      type: "trust.updated",
      data: { directory: "/tmp/orbit", trusted: true },
    })
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.updates).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

type Fixture = Awaited<ReturnType<typeof renderTrust>>

async function renderTrust(
  initial: TrustStatus,
  // `leaves` is what a grant leaves held back, which is what sits in the folders above the one that is trusted.
  options?: { busy?: boolean; refuse?: boolean; leaves?: TrustWithheld[] },
) {
  const events = createEventStream()
  let status = initial
  let reads = 0
  const updates: unknown[] = []
  let trust!: ReturnType<typeof useTrust>
  let toast!: ReturnType<typeof useToast>
  const calls = createFetch(async (url, request) => {
    if (url.pathname !== "/api/location/trust") return undefined
    if (request.method === "GET") {
      reads++
      return json(status)
    }
    const body = (await request.json()) as { trust: boolean; persist?: boolean }
    updates.push(body)
    if (options?.refuse) return new Response("unavailable", { status: 503 })
    status = {
      ...status,
      trusted: true,
      source: body.persist === false ? "session" : "saved",
      withheld: options?.leaves ?? [],
    }
    return json(status)
  }, events)

  // What a route does: ask whenever the folder in view holds something back.
  function Route() {
    trust = useTrust()
    toast = useToast()
    const dialog = useDialog()
    if (options?.busy) onMount(() => dialog.replace(() => <DialogAlert title="Busy" message="Another dialog" />))
    useTrustPrompt()
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <Keymap.Provider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "home" }}>
                <ClientProvider api={createApi(calls.fetch)}>
                  <DataProvider directory={directory}>
                    <LocationProvider>
                      <ThemeProvider mode="dark" source={emptyThemeSource}>
                        <DialogProvider>
                          <TrustProvider>
                            <Route />
                          </TrustProvider>
                        </DialogProvider>
                      </ThemeProvider>
                    </LocationProvider>
                  </DataProvider>
                </ClientProvider>
              </RouteProvider>
            </ToastProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  return {
    app,
    events,
    updates,
    status: () => status,
    reads: () => reads,
    trust: () => trust,
    toast: () => toast,
    trustElsewhere() {
      status = { ...status, trusted: true, source: "saved", withheld: [] }
    },
  }
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}
