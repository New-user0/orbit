import { expect, setDefaultTimeout } from "bun:test"
import path from "path"
import { Bus } from "@orbit/core/bus"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionMessage } from "@orbit/core/session/message"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { Effect, Layer } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

setDefaultTimeout(30_000)

it.live("takes an editor field on a prompt, rejects a malformed one, and keeps it on the user message", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-session-editor-")))
    const id = SessionMessage.ID.create()
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        return SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          isActive: () => Effect.succeed(false),
          resume: () => Effect.void,
          wake: (sessionID) => bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id }).pipe(Effect.asVoid),
          interrupt: () => Effect.succeed(false),
          awaitIdle: () => Effect.void,
        })
      }),
    )
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test-version" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      {
        overrides: [
          SessionExecution.node.replace(
            makeGlobalNode({ service: SessionExecution.Service, layer: execution, deps: [Bus.node] }),
          ),
        ],
      },
    )
    const request = (url: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://orbit.local${url}`, {
            method: body === undefined ? "GET" : "POST",
            headers: body === undefined ? undefined : { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
        return { status: response.status, body: (await response.json()) as Record<string, unknown> }
      })
    const created = yield* request("/api/session", { location: { directory: tmp.path } })
    const sessionID = Session.ID.make((created.body.data as { id: string }).id)
    const prompt = (body: Record<string, unknown>) => request(`/api/session/${sessionID}/prompt`, body)
    const file = path.join(tmp.path, "a.ts")

    // A shape error fails decoding and admits nothing.
    for (const editor of [
      { path: file, selection: { start: 0, end: 1, text: "x" } },
      { path: file, selection: { start: 1.5, end: 2, text: "x" } },
      { path: "" },
      { path: file, selection: { start: 1, end: 1 } },
    ])
      expect(yield* prompt({ id, text: "Refused", editor })).toMatchObject({
        status: 400,
        body: { _tag: "InvalidRequestError" },
      })
    expect((yield* request(`/api/session/${sessionID}/message?order=asc`)).body.data).toEqual([])

    const editor = { path: file, selection: { start: 2, end: 3, text: "const a = 1\nconst b = 2" } }
    const accepted = yield* prompt({ id, text: "Look at this", editor })
    expect(accepted.status).toBe(200)
    expect(accepted.body.data).toMatchObject({ id, payload: { text: "Look at this", editor } })
    expect((yield* request(`/api/session/${sessionID}/message?order=asc`)).body.data).toMatchObject([
      { id, type: "user", editor },
    ])
  }),
)
