// context-memory-2 part 2 (class 12): `POST /api/session/:sessionID/compact` is the door the generated client, the
// embedded SDK, the terminal UI, Mini and ACP all reach. It trims the instructions and stores none for blank text.
import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

type Body = { readonly data?: { readonly id?: string; readonly payload?: unknown } & ReadonlyArray<unknown> }

it.live("the compact route forwards trimmed instructions and stores none for blank text", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
      trust: { implicit: true },
    })
    const request = (path: string, method: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://orbit.local${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        expect(response.status).toBe(200)
        return (await response.json()) as Body
      })
    const create = request("/api/session", "POST", {}).pipe(Effect.map((created) => created.data?.id ?? ""))

    // Outer whitespace goes, the line break inside stays; the stored item and the inbox listing agree.
    const first = yield* create
    const text = yield* request(`/api/session/${first}/compact`, "POST", {
      instructions: "  focus on tests\nkeep the db notes ",
    })
    expect(text.data?.payload).toEqual({ instructions: "focus on tests\nkeep the db notes" })
    expect((yield* request(`/api/session/${first}/inbox`, "GET")).data).toEqual([
      expect.objectContaining({ id: text.data?.id, type: "compaction", payload: text.data?.payload }),
    ])

    // Blank text and no text store the same empty payload.
    const second = yield* create
    expect((yield* request(`/api/session/${second}/compact`, "POST", { instructions: " " })).data?.payload).toEqual({})
    const third = yield* create
    expect((yield* request(`/api/session/${third}/compact`, "POST", {})).data?.payload).toEqual({})
  }).pipe(Effect.scoped),
  // Each admission wakes a drain that has no model to use, which takes a moment to fail.
  30_000,
)
