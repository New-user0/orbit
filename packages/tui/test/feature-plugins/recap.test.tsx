// clients-ux-27: the away summary in the terminal UI. Once focus has been gone for `session.recap.after_minutes`
// (cli.json, default 5, 0 turns it off), the session in view asks the server for a recap once; the recap is drawn as a dimmed `※` row through the body sanitizer. A refocus cancels the timer and drops a
// request in flight, a turn in progress defers it to the turn's end, and a terminal that never reports focus never asks.
import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { OrbitEvent } from "@orbit/client"
import { Effect, FileSystem, Schema } from "effect"
import { Global } from "@orbit/util/global"
import { Config } from "../../src/config"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { tmpdir } from "../fixture/fixture"

const sessionID = "ses_recap"
// 60 ms, so that a test waits a few delays rather than five minutes.
const delay = 0.001

type Message = Record<string, unknown> & { id: string; type: string }

async function start(input: {
  messages: Message[]
  afterMinutes?: number
  width?: number
  /** Text the first frame shows once the transcript has loaded. */
  ready?: string
  /** What the recap route does with a request; the default records it. */
  recap?: (request: Request) => Response | Promise<Response>
  /** Makes the session in view a subagent's session under this parent. */
  parentID?: string
  /** Blurs the terminal while the plugins still wait for the folder's trust, before the recap's slot has mounted. */
  blurWhileLoading?: boolean
}) {
  const state = await tmpdir()
  const setup = await createTestRenderer({ width: input.width ?? 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const session = {
    id: sessionID,
    title: "Recap",
    projectID: "project",
    ...(input.parentID ? { parentID: input.parentID } : {}),
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const requests: Request[] = []
  const events = createEventStream()
  // The plugins load only once the trust status has been read, so a blur sent with that read reaches the client before
  // the recap's slot mounts.
  let blurred = false
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/location/trust" && input.blurWhileLoading && !blurred) {
      blurred = true
      setup.renderer.emit("blur")
    }
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
    if (url.pathname === `/api/session/${sessionID}/message`) {
      // Pages newest first, as the server does, so a long session's first page can leave its last prompt out.
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      const end = offset + Number(url.searchParams.get("limit") ?? input.messages.length)
      return json({
        data: input.messages.toReversed().slice(offset, end),
        cursor: end < input.messages.length ? { next: String(end) } : {},
      })
    }
    if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
    if (input.parentID && url.pathname === `/api/session/${input.parentID}/message`) return json({ data: [], cursor: {} })
    if (request.method === "POST" && /^\/api\/session\/[^/]+\/recap$/.test(url.pathname)) {
      requests.push(request)
      return input.recap ? input.recap(request) : json({ recorded: true })
    }
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../src/app")
  const config = {
    animations: false,
    tabs: { mode: "off" as const },
    session: { recap: { after_minutes: input.afterMinutes ?? delay } },
  }
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => config, update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  await setup.waitForFrame((frame) => frame.includes(input.ready ?? "Fix the build"))
  let seq = 100
  return {
    ...setup,
    requests,
    blur: () => setup.renderer.emit("blur"),
    focus: () => setup.renderer.emit("focus"),
    recorded(text: string) {
      seq++
      events.emit({
        id: `evt_recap_${seq}`,
        created: Date.now(),
        type: "session.recap.recorded",
        durable: { aggregateID: sessionID, seq, version: 1 },
        data: { sessionID, text },
        location: { directory },
      } as OrbitEvent)
    },
    execution(
      type:
        | "session.execution.started"
        | "session.execution.succeeded"
        | "session.execution.failed"
        | "session.execution.interrupted",
      session = sessionID,
    ) {
      seq++
      events.emit({
        id: `evt_execution_${seq}`,
        created: Date.now(),
        type,
        durable: { aggregateID: session, seq, version: 1 },
        data:
          type === "session.execution.failed"
            ? { sessionID: session, error: { type: "provider", message: "The provider is unavailable" } }
            : type === "session.execution.interrupted"
              ? { sessionID: session, reason: "user" }
              : { sessionID: session },
        location: { directory },
      } as OrbitEvent)
    },
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await task
      await server.stop(true)
      await state[Symbol.asyncDispose]()
    },
  }
}

const user = (text: string, created = 1): Message => ({
  id: `msg_user_${created}`,
  type: "user",
  text,
  files: [],
  agents: [],
  time: { created },
})

const recap = (text: string, created = 2): Message => ({ id: `msg_recap_${created}`, type: "recap", text, time: { created } })

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
  return check()
}

test("session.recap.after_minutes defaults to the reference's five minutes and takes 0 to turn the recap off", () => {
  expect(Config.resolve({}, { terminalSuspend: true }).session.recap.after_minutes).toBe(5)
  expect(Config.resolve({ session: { recap: { after_minutes: 0 } } }, { terminalSuspend: true }).session.recap).toEqual({
    after_minutes: 0,
  })
  const decode = Schema.decodeUnknownOption(Config.Info)
  expect(decode({ session: { recap: { after_minutes: 2.5 } } })._tag).toBe("Some")
  expect(decode({ session: { recap: { after_minutes: -1 } } })._tag).toBe("None")
  // A delay past what a timer holds is taken, and the trigger waits the longest a timer can (recap-trigger.test.ts).
  expect(decode({ session: { recap: { after_minutes: 100_000 } } })._tag).toBe("Some")
  expect(
    Config.resolve({ session: { recap: { after_minutes: 100_000 } } }, { terminalSuspend: true }).session.recap,
  ).toEqual({ after_minutes: 100_000 })
})

test("after the delay the session asks for one recap, and blur cycles with no new prompt ask no more", async () => {
  await using app = await start({ messages: [user("Fix the build")] })
  app.blur()
  expect(await until(() => app.requests.length === 1)).toBe(true)
  // The server records it, and the event reaches this client.
  app.recorded("Fixing the build. Next: tests.")
  await app.waitForFrame((frame) => frame.includes("Next: tests."))

  app.focus()
  app.blur()
  await Bun.sleep(400)
  app.focus()
  app.blur()
  await Bun.sleep(400)
  expect(app.requests).toHaveLength(1)
})

// The client loads only the newest page of a long session, so a prompt behind many steps or notices is not in it. The
// server holds the transcript and decides, as the reference, which holds the whole transcript, would ask.
test("a prompt older than the loaded page of messages still lets the session ask", async () => {
  const notices = Array.from(
    { length: 30 },
    (_, index): Message => ({
      id: `msg_notice_${index + 2}`,
      type: "synthetic",
      text: `notice ${index + 2}`,
      description: `notice ${index + 2}`,
      time: { created: index + 2 },
    }),
  )
  await using app = await start({ messages: [user("Fix the build"), ...notices], ready: "notice 31" })
  app.blur()
  expect(await until(() => app.requests.length === 1)).toBe(true)
})

test("a session resumed with a recap after its last prompt asks for none", async () => {
  await using app = await start({ messages: [user("Fix the build"), recap("Fixing the build.")] })
  app.blur()
  await Bun.sleep(400)
  expect(app.requests).toHaveLength(0)
})

// The reference recaps the main conversation whichever transcript is shown. A subagent's session opens in the same
// route, so while it is in view the recap, and its wait for a turn's end, follow the conversation that started it.
test("a subagent's session in view asks for the recap of the main conversation", async () => {
  const parentID = "ses_recap_parent"
  {
    await using app = await start({ messages: [user("Fix the build")], parentID })
    app.blur()
    expect(await until(() => app.requests.length === 1)).toBe(true)
    expect(new URL(app.requests[0]!.url).pathname).toBe(`/api/session/${parentID}/recap`)
  }
  {
    await using app = await start({ messages: [user("Fix the build")], parentID })
    app.execution("session.execution.started", parentID)
    app.blur()
    await Bun.sleep(400)
    // The subagent's own turn ending is not the end of the main conversation's turn.
    app.execution("session.execution.succeeded")
    await Bun.sleep(400)
    expect(app.requests).toHaveLength(0)
    app.execution("session.execution.succeeded", parentID)
    expect(await until(() => app.requests.length === 1)).toBe(true)
    expect(new URL(app.requests[0]!.url).pathname).toBe(`/api/session/${parentID}/recap`)
  }
})

// A terminal reports a blur once, when focus changes. The full TUI may still be loading its plugins then, so the recap
// reads the focus the client has recorded since it started, as the reference does when it mounts.
test("a terminal blurred while the TUI loads asks for the recap after the delay", async () => {
  await using app = await start({ messages: [user("Fix the build")], blurWhileLoading: true })
  expect(await until(() => app.requests.length === 1)).toBe(true)
})

test("a terminal that never reports focus never asks, and 0 minutes turns the recap off", async () => {
  {
    await using app = await start({ messages: [user("Fix the build")] })
    await Bun.sleep(400)
    expect(app.requests).toHaveLength(0)
  }
  {
    await using app = await start({ messages: [user("Fix the build")], afterMinutes: 0 })
    app.blur()
    await Bun.sleep(400)
    expect(app.requests).toHaveLength(0)
  }
})

test("coming back before the delay cancels the timer", async () => {
  await using app = await start({ messages: [user("Fix the build")], afterMinutes: 0.005 })
  app.blur()
  await Bun.sleep(50)
  app.focus()
  await Bun.sleep(600)
  expect(app.requests).toHaveLength(0)
})

test("coming back while the recap is being written drops the request", async () => {
  const aborted = Promise.withResolvers<void>()
  await using app = await start({
    messages: [user("Fix the build")],
    recap: (request) =>
      new Promise((resolve) =>
        request.signal.addEventListener("abort", () => {
          aborted.resolve()
          resolve(json({ recorded: false }))
        }),
      ),
  })
  app.blur()
  expect(await until(() => app.requests.length === 1)).toBe(true)
  app.focus()
  expect(
    await Promise.race([aborted.promise.then(() => "aborted"), Bun.sleep(3000).then(() => "still running")]),
  ).toBe("aborted")
})

test("a delay that ends during a turn waits for the turn's end, and asks then only if still blurred", async () => {
  // A turn that fails or is interrupted while the person is away ends it as surely as one that succeeds.
  for (const end of ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const) {
    await using app = await start({ messages: [user("Fix the build")] })
    app.execution("session.execution.started")
    app.blur()
    await Bun.sleep(400)
    expect(app.requests).toHaveLength(0)
    app.execution(end)
    expect({ end, asked: await until(() => app.requests.length === 1) }).toEqual({ end, asked: true })
    await Bun.sleep(200)
    expect(app.requests).toHaveLength(1)
  }
  {
    await using app = await start({ messages: [user("Fix the build")] })
    app.execution("session.execution.started")
    app.blur()
    await Bun.sleep(400)
    app.focus()
    app.execution("session.execution.succeeded")
    await Bun.sleep(400)
    expect(app.requests).toHaveLength(0)
  }
})

test("another session's turn ending does not send the request this session deferred", async () => {
  await using app = await start({ messages: [user("Fix the build")] })
  app.execution("session.execution.started")
  app.blur()
  await Bun.sleep(400)
  app.execution("session.execution.succeeded", "ses_recap_other")
  await Bun.sleep(400)
  expect(app.requests).toHaveLength(0)
  app.execution("session.execution.succeeded")
  expect(await until(() => app.requests.length === 1)).toBe(true)
})

test("a refused or failed recap shows nothing and leaves the session usable", async () => {
  await using app = await start({
    messages: [user("Fix the build")],
    recap: () =>
      json(
        { _tag: "UntrustedFolderError", directory, message: "This folder is not trusted" },
        { status: 403 },
      ),
  })
  app.blur()
  expect(await until(() => app.requests.length === 1)).toBe(true)
  await Bun.sleep(200)
  const frame = app.captureCharFrame()
  expect(frame).toContain("Fix the build")
  expect(frame).not.toContain("※")
  expect(frame).not.toContain("not trusted")
})

// Class 9: a recap is model text drawn from repository content. The server escapes it when it stores it, and the row
// draws it through the body sanitizer as well, so a recap from an older or hostile server cannot act on the terminal.
test.each([40, 120])("the recap row is a dimmed reference mark and sanitized text at width %s", async (width) => {
  await using app = await start({
    width,
    messages: [user("Fix the build"), recap("Fixing\u001b]0;pwned\u0007 the build\u202e.\rOVERWRITTEN")],
  })
  await app.waitForFrame((frame) => frame.includes("※"))
  await app.waitForVisualIdle()
  const frame = app.captureCharFrame()
  expect(frame).toMatch(/※\s+Fixing/)
  expect(frame).toContain("\\x1b")
  expect(frame).toContain("\\u{202e}")
  expect(frame).not.toContain("\u001b")
  expect(frame).not.toContain("\u202e")
  expect(frame).not.toContain("\r")
  // The row is muted text, as the reference dims it, and not a feedback colour.
  const span = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((item) => item.text.includes("Fixing"))
  const prompt = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((item) => item.text.includes("Fix the build"))
  expect(span?.fg.toInts()).toBeDefined()
  expect(span?.fg.toInts()).not.toEqual(prompt?.fg.toInts())
  // The mark is dimmed with the text.
  const mark = app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((item) => item.text.includes("※"))
  expect(mark?.fg.toInts()).toEqual(span?.fg.toInts())
})
