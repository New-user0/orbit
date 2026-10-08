import { expect } from "bun:test"
import { Session } from "@orbit/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
  })
  return (path: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://orbit.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const json: unknown = await response.json()
      expect({ status: response.status, json }).toMatchObject({ status: 200 })
      return json
    })
})

// A file brings its own display names, so the import escapes them like the live publisher. Dropping `plain` in
// SessionTransfer.import stores the raw characters and fails every row.
const cases = [
  ["a set-title sequence", "\u001b]0;pwned\u0007x", "\\x1b]0;pwned\\x07x"],
  ["an erase-line sequence", "a\u001b[2Kb", "a\\x1b[2Kb"],
  ["a C1 CSI", "a\u009bb", "a\\x9bb"],
  ["a right-to-left override", "a‮b", "a\\u{202e}b"],
] as const

cases.forEach(([label, hostile, escaped]) =>
  it.live(`escapes the display name of an imported tool part: ${label}`, () =>
  Effect.gen(function* () {
    const request = yield* setup
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
    const id = Session.ID.create()
    yield* request("/api/experimental/session/import", {
      info: { ...template.data, id },
      messages: [
        {
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { providerID: "test", id: "test" },
          content: [
            {
              type: "tool",
              id: "call_1",
              name: "mcp_tool",
              displayName: hostile,
              time: { created: 1, ran: 1, completed: 2 },
              state: { status: "completed", input: {}, metadata: {}, content: [{ type: "text", text: "ok" }] },
            },
          ],
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
      ],
    })
    const listed = (yield* request(`/api/session/${id}/message`)) as {
      data: { content: { displayName?: string }[] }[]
    }
    expect(listed.data[0]?.content[0]?.displayName).toBe(escaped)
  }).pipe(Effect.scoped),
  ),
)
