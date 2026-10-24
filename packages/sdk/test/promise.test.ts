import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Orbit, Session } from "../src"

test("Promise host uses the embedded router", async () => {
  await using directory = await tmpdir("orbit-promise-sdk-")
  const config = join(directory.path, "config")
  await mkdir(config)
  const orbit = await Orbit.create({
    events: { persist: true },
    config: { directory: config, project: false, content: "{}" },
    trust: { implicit: true },
  })

  try {
    const location = { directory: directory.path }
    const session = await orbit.sessions.create({ location })
    const selected = await orbit.sessions.get({ sessionID: session.id })
    const page = await orbit.sessions.list({ directory: directory.path })
    const events = Array.fromAsync(orbit.sessions.log({ sessionID: session.id }))

    expect(selected.id).toBe(session.id)
    expect(page.data.some((item) => item.id === session.id)).toBe(true)
    expect((await events).some((event) => event.type === "session.created")).toBe(true)

    const missingSessionID = Session.ID.create()
    const missing = await orbit.sessions.get({ sessionID: missingSessionID }).catch((error: unknown) => error)
    expect(missing).toMatchObject({ _tag: "SessionNotFoundError", sessionID: missingSessionID })
  } finally {
    await orbit.close()
    await orbit.close()
  }
})

test("Promise event streams support cancellation", async () => {
  await using directory = await tmpdir("orbit-promise-stream-")
  const config = join(directory.path, "config")
  await mkdir(config)
  {
    await using orbit = await Orbit.create({ config: { directory: config, project: false, content: "{}" } , trust: { implicit: true } })
    const controller = new AbortController()
    const events = orbit.events.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    expect(await events.next()).toMatchObject({ value: { type: "server.connected" }, done: false })
    const pending = events.next()
    controller.abort()
    const error = await pending.catch((error: unknown) => error)
    expect(error).toMatchObject({ name: "ClientError", reason: "Transport" })
    await events.return?.()
  }
})

test("closing cancels active Promise event streams", async () => {
  await using directory = await tmpdir("orbit-promise-stream-close-")
  const config = join(directory.path, "config")
  await mkdir(config)
  const orbit = await Orbit.create({ config: { directory: config, project: false, content: "{}" } , trust: { implicit: true } })
  const events = orbit.events.subscribe()[Symbol.asyncIterator]()
  expect(await events.next()).toMatchObject({ value: { type: "server.connected" }, done: false })
  // The read rejects as soon as close() aborts the stream, before close() has finished disposing the host. Disposal may
  // yield to the event loop (Effect yields a fiber every 2048 operations), so the rejection is caught here, not after
  // close(), or Bun reports it as unhandled.
  const pending = events.next().catch((error: unknown) => error)

  await orbit.close()
  expect(await pending).toMatchObject({ name: "ClientError", reason: "Transport" })
})
