import { expect } from "bun:test"
import { Session } from "@orbit/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    trust: { implicit: true },
  })
  return (path: string, body?: unknown, status = 200) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://orbit.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const json: unknown = await response.json()
      expect(response.status).toBe(status)
      return json
    })
})

it.live("preserves imported parentID through HTTP import, read, and parent filter", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const parent = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", { title: "Parent" }))
    const id = Session.ID.create()
    const imported = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/experimental/session/import", {
        info: { ...parent.data, id, parentID: parent.data.id, title: "Imported child" },
        messages: [],
      }),
    )
    const read = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${id}`))
    const children = Schema.decodeUnknownSync(SessionsResponse)(
      yield* request(`/api/session?parentID=${parent.data.id}`),
    )
    expect({
      imported: imported.data.parentID,
      read: read.data.parentID,
      children: children.data.map((child) => child.id),
    }).toEqual({ imported: parent.data.id, read: parent.data.id, children: [id] })
  }).pipe(Effect.scoped),
)
;["missing", "self"].forEach((parent) => {
  it.live(`rejects a ${parent} parent without creating the imported session`, () =>
    Effect.gen(function* () {
      const request = yield* setup
      const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
      const id = Session.ID.create()
      const parentID = parent === "self" ? id : Session.ID.create()
      const error = yield* request(
        "/api/experimental/session/import",
        { info: { ...template.data, id, parentID }, messages: [] },
        404,
      )
      expect(error).toMatchObject({ _tag: "SessionNotFoundError", sessionID: parentID })
      expect(yield* request(`/api/session/${id}`, undefined, 404)).toMatchObject({
        _tag: "SessionNotFoundError",
        sessionID: id,
      })
    }).pipe(Effect.scoped),
  )
})

// A checkpoint's `retain` comes from the document (class 5): the route decodes it as a message ID, so another spelling
// is refused before anything is written (class 7), and a valid one is stored with the checkpoint.
it.live("refuses an imported checkpoint whose retain is not a message ID and writes nothing", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
    const document = (id: Session.ID, retain: string) => ({
      info: { ...template.data, id },
      messages: [
        { id: "msg_retain_first", type: "user", text: "First", time: { created: 1 } },
        { id: "msg_retain_second", type: "user", text: "Second", time: { created: 2 } },
        {
          id: "msg_retain_checkpoint",
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "Summary",
          recent: "",
          retain,
          time: { created: 3 },
        },
      ],
    })
    const forged = Session.ID.create()
    const refused = yield* request("/api/experimental/session/import", document(forged, "../x"), 400)
    expect(refused).toBeDefined()
    // Nothing was written: neither the session nor its messages exist.
    yield* request(`/api/session/${forged}`, undefined, 404)

    // Control: the same document with a message ID imports, and the checkpoint keeps its reference.
    const valid = Session.ID.create()
    yield* request("/api/experimental/session/import", document(valid, "msg_retain_second"))
    const messages = yield* request(`/api/session/${valid}/message`)
    expect(JSON.stringify(messages)).toContain('"retain":"msg_retain_second"')
  }).pipe(Effect.scoped),
)
