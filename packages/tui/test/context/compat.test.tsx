/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ClientProvider, useClient } from "../../src/context/client"
import { createCompat } from "../../src/context/compat"
import { createApi, createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"

async function wait(condition: () => boolean, timeout = 3_000, label = "condition") {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

const answering = (compatibility: boolean) => () => json({ compatibility })

// Renders `createCompat` against a server whose answer to config.effective is `server.answer`, which a test may replace.
async function renderCompat(input: { answer?: () => Response | Promise<Response>; env?: Record<string, string> } = {}) {
  const events = createEventStream()
  const requests: URL[] = []
  const server = { answer: input.answer ?? answering(true) }
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/config/effective") return undefined
    requests.push(url)
    return server.answer()
  }, events)
  let compat!: () => boolean
  let connected!: () => boolean

  function Probe() {
    const client = useClient()
    connected = () => client.connection.status() === "connected"
    // The environment is passed in, so what the machine running the test exports cannot decide the outcome.
    compat = createCompat({ client, directory, env: input.env ?? {} })
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
  // Mounting asks once and the first server.connected event, which arrives a moment later, asks again. Let both land
  // before a test changes the answer, or the late one could stand in for the read the test is waiting for.
  let seen = -1
  while (seen !== requests.length) {
    seen = requests.length
    await Bun.sleep(100)
  }
  return {
    server,
    requests,
    compat: () => compat(),
    configUpdated: () => events.emit({ id: "evt_config_updated", created: 1, type: "config.updated", data: {} }),
    disconnect: () => events.disconnect(),
    destroy: () => setup.renderer.destroy(),
  }
}

test("is off until the server answers, then follows the answer for the TUI's directory", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const setup = await renderCompat({ answer: () => gate.then(answering(true)) })
  try {
    expect(setup.requests.length).toBeGreaterThan(0)
    // The server resolves the directory like any other location.
    expect(setup.requests[0]?.searchParams.get("location[directory]")).toBe(directory)
    expect(setup.compat()).toBe(false)

    release()
    await wait(() => setup.compat(), 3_000, "the server's answer")
  } finally {
    release()
    setup.destroy()
  }
})

test("stays off when the server says compatibility is off", async () => {
  const setup = await renderCompat({ answer: answering(false) })
  try {
    await wait(() => setup.requests.length > 0, 3_000, "a request")
    await Bun.sleep(50)

    expect(setup.compat()).toBe(false)
  } finally {
    setup.destroy()
  }
})

test("asks again when the configuration changes", async () => {
  const setup = await renderCompat()
  try {
    await wait(() => setup.compat(), 3_000, "the first answer")

    setup.server.answer = answering(false)
    setup.configUpdated()
    await wait(() => !setup.compat(), 3_000, "compatibility to turn off")

    setup.server.answer = answering(true)
    setup.configUpdated()
    await wait(() => setup.compat(), 3_000, "compatibility to turn back on")
  } finally {
    setup.destroy()
  }
})

test("asks again after the event stream reconnects", async () => {
  const setup = await renderCompat()
  try {
    await wait(() => setup.compat(), 3_000, "the first answer")
    const before = setup.requests.length

    // A server that restarted may have been started with a different environment, and sends no config.updated.
    setup.server.answer = answering(false)
    setup.disconnect()
    await wait(() => !setup.compat(), 5_000, "the answer after reconnecting")
    expect(setup.requests.length).toBeGreaterThan(before)
  } finally {
    setup.destroy()
  }
})

test("keeps the last answer when a later read fails", async () => {
  const setup = await renderCompat()
  try {
    await wait(() => setup.compat(), 3_000, "the first answer")
    const before = setup.requests.length

    setup.server.answer = () => new Response("unavailable", { status: 503 })
    setup.configUpdated()
    await wait(() => setup.requests.length > before, 3_000, "the second request")
    await Bun.sleep(50)

    expect(setup.compat()).toBe(true)
  } finally {
    setup.destroy()
  }
})

test("stays off when the server cannot answer, as an older server cannot", async () => {
  const setup = await renderCompat({ answer: () => new Response("not found", { status: 404 }) })
  try {
    await wait(() => setup.requests.length > 0, 3_000, "a request")
    await Bun.sleep(50)

    expect(setup.compat()).toBe(false)
  } finally {
    setup.destroy()
  }
})

for (const value of ["1", "true", "TRUE"])
  test(`is off without asking when ORBIT_DISABLE_COMPAT is ${value} here`, async () => {
    const setup = await renderCompat({ env: { ORBIT_DISABLE_COMPAT: value } })
    try {
      setup.configUpdated()
      await Bun.sleep(100)

      // The server would say yes, and the TUI never put the question to it.
      expect(setup.compat()).toBe(false)
      expect(setup.requests).toEqual([])
    } finally {
      setup.destroy()
    }
  })
