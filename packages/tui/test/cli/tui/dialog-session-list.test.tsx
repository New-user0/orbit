/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { DialogSessionList } from "../../../src/component/dialog-session-list"
import { ConfigProvider } from "../../../src/config"
import { KeybindingsFile } from "../../../src/config/keybindings-file"
import { ArgsProvider } from "../../../src/context/args"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { TuiAppProvider } from "../../../src/context/runtime"
import { SessionTabsProvider } from "../../../src/context/session-tabs"
import { StorageProvider, useStorage } from "../../../src/context/storage"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

// Renders the real session list over a server that holds one session, with the keybindings file `file` applied.
async function mountList(file: object, options: { initialSearch?: string; title?: string } = {}) {
  // The `search` of each session list request that carried one, first to last.
  const searches: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      return json({ directory, project: { id: "proj_a", directory, canonical: directory } })
    }
    if (url.pathname !== "/api/session") return undefined
    const parentID = url.searchParams.get("parentID")
    if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
    const search = url.searchParams.get("search")
    if (search) searches.push(search)
    return json({
      data: [
        {
          id: "ses_a",
          projectID: "proj_a",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: options.title ?? "Only session",
          location: { directory: process.cwd() },
        },
      ],
      cursor: {},
    })
  }, createEventStream())
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const dialog = useDialog()
    storage = useStorage()
    onMount(() => dialog.replace(() => <DialogSessionList initialSearch={options.initialSearch} />))
    return null
  }

  const keybindings = KeybindingsFile.decode(JSON.stringify(file))
  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig({}, { keybindings })}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider directory={process.cwd()}>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitForFrame((frame) => frame.includes(options.title ? "Sessions" : "Only session"))
  return {
    app,
    searches,
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await storage.flush()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test("opens with the initial search typed into the filter, and the first search request carries it", async () => {
  await using list = await mountList({}, { initialSearch: "fix the build" })

  await list.app.waitForFrame((frame) => frame.includes("fix the build"))
  expect(list.searches[0]).toBe("fix the build")
  expect(new Set(list.searches)).toEqual(new Set(["fix the build"]))
})

test("an empty initial search shows the whole list", async () => {
  await using list = await mountList({}, { initialSearch: "" })

  expect(list.searches).toEqual([])
})

test("draws a session title without its control and format characters", async () => {
  // An erase-line, a right-to-left override and a line break, as a repository can name a session.
  await using list = await mountList({}, { title: "Fix\u001b[2Kbuild‮evil\nnext" })

  await list.app.waitForFrame((frame) => frame.includes("Fix"))
  const frame = list.app.captureCharFrame()
  expect(frame).not.toContain("‮")
  expect(frame).not.toContain("\u001b")
})

test("renames from ctrl+r in the session list, which the prompt's history search shares", async () => {
  await using list = await mountList({})

  list.app.mockInput.pressKey("r", { ctrl: true })
  await list.app.waitForFrame((frame) => frame.includes("Rename session"))
})

test("renames from the key that the session-list context of the keybindings file gives it", async () => {
  await using list = await mountList({ contexts: { "session-list": { "dialog.session.rename": "ctrl+alt+r" } } })

  // The stock key has gone to the context's own: it does nothing here, and the other opens the rename prompt.
  list.app.mockInput.pressKey("r", { ctrl: true })
  await list.app.renderOnce()
  await Bun.sleep(100)
  expect(list.app.captureCharFrame()).not.toContain("Rename session")
  list.app.mockInput.pressKey("r", { ctrl: true, meta: true })
  await list.app.waitForFrame((frame) => frame.includes("Rename session"))
})

test("renames from the stock key when the keybindings file names another context", async () => {
  await using list = await mountList({ contexts: { dialog: { "dialog.session.rename": "ctrl+alt+r" } } })

  list.app.mockInput.pressKey("r", { ctrl: true, meta: true })
  await list.app.renderOnce()
  await Bun.sleep(100)
  expect(list.app.captureCharFrame()).not.toContain("Rename session")
  list.app.mockInput.pressKey("r", { ctrl: true })
  await list.app.waitForFrame((frame) => frame.includes("Rename session"))
})

test("scopes sessions to the active session location", async () => {
  const active = "/tmp/orbit/project-b"
  const events = createEventStream()
  const requestedProjects: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") {
      const directory = url.searchParams.get("location[directory]") ?? process.cwd()
      const project = directory === active ? "proj_b" : "proj_a"
      return json({ directory, project: { id: project, directory, canonical: directory } })
    }
    if (url.pathname !== "/api/session") return undefined
    // Family syncs list children by parentID; only project-scoped list requests matter here.
    const parentID = url.searchParams.get("parentID")
    if (parentID && parentID !== "null") return json({ data: [], cursor: {} })
    const project = url.searchParams.get("project") ?? ""
    requestedProjects.push(project)
    return json({
      data: [
        {
          id: project === "proj_b" ? "ses_b" : "ses_a",
          projectID: project,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
          title: project === "proj_b" ? "Project B session" : "Project A session",
          location: { directory: project === "proj_b" ? active : process.cwd() },
        },
      ],
      cursor: {},
    })
  }, events)
  const temporary = await tmpdir()
  let storage!: ReturnType<typeof useStorage>

  function Probe() {
    const data = useData()
    const dialog = useDialog()
    const route = useRoute()
    storage = useStorage()
    onMount(() => {
      data.session.remember({
        id: "ses_active",
        projectID: "proj_b",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 3 },
        title: "Active session",
        location: { directory: active },
      })
      route.navigate({ type: "session", sessionID: "ses_active" })
      dialog.replace(() => <DialogSessionList />)
    })
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: temporary.path }}>
        <TuiAppProvider value={{ name: "test", version: "test", channel: "test" }}>
          <StorageProvider>
            <ArgsProvider>
              <ConfigProvider config={createTuiResolvedConfig()}>
                <Keymap.Provider>
                  <ToastProvider>
                    <RouteProvider>
                      <ClientProvider api={createApi(calls.fetch)}>
                        <PermissionProvider directory={process.cwd()}>
                          <DataProvider directory={process.cwd()}>
                            <LocationProvider>
                              <SessionTabsProvider>
                                <ThemeProvider mode="dark" source={emptyThemeSource}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </LocalProvider>
                                </ThemeProvider>
                              </SessionTabsProvider>
                            </LocationProvider>
                          </DataProvider>
                        </PermissionProvider>
                      </ClientProvider>
                    </RouteProvider>
                  </ToastProvider>
                </Keymap.Provider>
              </ConfigProvider>
            </ArgsProvider>
          </StorageProvider>
        </TuiAppProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    const frame = await app.waitForFrame((value) => value.includes("Project B session"))
    expect(frame).not.toContain("Project A session")
    expect(requestedProjects.at(-1)).toBe("proj_b")
  } finally {
    app.renderer.destroy()
    await storage.flush()
    await temporary[Symbol.asyncDispose]()
  }
})
