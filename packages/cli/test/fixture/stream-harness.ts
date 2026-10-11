import type { OrbitClient, SessionTurnOptions } from "@orbit/client/promise"
import { runStream } from "../../src/run/stream"

// The stream driver against a client whose event stream the test controls: it can end the stream, refuse the next
// subscription, and change what the server lists meanwhile. The rest of the client answers from the test's state, so the
// driver's own decisions are what is under test. Every test has a deadline, because a driver that waits for an event it
// missed would otherwise hang the runner.
export const sessionID = "ses_reconnect"
export const location = { directory: "/work" }

export type Event = Record<string, unknown>

export function permission(id: string, session = sessionID) {
  return {
    id,
    sessionID: session,
    action: "Edit",
    resources: ["a.txt"],
    source: { type: "tool", messageID: "msg_a", id: "c" },
  }
}

export function harness(
  options: {
    reconnect?: { baseMs: number; capMs: number; giveUpMs: number; silenceMs?: number }
    turn?: SessionTurnOptions
    // Leave the writer out, so the driver writes to process.stdout itself.
    stdout?: boolean
  } = {},
) {
  const lines: Array<Record<string, any>> = []
  const raw: string[] = []
  const state = {
    permissions: [] as Array<ReturnType<typeof permission>>,
    messages: [] as Array<Record<string, unknown>>,
    admitted: [] as string[],
    replies: [] as Array<{ requestID: string; decision: string; message?: string }>,
    subscriptions: 0,
    interrupts: 0,
    // How the next subscription behaves: it connects, or fails with this error.
    refuse: undefined as unknown,
    promptError: undefined as Error | undefined,
    // Whether the server echoes the limits it was sent, as a current one does.
    echo: true,
    prompts: [] as Array<{ id: string; turn?: SessionTurnOptions }>,
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
      interrupt: async () => {
        state.interrupts += 1
        return {}
      },
      wait: () => idle.promise,
      inbox: { list: async () => [] },
      form: { list: async () => [], cancel: async () => {}, reply: async () => {} },
      prompt: async (input: { id: string; turn?: SessionTurnOptions }) => {
        if (state.promptError) throw state.promptError
        state.admitted.push(input.id)
        state.prompts.push(input)
        return { payload: { turn: state.echo ? input.turn : undefined } }
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
    turn: options.turn,
    envelope: { cwd: "/work", version: "test" },
    stdin,
    resolveFile: async () => ({ url: "data:text/plain;base64,", filename: "a", mime: "text/plain" }),
    write: options.stdout
      ? undefined
      : (line) => {
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
      return Promise.race([
        run,
        Bun.sleep(ms).then(() => Promise.reject(new Error(`The driver did not return. ${JSON.stringify(lines)}`))),
      ])
    },
  }
  return api
}

export const delivered = (inboxID: string): Event => ({
  id: "evt_delivered",
  created: 1,
  type: "session.inbox.delivered",
  data: { sessionID, inboxID },
})

export const succeeded: Event = { id: "evt_done", created: 3, type: "session.execution.succeeded", data: { sessionID } }

export const asked = (request: ReturnType<typeof permission>): Event => ({
  id: `evt_${request.id}`,
  created: 2,
  type: "permission.asked",
  data: request,
})

export const replied = (requestID: string): Event => ({
  id: `evt_replied_${requestID}`,
  created: 2,
  type: "permission.replied",
  data: { sessionID, requestID, reply: "reject" },
})

// The history of one finished busy period, newest first as the server lists it.
export function finished(inboxID: string, text: string) {
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
