/** @jsxImportSource @opentui/solid */
import type { TrustStatus } from "@orbit/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider } from "../../../src/context/data"
import { ExitProvider } from "../../../src/context/exit"
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

// trust-first: nothing of an untrusted folder is read, so its question lists nothing, and the folder the terminal UI
// started in is answered with Trust or Exit (`trust-first.test.ts`). A trusted folder is never asked about again (D8), so
// the question that offers Not now is the one about another folder that comes into view, such as a session's: the rows
// below that pin Not now start in a trusted folder and move to that one.
const untrusted: TrustStatus = {
  directory: "/tmp/orbit",
  trusted: false,
  persistent: true,
  withheld: [],
}

// The folder the terminal UI started in, once it is trusted.
const trusted: TrustStatus = { ...untrusted, trusted: true, source: "saved" }

// A folder a person can move to, such as the one a session works in: a clone of its own, with a root of its own.
const away: TrustStatus = {
  directory: "/elsewhere/other-clone",
  trusted: false,
  persistent: true,
  withheld: [],
}

const title = "Trust this folder?"
// Whether the question is on screen and asks about the folder, which is what its first line names.
const asksAbout = (frame: string, folder: string) => frame.includes(title) && frame.includes(`⊙ Untrusted  ${folder}`)

// The terminal UI started in a trusted folder, and another folder that is not trusted came into view.
async function elsewhere(options?: Parameters<typeof renderTrust>[1]) {
  const fixture = await renderTrust(trusted, { ...options, away: { status: away, ...options?.away } })
  // The routes mount once the folder the terminal UI started in has been read.
  await until(() => fixture.reads() > 0)
  fixture.view(away.directory)
  return fixture
}

test("the folder the terminal UI started in offers trust or exit, lists nothing, and trusting it sends persist", async () => {
  const fixture = await renderTrust(untrusted)

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Trust this folder?"))
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("⊙ Untrusted")
    expect(frame).not.toContain("orbit.json")
    expect(frame).toMatch(/Trust this folder(?!\?)/)
    expect(frame).toContain("Exit")
    expect(frame).not.toContain("Not now")
    // That the choice is kept, and what takes it back.
    expect(frame).toContain("It stays trusted until")
    expect(frame).toMatch(/orb\s+trust\s+--\s*revoke/)

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes("Trust this folder?"))

    // For the folder the question was about, which is the one in view.
    expect(fixture.updates).toEqual([{ directory, trust: true, persist: true }])
    expect(fixture.status().trusted).toBe(true)
    expect(fixture.exits).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("another folder that is not trusted offers Not now, and trusting it says only that it is trusted", async () => {
  const fixture = await elsewhere()

  try {
    await fixture.app.waitForFrame((frame) => asksAbout(frame, away.directory))
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("Not now")
    expect(frame).not.toContain("Exit")
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await until(() => fixture.toast().currentToast !== null)

    expect(fixture.toast().currentToast).toMatchObject({ variant: "success", message: "Trusted /elsewhere/other-clone" })
    expect(fixture.updates).toEqual([{ directory: away.directory, trust: true, persist: true }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("enter on its own is not now, so a keystroke typed ahead of the dialog never trusts the folder", async () => {
  const fixture = await elsewhere()

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
  // The home directory, which is never trusted for good.
  const fixture = await renderTrust({ ...untrusted, directory: "/tmp/orbit/home", persistent: false })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes("Trust this folder?"))
    const frame = fixture.app.captureCharFrame()
    expect(frame).toContain("Trust until Orbit restarts")
    expect(frame).not.toMatch(/Trust this folder(?!\?)/)
    expect(frame).toContain("Exit")
    // What the choice costs: how long it lasts, on the shared service, and what ends it early.
    expect(frame).toContain("until the service restarts")
    expect(frame).toMatch(/orb\s+trust\s+--\s*revoke/)

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes("Trust this folder?"))

    expect(fixture.updates).toEqual([{ directory, trust: true, persist: false }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test.each([
  ["not now is chosen", (fixture: Fixture) => fixture.app.mockInput.pressEnter()],
  ["the dialog is dismissed", (fixture: Fixture) => fixture.app.mockInput.pressEscape()],
])("it does not reopen on the next status refresh once %s", async (_, answer) => {
  const fixture = await elsewhere()

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
      data: { directory: away.directory, trusted: false },
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
  const fixture = await elsewhere({ refuse: true })

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await until(() => fixture.toast().currentToast !== null)

    expect(fixture.toast().currentToast).toMatchObject({ variant: "error", message: expect.stringContaining("503") })
    expect(fixture.app.captureCharFrame()).toContain(title)
    expect(fixture.updates).toEqual([{ directory: away.directory, trust: true, persist: true }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("the question can be asked again after not now", async () => {
  const fixture = await elsewhere()

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

// D8: a trusted folder is never asked about again, and a server older than this client that still lists the changes
// since the grant, or config in a folder above the project, asks nothing either.
test("a trusted folder is not asked about, whatever an older server lists for it", async () => {
  const file = "/tmp/orbit/orbit.json"
  for (const status of [
    trusted,
    { ...trusted, withheld: [{ path: file, kinds: ["hooks"] }], changed: [{ path: file, kinds: ["hooks"] }] },
    { ...trusted, withheld: [{ path: "/tmp/orbit.json", kinds: ["hooks"], directory: "/tmp" }] },
  ] as TrustStatus[]) {
    const fixture = await renderTrust(status)

    try {
      await until(() => fixture.reads() > 0)
      await fixture.app.renderOnce()
      const frame = fixture.app.captureCharFrame()
      expect(frame).not.toContain(title)
      expect(frame).not.toContain("Trust the changes?")
      expect(fixture.trust().held()).toBe(false)
    } finally {
      fixture.app.renderer.destroy()
    }
  }
})

test("the question waits for the dialog a person is already in", async () => {
  const fixture = await elsewhere({ busy: true })

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
  const fixture = await elsewhere()

  try {
    await fixture.app.waitForFrame((frame) => frame.includes(title))
    fixture.trustElsewhere(away.directory)
    fixture.events.emit({
      id: "evt_trust",
      created: 1,
      type: "trust.updated",
      data: { directory: away.directory, trusted: true },
    })
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.updates).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("the question closes when another folder comes into view, so no choice is made for a folder that was not shown", async () => {
  const held = Promise.withResolvers<void>()
  const fixture = await renderTrust(untrusted, { away: { status: away, held: held.promise } })

  try {
    await fixture.app.waitForFrame((frame) => asksAbout(frame, untrusted.directory))

    // What is known of the other folder is not in yet.
    fixture.view(away.directory)
    await fixture.app.waitForFrame((frame) => !frame.includes(title))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.renderOnce()
    expect(fixture.updates).toEqual([])
    // Nobody answered the question that closed, so the terminal UI does not end.
    expect(fixture.exits).toEqual([])

    // The question comes back for the folder now in view once it is known, and a choice is for that folder.
    held.resolve()
    await fixture.app.waitForFrame((frame) => asksAbout(frame, away.directory))
    fixture.app.mockInput.pressArrow("up")
    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))

    expect(fixture.updates).toEqual([{ directory: away.directory, trust: true, persist: true }])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("not now holds for the folder it was said for, and the folder that was left is asked about when it is back", async () => {
  const fixture = await renderTrust(untrusted, { away: { status: away } })

  try {
    await fixture.app.waitForFrame((frame) => asksAbout(frame, untrusted.directory))
    fixture.view(away.directory)
    await fixture.app.waitForFrame((frame) => asksAbout(frame, away.directory))

    fixture.app.mockInput.pressEnter()
    await fixture.app.waitForFrame((frame) => !frame.includes(title))
    await fixture.app.renderOnce()
    // The folder that was just declined is not asked about again.
    expect(fixture.app.captureCharFrame()).not.toContain(title)

    // Leaving the first folder was not an answer about it.
    fixture.view(directory)
    await fixture.app.waitForFrame((frame) => asksAbout(frame, untrusted.directory))
    expect(fixture.updates).toEqual([])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("a grant that is answered once another folder is in view leaves the question about that folder open", async () => {
  const answer = Promise.withResolvers<void>()
  const fixture = await renderTrust(untrusted, { away: { status: away }, granting: answer.promise })

  try {
    await fixture.app.waitForFrame((frame) => asksAbout(frame, untrusted.directory))
    // The question about the folder the terminal UI started in starts on Trust.
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

type Fixture = Awaited<ReturnType<typeof renderTrust>>

async function renderTrust(
  initial: TrustStatus,
  options?: {
    busy?: boolean
    refuse?: boolean
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
  // Why the terminal UI was asked to end, each time it was.
  const exits: unknown[] = []
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
      withheld: [],
    }
    statuses.set(folder, granted)
    return json(granted)
  }, events)

  // What a route does: ask whenever the folder in view is not trusted.
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
        <ExitProvider exit={(reason) => void exits.push(reason)}>
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
        </ExitProvider>
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
    exits,
    status,
    reads: () => reads,
    trust: () => trust,
    toast: () => toast,
    // What a session does when it opens: puts another folder in view.
    view: (folder: string) => location.set({ directory: folder }),
    trustElsewhere(folder = directory) {
      const known = statuses.get(folder) ?? initial
      statuses.set(folder, { ...known, trusted: true, source: "saved", withheld: [] })
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
