/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ClientProvider, useClient } from "../../src/context/client"
import { createPermissionMode, type PermissionMode } from "../../src/context/permission"
import { createApi, createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import { Toast, ToastProvider, useToast } from "../../src/ui/toast"
import { emptyThemeSource } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

async function wait(condition: () => boolean, timeout = 3_000, label = "condition") {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

// Renders `createPermissionMode` against a server whose answer to config.effective is `answer`.
async function render(input: { answer: () => Response | Promise<Response>; requested: PermissionMode }) {
  const events = createEventStream()
  const requests: URL[] = []
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/config/effective") return undefined
    requests.push(url)
    return input.answer()
  }, events)
  const toasts: string[] = []
  let mode!: () => PermissionMode
  let connected!: () => boolean

  function Probe() {
    const client = useClient()
    connected = () => client.connection.status() === "connected"
    mode = createPermissionMode({
      client,
      directory,
      requested: () => input.requested,
      toast: { show: (options) => void toasts.push(options.message) },
    })
    return <box />
  }

  const setup = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <Probe />
      </ClientProvider>
    </TestTuiContexts>
  ))
  await wait(() => connected(), 3_000, "the event stream")
  await wait(() => requests.length > 0, 3_000, "a request")
  await Bun.sleep(150)
  return { mode: () => mode(), toasts, requests, destroy: () => setup.renderer.destroy() }
}

const answering = (permissions?: { bypass: boolean; always: boolean }) => () =>
  json({ compatibility: true, ...(permissions ? { permissions } : {}) })

test("keeps auto-accept when managed settings leave it open, and says nothing", async () => {
  const setup = await render({ answer: answering({ bypass: true, always: true }), requested: "autoaccept" })
  try {
    await wait(() => setup.mode() === "autoaccept", 3_000, "auto-accept")
    expect(setup.toasts).toEqual([])
    expect(setup.requests[0]?.searchParams.get("location[directory]")).toBe(directory)
  } finally {
    setup.destroy()
  }
})

test("forces prompt and says why, once, when managed settings turn bypass off", async () => {
  const setup = await render({ answer: answering({ bypass: false, always: true }), requested: "autoaccept" })
  try {
    await wait(() => setup.toasts.length > 0, 3_000, "the toast")
    expect(setup.mode()).toBe("prompt")
    expect(setup.toasts).toHaveLength(1)
    expect(setup.toasts[0]).toContain("managed settings")
  } finally {
    setup.destroy()
  }
})

test("is prompt until the server answers", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/config/effective") return undefined
    return gate.then(answering({ bypass: true, always: true }))
  }, events)
  let mode!: () => PermissionMode
  const setup = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        {(() => {
          mode = createPermissionMode({
            client: useClient(),
            directory,
            requested: () => "autoaccept",
            toast: { show: () => {} },
          })
          return <box />
        })()}
      </ClientProvider>
    </TestTuiContexts>
  ))
  try {
    expect(mode()).toBe("prompt")
    release()
    await wait(() => mode() === "autoaccept", 3_000, "the answer")
  } finally {
    release()
    setup.renderer.destroy()
  }
})

test("counts a server that does not report it, or fails, as refusing", async () => {
  for (const answer of [answering(), () => new Response("unavailable", { status: 503 })]) {
    const setup = await render({ answer, requested: "autoaccept" })
    try {
      expect(setup.mode()).toBe("prompt")
    } finally {
      setup.destroy()
    }
  }
})

test("draws the managed-bypass toast on screen", async () => {
  const events = createEventStream()
  const calls = createFetch(
    (url) => (url.pathname === "/api/config/effective" ? answering({ bypass: false, always: true })() : undefined),
    events,
  )
  let connected: (() => boolean) | undefined
  function Probe() {
    const client = useClient()
    connected = () => client.connection.status() === "connected"
    createPermissionMode({ client, directory, requested: () => "autoaccept", toast: useToast() })
    return <Toast />
  }
  // The real toast needs a theme and the resolved config, as the application provides them.
  const setup = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({})}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <ToastProvider>
              <ClientProvider api={createApi(calls.fetch)}>
                <Probe />
              </ClientProvider>
            </ToastProvider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 20 },
  )
  try {
    await wait(() => connected?.() === true, 3_000, "the event stream")
    const started = Date.now()
    let frame = ""
    while (!frame.includes("managed") && Date.now() - started < 3_000) {
      await Bun.sleep(20)
      await setup.renderOnce()
      frame = setup.captureCharFrame()
    }
    expect(frame).toContain("Auto-accept is turned off")
    expect(frame).toContain("managed settings")
  } finally {
    setup.renderer.destroy()
  }
})

test("does not mention managed settings when prompt was what was asked for", async () => {
  const setup = await render({ answer: answering({ bypass: false, always: false }), requested: "prompt" })
  try {
    expect(setup.mode()).toBe("prompt")
    expect(setup.toasts).toEqual([])
  } finally {
    setup.destroy()
  }
})
