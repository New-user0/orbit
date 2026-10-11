import { describe, expect, test } from "bun:test"
import { Orbit } from "@orbit/client/promise"
import { runStream } from "../../src/run/stream"

// The reconnect path against the real generated client and a server that really answers with the statuses and bodies
// the API declares, because a fake client throws whatever shape the test gives it and the real one throws another.
const sessionID = "ses_real"
const location = { directory: "/work" }

// The first subscription connects and ends; each later one is answered with the given status and declared body.
function server(answer: { status: number; body: unknown }) {
  const seen = { subscriptions: 0 }
  const fixture = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/event") return Response.json({}, { status: 404 })
      seen.subscriptions += 1
      if (seen.subscriptions > 1) return Response.json(answer.body, { status: answer.status })
      return new Response(`data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return { seen, fixture }
}

async function drive(url: string) {
  const lines: Array<Record<string, any>> = []
  const done = Promise.withResolvers<void>()
  const stdin = {
    async *[Symbol.asyncIterator]() {
      await done.promise
    },
  }
  const run = runStream({
    client: Orbit.make({ baseUrl: url }),
    sessionID,
    location,
    thinking: false,
    auto: false,
    attached: true,
    envelope: { cwd: "/work", version: "test" },
    stdin,
    resolveFile: async () => ({ url: "data:text/plain;base64,", filename: "a", mime: "text/plain" }),
    write: (line) => lines.push(JSON.parse(line)),
    reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000 },
  })
  const code = await Promise.race([run, Bun.sleep(8_000).then(() => "still running" as const)])
  done.resolve()
  return { code, lines }
}

describe("a refused credential or route ends the run instead of being retried", () => {
  test.each([
    [401, { _tag: "UnauthorizedError", message: "Authentication required" }],
    [400, { _tag: "BadRequestError", message: "Bad request" }],
  ] as const)(
    "the declared %i answer",
    async (status, body) => {
      const { seen, fixture } = server({ status, body })
      try {
        const result = await drive(fixture.url.toString().replace(/\/$/, ""))
        if (status === 401) {
          expect(result.code).toBe(1)
          // One for the connection that dropped and one that was refused; none after it.
          expect(seen.subscriptions).toBe(2)
          expect(result.lines.filter((line) => line.type === "result")).toHaveLength(1)
          return
        }
        // A status that may pass is retried, so the driver is still reconnecting when the deadline comes.
        expect(result.code).toBe("still running")
        expect(seen.subscriptions).toBeGreaterThan(3)
      } finally {
        await fixture.stop(true)
      }
    },
    30_000,
  )

  test("an undeclared 403 and 404", async () => {
    for (const status of [403, 404]) {
      const { seen, fixture } = server({ status, body: {} })
      try {
        const result = await drive(fixture.url.toString().replace(/\/$/, ""))
        expect({ status, code: result.code, subscriptions: seen.subscriptions }).toEqual({
          status,
          code: 1,
          subscriptions: 2,
        })
      } finally {
        await fixture.stop(true)
      }
    }
  }, 30_000)
})

// A stream that stays open: with keepalive comments the silence watchdog must be rearmed by each one, without them the
// stream is dead after the silence window and is reopened.
describe("the silence watchdog follows the keepalive comments", () => {
  async function open(heartbeat: boolean) {
    const seen = { subscriptions: 0 }
    const encoder = new TextEncoder()
    const fixture = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/api/event") return Response.json({}, { status: 404 })
        seen.subscriptions += 1
        let timer: ReturnType<typeof setInterval> | undefined
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n`,
                ),
              )
              if (heartbeat) timer = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 50)
            },
            cancel() {
              clearInterval(timer)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const lines: Array<Record<string, any>> = []
    const done = Promise.withResolvers<void>()
    const run = runStream({
      client: Orbit.make({ baseUrl: fixture.url.toString().replace(/\/$/, "") }),
      sessionID,
      location,
      thinking: false,
      auto: false,
      attached: true,
      envelope: { cwd: "/work", version: "test" },
      stdin: {
        async *[Symbol.asyncIterator]() {
          await done.promise
        },
      },
      resolveFile: async () => ({ url: "data:text/plain;base64,", filename: "a", mime: "text/plain" }),
      write: (line) => lines.push(JSON.parse(line)),
      reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000, silenceMs: 300 },
    })
    // Several silence windows.
    await Bun.sleep(1_200)
    const subscriptions = seen.subscriptions
    done.resolve()
    await Promise.race([run, Bun.sleep(3_000)])
    await fixture.stop(true)
    return {
      subscriptions,
      reconnected: lines.filter((line) => line.type === "system" && line.subtype === "reconnected").length,
    }
  }

  test("a stream with keepalive comments is never torn down", async () => {
    expect(await open(true)).toEqual({ subscriptions: 1, reconnected: 0 })
  }, 30_000)

  test("the same stream without them is reopened", async () => {
    const result = await open(false)
    expect(result.subscriptions).toBeGreaterThan(1)
    expect(result.reconnected).toBeGreaterThan(0)
  }, 30_000)
})
