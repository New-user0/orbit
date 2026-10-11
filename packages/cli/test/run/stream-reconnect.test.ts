import { describe, expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client/promise"
import { runStream } from "../../src/run/stream"

// The stream driver against a client whose event stream the test controls: it can end the stream, refuse the next
// subscription, and change what the server lists meanwhile. The rest of the client answers from the test's state, so the
// driver's own decisions are what is under test. Every test has a deadline, because a driver that waits for an event it
// missed would otherwise hang the runner.
const sessionID = "ses_reconnect"
const location = { directory: "/work" }

type Event = Record<string, unknown>

function permission(id: string, session = sessionID) {
  return { id, sessionID: session, action: "Edit", resources: ["a.txt"], source: { type: "tool", messageID: "msg_a", id: "c" } }
}

function harness(options: { reconnect?: { baseMs: number; capMs: number; giveUpMs: number } } = {}) {
  const lines: Array<Record<string, any>> = []
  const raw: string[] = []
  const state = {
    permissions: [] as Array<ReturnType<typeof permission>>,
    messages: [] as Array<Record<string, unknown>>,
    admitted: [] as string[],
    replies: [] as Array<{ requestID: string; decision: string; message?: string }>,
    subscriptions: 0,
    // How the next subscription behaves: it connects, or fails with this error.
    refuse: undefined as unknown,
    promptError: undefined as Error | undefined,
  }
  let push: (event: Event | "end") => void = () => {}
  let idle = Promise.withResolvers<void>()
  const subscribe = (options?: { signal?: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      state.subscriptions += 1
      if (state.refuse !== undefined) throw state.refuse
      yield { type: "server.connected" }
      const queue: Array<Event | "end"> = []
      let wake = () => {}
      push = (event) => {
        queue.push(event)
        wake()
      }
      options?.signal?.addEventListener("abort", () => wake())
      // Like the real stream, an abort ends it.
      options?.signal?.addEventListener("abort", () => queue.push("end"))
      while (true) {
        while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
        const next = queue.shift()
        if (next === "end") return
        if (next) yield next
      }
    },
  })
  const client = {
    event: { subscribe },
    session: {
      get: async () => ({ id: sessionID }),
      interrupt: async () => ({}),
      wait: () => idle.promise,
      inbox: { list: async () => [] },
      form: { list: async () => [], cancel: async () => {}, reply: async () => {} },
      prompt: async (input: { id: string }) => {
        if (state.promptError) throw state.promptError
        state.admitted.push(input.id)
        return { payload: {} }
      },
    },
    permission: {
      list: async () => [...state.permissions],
      reply: async (input: { requestID: string; decision: string; message?: string }) => {
        state.replies.push(input)
        state.permissions = state.permissions.filter((request) => request.id !== input.requestID)
      },
    },
    message: { list: async () => ({ data: [...state.messages], cursor: { next: null } }) },
    form: { list: async () => ({ location, data: [] }) },
  } as unknown as OrbitClient

  const input = Promise.withResolvers<void>()
  const typed: string[] = []
  const stdin = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (typed.length > 0) yield new TextEncoder().encode(typed.shift() ?? "")
        if (closed) return
        await Promise.race([input.promise.then(() => {}), Bun.sleep(20)])
      }
    },
  }
  let closed = false
  const run = runStream({
    client,
    sessionID,
    location,
    thinking: false,
    auto: false,
    attached: true,
    envelope: { cwd: "/work", version: "test" },
    stdin,
    resolveFile: async () => ({ url: "data:text/plain;base64,", filename: "a", mime: "text/plain" }),
    write: (line) => {
      raw.push(line)
      lines.push(JSON.parse(line))
    },
    reconnect: options.reconnect ?? { baseMs: 10, capMs: 20, giveUpMs: 60_000 },
  })
  const api = {
    lines,
    raw,
    state,
    run,
    send: (value: unknown) => typed.push(JSON.stringify(value) + "\n"),
    close: () => {
      closed = true
      input.resolve()
    },
    emit: (event: Event) => push(event),
    drop: () => push("end"),
    idle: () => idle.resolve(),
    async until(match: (line: Record<string, any>) => boolean, ms = 10_000) {
      const deadline = Date.now() + ms
      while (!lines.some(match)) {
        if (Date.now() > deadline) throw new Error(`No matching line. Lines: ${JSON.stringify(lines)}`)
        await Bun.sleep(10)
      }
    },
    async settle(ms = 10_000) {
      return Promise.race([run, Bun.sleep(ms).then(() => Promise.reject(new Error(`The driver did not return. ${JSON.stringify(lines)}`)))])
    },
  }
  return api
}

const delivered = (inboxID: string): Event => ({
  id: "evt_delivered",
  created: 1,
  type: "session.inbox.delivered",
  data: { sessionID, inboxID },
})

const succeeded: Event = { id: "evt_done", created: 3, type: "session.execution.succeeded", data: { sessionID } }

const asked = (request: ReturnType<typeof permission>): Event => ({
  id: `evt_${request.id}`,
  created: 2,
  type: "permission.asked",
  data: request,
})

const replied = (requestID: string): Event => ({
  id: `evt_replied_${requestID}`,
  created: 2,
  type: "permission.replied",
  data: { sessionID, requestID, reply: "reject" },
})

// The history of one finished busy period, newest first as the server lists it.
function finished(inboxID: string, text: string) {
  return [
    { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 5 } },
    {
      id: "msg_assistant",
      type: "assistant",
      finish: "stop",
      content: [{ type: "text", text }],
      time: { created: 4 },
    },
    { id: inboxID, type: "user", text: "go", time: { created: 3 } },
  ]
}

const requests = (lines: Array<Record<string, any>>) => lines.filter((line) => line.type === "permission_request")

describe("the event stream drops and comes back", () => {
  test("an ask that arose during the gap is shown once, and then the stream is reported as reconnected", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    h.state.permissions = [permission("per_gap")]
    h.drop()
    await h.until((line) => line.type === "system" && line.subtype === "reconnected")

    expect(requests(h.lines).map((line) => line.request.id)).toEqual(["per_gap"])
    expect(h.lines.findIndex((line) => line.type === "permission_request")).toBeLessThan(
      h.lines.findIndex((line) => line.type === "system"),
    )
    // The server sends it again as an event as well: the driver has shown it already.
    h.emit(asked(permission("per_gap")))
    await Bun.sleep(100)
    expect(requests(h.lines)).toHaveLength(1)

    h.state.messages = finished(h.state.admitted[0], "done")
    h.close()
    await Bun.sleep(100)
    h.emit(succeeded)
    h.idle()
    expect(await h.settle()).toBe(0)
    // The ask was still open when the input closed, so it was rejected with feedback.
    expect(h.state.replies).toEqual([expect.objectContaining({ requestID: "per_gap", decision: "reject" })])
  }, 30_000)

  test("an ask shown before the drop is not shown again, and one settled during the gap is withdrawn", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    h.emit(asked(permission("per_open")))
    h.emit(asked(permission("per_settled")))
    await h.until((line) => line.type === "permission_request" && line.request.id === "per_settled")
    h.state.permissions = [permission("per_open")]
    h.drop()
    await h.until((line) => line.type === "system")

    expect(requests(h.lines).map((line) => line.request.id)).toEqual(["per_open", "per_settled"])
    expect(h.lines.filter((line) => line.type === "request_cancelled")).toEqual([
      expect.objectContaining({ kind: "permission", id: "per_settled", sessionID }),
    ])

    h.state.messages = finished(h.state.admitted[0], "done")
    h.close()
    await Bun.sleep(100)
    h.emit(succeeded)
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)

  test("a busy period that ended during the gap still gets its result", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    // The run ends while the stream is down: no execution event will ever arrive.
    h.state.messages = finished(h.state.admitted[0], "finished in the gap")
    h.drop()
    await h.until((line) => line.type === "result")

    expect(h.lines.filter((line) => line.type === "result")).toEqual([
      expect.objectContaining({ result: "finished in the gap", outcome: "succeeded", is_error: false }),
    ])
    expect(h.lines.findIndex((line) => line.type === "result")).toBeLessThan(
      h.lines.findIndex((line) => line.type === "system"),
    )
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)

  test("a server that never comes back gives an error line, a failed result and exit 1", async () => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 150 } })
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.state.refuse = new Error("connection refused")
    h.drop()

    expect(await h.settle()).toBe(1)
    expect(h.lines.filter((line) => line.type === "error")).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining("did not come back") }) }),
    ])
    expect(h.lines.filter((line) => line.type === "result")).toEqual([
      expect.objectContaining({ is_error: true, outcome: "failed", reason: "error" }),
    ])
    expect(h.state.subscriptions).toBeGreaterThan(2)
  }, 30_000)

  test.each([401, 403, 404])("a %i answer is permanent and is not retried", async (status) => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000 } })
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.state.refuse = Object.assign(new Error("Unexpected status"), { cause: { status } })
    h.drop()

    expect(await h.settle()).toBe(1)
    expect(h.state.subscriptions).toBe(2)
    expect(h.lines.filter((line) => line.type === "result")).toHaveLength(1)
  }, 30_000)

  test("a status that may pass is retried", async () => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000 } })
    await Bun.sleep(100)
    h.state.refuse = Object.assign(new Error("Unexpected status"), { cause: { status: 503 } })
    h.drop()
    await Bun.sleep(200)
    expect(h.state.subscriptions).toBeGreaterThan(2)
    h.state.refuse = undefined
    await h.until((line) => line.type === "system")
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)
})

describe("what a failure says reaches the controller as a line that holds no control character", () => {
  test("the message of a refused operation is written out", async () => {
    const h = harness()
    h.state.promptError = new Error("evil\u001b]0;pwned\u0007\u009b31m   ‮")
    h.send({ type: "user", text: "go" })
    await h.until((line) => line.type === "error")

    expect(h.lines.find((line) => line.type === "error")?.error).toMatchObject({ type: "input_failed", input: "user" })
    expect(h.lines.find((line) => line.type === "error")?.error.message).toContain("evil")
    h.raw.forEach((line) => expect(/[\p{C}\p{Zl}\p{Zp}]/u.test(line)).toBe(false))
    h.close()
    h.idle()
    await h.settle()
  }, 30_000)
})
