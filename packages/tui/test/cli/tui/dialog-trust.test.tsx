/** @jsxImportSource @opentui/solid */
import type { TrustStatus, TrustWithheld } from "@orbit/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider, useLocation } from "../../../src/context/location"
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
  changed: [],
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

// A folder a person can move to, such as the one a session works in: a clone of its own, with a root of its own.
const away: TrustStatus = {
  directory: "/elsewhere/other-clone",
  trusted: false,
  persistent: true,
  changed: [],
  withheld: [{ path: "/elsewhere/other-clone/orbit.json", kinds: ["providers"] }],
}

const title = "Trust this folder?"
// The choice, as opposed to the question that carries the same words.
const choice = /Trust this folder(?!\?)/
// Whether the question is on screen and asks about the folder, which is what its first line names.
const asksAbout = (frame: string, folder: string) => frame.includes(title) && frame.includes(`⊙ Untrusted  ${folder}`)

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

    // For the folder the question was about, which is the one in view.
    expect(fixture.updates).toEqual([{ directory, trust: true, persist: true }])
    expect(fixture.status().trusted).toBe(true)
  } finally {
    fixture.app.renderer.destroy()
  }
})

// A folder that was trusted, and whose hooks and plugins changed since: a pull, a branch switch or an edit.
const changedSince: TrustStatus = {
  directory: "/tmp/orbit",
  trusted: true,
  persistent: true,
  source: "saved",
  withheld: [
    { path: "/tmp/orbit/orbit.json", kinds: ["hooks"] },
    { path: "/tmp/orbit/.orbit", kinds: ["plugins", "hooks"] },
  ],
  changed: [
    { path: "/tmp/orbit/orbit.json", kinds: ["hooks"] },
    { path: "/tmp/orbit/.orbit", kinds: ["plugins", "hooks"] },
  ],
}

test("a trusted folder whose config changed asks to trust the changes, lists what changed, and a grant renews it", async () => {
  const fixture = await renderTrust(changedSince)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Trust the changes?"))
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("⊙ Changed  /tmp/orbit")
    expect(frame).toContain("changed since you trusted it")
    expect(frame).toContain("orbit.json")
    expect(frame).toContain("hooks")
    expect(frame).toContain(".orbit")
    expect(frame).toContain("plugins, hooks")
    expect(frame).toContain("Trust changes")
    expect(frame).toContain("Not now")
    // Not the question for an untrusted folder.
    expect(frame).not.toContain("Trust this folder")
    expect(frame).not.toContain("Untrusted")

    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes("Trust the changes?"))

    // A grant that is stored stays stored.
    expect(fixture.updates).toEqual([{ directory, trust: true, persist: true }])
    await until(() => fixture.toast().currentToast !== null)
    expect(fixture.toast().currentToast).toMatchObject({ variant: "success", message: "Trusted the changes in /tmp/orbit" })
    expect(fixture.status().changed).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a grant that lasts until Orbit restarts is renewed the same way", async () => {
  const fixture = await renderTrust({ ...changedSince, source: "session" })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Trust the changes?"))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes("Trust the changes?"))
    expect(fixture.updates).toEqual([{ directory, trust: true, persist: false }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("writes out the control characters in the name of a source", async () => {
  const fixture = await renderTrust({
    ...changedSince,
    withheld: [{ path: "/tmp/orbit/evil\u001b[2Jname.json", kinds: ["hooks"] }],
    changed: [{ path: "/tmp/orbit/evil\u001b[2Jname.json", kinds: ["hooks"] }],
  })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Trust the changes?"))
    const frame = fixture.app.captureCharFrame()
    expect(frame).not.toContain("\u001b")
    expect(frame).toContain("evil\\x1b[2Jname.json")
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("Not now leaves the changed config off and does not ask again in this run", async () => {
  const fixture = await renderTrust(changedSince)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Trust the changes?"))
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes("Trust the changes?"))
    expect(fixture.updates).toEqual([])
    expect(fixture.status().changed).not.toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a file that sets environment variables is listed with their label", async () => {
  const fixture = await renderTrust({
    ...project,
    withheld: [{ path: "/tmp/orbit/orbit.json", kinds: ["env"] }],
  })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("orbit.json")
    expect(frame).toContain("environment variables")
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
    expect(frame).toMatch(/orb\s+trust\s+\/tmp\/orbit\s+--for\s+\/tmp\/\s*orbit\/packages\/tui`/)
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
        "Trusted /tmp/orbit/app. Config above it stays off until its own folder is trusted: `orb trust /tmp/orbit --for /tmp/orbit/packages/tui`",
    })
    expect(fixture.updates).toEqual([{ directory, trust: true, persist: true }])
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

    expect(fixture.updates).toEqual([{ directory, trust: true, persist: false }])
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
    expect(fixture.updates).toEqual([{ directory, trust: true, persist: true }])
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

test("the question closes when another folder comes into view, so no choice is made for a folder that was not shown", async () => {
  const held = Promise.withResolvers<void>()
  const fixture = await renderTrust(project, { away: { status: away, held: held.promise } })

  try {
    await fixture.app.waitForFrame((frame) => asksAbout(frame, project.directory))

    // What is known of the other folder is not in yet, so nothing says what trusting it would turn on.
    fixture.view(away.directory)
    await fixture.app.waitForFrame((frame) => !frame.includes(title))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.renderOnce()
    expect(fixture.updates).toEqual([])

    // The question comes back for the folder now in view once it is known, and a choice is for that folder.
    held.resolve()
    await fixture.app.waitForFrame((frame) => asksAbout(frame, away.directory))
    expect(fixture.app.captureCharFrame()).toContain("providers")
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.updates).toEqual([{ directory: away.directory, trust: true, persist: true }])
    expect(fixture.status().trusted).toBe(false)
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("not now holds for the folder it was said for, and the folder that was left is asked about when it is back", async () => {
  const fixture = await renderTrust(project, { away: { status: away } })

  try {
    await fixture.app.waitForFrame((frame) => asksAbout(frame, project.directory))
    fixture.view(away.directory)
    await fixture.app.waitForFrame((frame) => asksAbout(frame, away.directory))

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))
    await fixture.app.renderOnce()
    // The folder that was just declined is not asked about again.
    expect(fixture.app.captureCharFrame()).not.toContain(title)

    // Leaving the first folder was not an answer about it.
    fixture.view(directory)
    await fixture.app.waitForFrame((frame) => asksAbout(frame, project.directory))
    expect(fixture.updates).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a grant that is answered once another folder is in view leaves the question about that folder open", async () => {
  const answer = Promise.withResolvers<void>()
  const fixture = await renderTrust(project, { away: { status: away }, granting: answer.promise })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await until(() => fixture.updates.length > 0)

    // The server is slow, and the person has moved on.
    fixture.view(away.directory)
    await fixture.app.waitForFrame((frame) => asksAbout(frame, away.directory))
    answer.resolve()
    await until(() => fixture.toast().currentToast !== null)
    await fixture.app.renderOnce()

    expect(fixture.toast().currentToast).toMatchObject({ variant: "success", message: "Trusted /tmp/orbit" })
    expect(asksAbout(fixture.app.captureCharFrame(), away.directory)).toBe(true)
    expect(fixture.updates).toEqual([{ directory, trust: true, persist: true }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("the folders above the one the terminal UI started in that the server holds back are the same list until the answer changes", async () => {
  // Trusted, with config in the folder above still held back for that folder's own decision.
  const fixture = await renderTrust({ ...layered, trusted: true, source: "saved", withheld: [above] })

  try {
    await until(() => fixture.reads() > 0)
    await until(() => fixture.trust().startup.settled())
    const first = fixture.trust().startup.above()
    expect(first).toEqual(["/tmp/orbit"])

    // The plugins are rebuilt when this list changes, which retries the packages that failed to install, so a read that
    // finds the same answer must not look like a change.
    const reads = fixture.reads()
    fixture.events.emit({
      id: "evt_trust",
      created: 1,
      type: "trust.updated",
      data: { directory: "/tmp/orbit", trusted: true },
    })
    await until(() => fixture.reads() >= reads + 2)
    await fixture.app.renderOnce()
    expect(fixture.trust().startup.above()).toBe(first)

    // And when the folder above is trusted, the server stops listing it.
    fixture.trustElsewhere()
    fixture.events.emit({
      id: "evt_trust_above",
      created: 2,
      type: "trust.updated",
      data: { directory: "/tmp/orbit", trusted: true },
    })
    await until(() => fixture.trust().startup.above().length === 0)
  } finally {
    fixture.app.renderer.destroy()
  }
})

type Fixture = Awaited<ReturnType<typeof renderTrust>>

async function renderTrust(
  initial: TrustStatus,
  options?: {
    busy?: boolean
    refuse?: boolean
    // What a grant leaves held back, which is what sits in the folders above the one that is trusted.
    leaves?: TrustWithheld[]
    // A folder a person can move to, with what is read for it. `held` keeps that answer back until it is resolved.
    away?: { status: TrustStatus; held?: Promise<void> }
    // Keeps the answer to a grant back until it is resolved, as a slow server would.
    granting?: Promise<void>
  },
) {
  const events = createEventStream()
  // What a read or a grant answers, by the folder it names: the one the terminal UI starts in, and the one a person can
  // move to.
  const statuses = new Map([[directory, initial]])
  if (options?.away) statuses.set(options.away.status.directory, options.away.status)
  let reads = 0
  const updates: unknown[] = []
  let trust!: ReturnType<typeof useTrust>
  let toast!: ReturnType<typeof useToast>
  let location!: ReturnType<typeof useLocation>
  const calls = createFetch(async (url, request) => {
    if (url.pathname !== "/api/location/trust") return undefined
    const folder = url.searchParams.get("location[directory]") ?? directory
    const known = statuses.get(folder) ?? initial
    if (request.method === "GET") {
      reads++
      if (folder === options?.away?.status.directory) await options.away.held
      return json(known)
    }
    const body = (await request.json()) as { trust: boolean; persist?: boolean }
    // Which folder the grant is for is part of what is asked.
    updates.push({ directory: folder, ...body })
    if (options?.refuse) return new Response("unavailable", { status: 503 })
    await options?.granting
    const granted: TrustStatus = {
      ...known,
      trusted: true,
      source: body.persist === false ? "session" : "saved",
      withheld: options?.leaves ?? [],
      changed: [],
    }
    statuses.set(folder, granted)
    return json(granted)
  }, events)

  // What a route does: ask whenever the folder in view holds something back.
  function Route() {
    trust = useTrust()
    toast = useToast()
    location = useLocation()
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
                          <TrustProvider directory={directory}>
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
  // The folder the terminal UI starts in.
  const status = () => statuses.get(directory) ?? initial
  return {
    app,
    events,
    updates,
    status,
    reads: () => reads,
    trust: () => trust,
    toast: () => toast,
    // What a session does when it opens: puts another folder in view.
    view: (folder: string) => location.set({ directory: folder }),
    trustElsewhere() {
      statuses.set(directory, { ...status(), trusted: true, source: "saved", withheld: [] })
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
