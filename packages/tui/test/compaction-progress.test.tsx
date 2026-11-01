// context-memory-2 part 2 (class 9): a running compaction row draws how long it has run and an estimate of the reply's
// tokens after 30 seconds, and never the reply itself. The count arrives as `session.compaction.delta`.
import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@orbit/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const sessionID = "ses_compaction_progress"

async function drawCompaction(input: {
  readonly width: number
  /** How long the compaction has been running when the screen opens. */
  readonly age: number
  /** The deltas the server sends once the row is drawn. */
  readonly deltas: readonly Record<string, unknown>[]
  readonly status?: "running" | "completed"
  /** A summary the row already holds while it runs, such as a stored one read back. */
  readonly summary?: string
  /** Extra time to let the clock run before the screen is read. */
  readonly wait?: number
  /** Called with the screen settled, before it is torn down. */
  readonly settled?: () => void
}) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: input.width, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const created = Date.now() - input.age
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Compaction progress fixture",
          agent: "build",
          model: { providerID: "demo", id: "model" },
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({
        data: [
          {
            id: "msg_compaction",
            type: "compaction",
            status: "running",
            reason: "manual",
            summary: input.summary ?? "",
            recent: "",
            time: { created },
          },
        ],
        cursor: {},
      })
    if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
      return json({ data: [] })
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await ready.promise
    await setup.waitForFrame((frame) => frame.includes("Compaction"))
    for (const delta of input.deltas)
      events.emit({
        id: `evt_${Math.random().toString(36).slice(2)}`,
        created: 2,
        type: "session.compaction.delta",
        data: { sessionID, ...delta },
        location: { directory },
      } as never)
    if (input.status === "completed")
      events.emit({
        id: "evt_ended",
        created: 3,
        type: "session.compaction.ended",
        durable: { aggregateID: sessionID, seq: 5 },
        data: { sessionID, reason: "manual", text: "Plain summary", recent: "" },
        location: { directory },
      } as never)
    // The deltas have no mark of their own on screen when they change nothing, so give them time to be handled.
    await Bun.sleep(200 + (input.wait ?? 0))
    await setup.renderOnce()
    input.settled?.()
    return setup.captureCharFrame()
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

const running = 31_000

test("the row's one-second clock stops when the compaction ends", async () => {
  // The clock is a timer, so the only way to see it stop is to watch the timers: a spy on the two functions that
  // start and stop it, restored at once.
  const started = new Set<unknown>()
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = realSet(...args)
    if (args[1] === 1000) started.add(id)
    return id
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((...args: Parameters<typeof clearInterval>) => {
    started.delete(args[0])
    return realClear(...args)
  }) as unknown as typeof clearInterval
  let open = -1
  try {
    await drawCompaction({
      width: 120,
      age: running,
      deltas: [{ characters: 4800 }],
      status: "completed",
      settled: () => {
        open = started.size
      },
    })
  } finally {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
  }
  expect(open).toBe(0)
}, 60_000)

test("a running compaction shows its elapsed time and estimated tokens after 30 seconds, never its reply", async () => {
  // (a) after 30 s with a count: elapsed time and characters / 4 as tokens (4800 -> 1200 -> "1.2K").
  const after = await drawCompaction({ width: 120, age: running, deltas: [{ characters: 4800 }] })
  expect(after).toContain("Compaction")
  expect(after).toMatch(/Compaction · 3\d(\.\d)?s · ↓ 1\.2K tokens/)

  // (b) before 30 s the row shows neither, whatever the count.
  const before = await drawCompaction({ width: 120, age: 1_000, deltas: [{ characters: 4800 }] })
  expect(before).toContain("Compaction")
  expect(before).not.toContain("tokens")
  expect(before).not.toMatch(/Compaction ·/)

  // (c) a zero count shows the elapsed time and no token figure.
  const zero = await drawCompaction({ width: 120, age: running, deltas: [{ characters: 0 }] })
  expect(zero).toMatch(/Compaction · 3\d(\.\d)?s/)
  expect(zero).not.toContain("tokens")

  // (d) a width the whole header does not fit drops the token figure first, then the elapsed time.
  const narrow = await drawCompaction({ width: 40, age: running, deltas: [{ characters: 4800 }] })
  expect(narrow).toMatch(/Compaction · 3\d(\.\d)?s/)
  expect(narrow).not.toContain("tokens")
  const narrower = await drawCompaction({ width: 24, age: running, deltas: [{ characters: 4800 }] })
  expect(narrower).toContain("Compaction")
  expect(narrower).not.toMatch(/Compaction ·/)
  expect(narrower).not.toContain("tokens")

  // (e) an older server sends the reply text and no count: the reply is never drawn and no figure appears.
  const old = await drawCompaction({ width: 120, age: running, deltas: [{ text: "HOSTILE-REPLY" }] })
  expect(old).toContain("Compaction")
  expect(old).not.toContain("HOSTILE-REPLY")
  expect(old).not.toContain("tokens")

  // (f) a summary the row already holds is not drawn while the compaction runs.
  const held = await drawCompaction({ width: 120, age: running, deltas: [], summary: "HELD-SUMMARY" })
  expect(held).toContain("Compaction")
  expect(held).not.toContain("HELD-SUMMARY")

  // (g) the clock keeps running: a row 1.5 s short of 30 seconds shows its time once it passes them.
  const early = await drawCompaction({ width: 120, age: 28_500, deltas: [{ characters: 4800 }] })
  expect(early).not.toMatch(/Compaction ·/)
  const ticked = await drawCompaction({ width: 120, age: 28_500, deltas: [{ characters: 4800 }], wait: 2_500 })
  expect(ticked).toMatch(/Compaction · 3\d(\.\d)?s · ↓ 1\.2K tokens/)

  // Trusted control: the completed row draws the stored summary.
  const done = await drawCompaction({ width: 120, age: running, deltas: [{ characters: 4800 }], status: "completed" })
  expect(done).toContain("Plain summary")
  expect(done).not.toContain("tokens")
  expect(done).not.toMatch(/Compaction ·/)
}, 60_000)
