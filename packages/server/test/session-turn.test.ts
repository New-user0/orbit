import { expect, setDefaultTimeout } from "bun:test"
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

it.live("takes turn options on a prompt and returns them, with the delivery, on the user message", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-session-turn-")))
    const ids = { first: SessionMessage.ID.create(), second: SessionMessage.ID.create() }
    // Deliver each admitted prompt, in order, the way the runner would, without a model.
    const execution = Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        const bus = yield* Bus.Service
        const pending = [ids.first, ids.second]
        return SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          isActive: () => Effect.succeed(false),
          resume: () => Effect.void,
          wake: (sessionID) =>
            Effect.suspend(() => {
              const inboxID = pending.shift()
              return inboxID ? bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID }) : Effect.void
            }).pipe(Effect.asVoid),
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
    const request = (path: string, body?: unknown) =>
      Effect.promise(async () => {
        const response = await handler(
          new Request(`http://orbit.local${path}`, {
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
    const turn = {
      maxSteps: 3,
      maxCost: 0.25,
      maxTokens: 9_000,
      fallbackModel: { id: "backup", providerID: "provider", variant: "fast" },
    }

    // Options that are not valid are refused at the boundary, and admit nothing.
    for (const invalid of [
      { maxSteps: 0 },
      { maxCost: -1 },
      { maxCost: 0 },
      { maxTokens: 1.5 },
      { fallbackModel: "provider/backup" },
    ])
      expect(yield* prompt({ id: ids.first, text: "Refused", turn: invalid })).toMatchObject({
        status: 400,
        body: { _tag: "InvalidRequestError" },
      })
    expect((yield* request(`/api/session/${sessionID}/message?order=asc`)).body.data).toEqual([])

    const limited = yield* prompt({ id: ids.first, text: "Limited work", turn })
    expect(limited.status).toBe(200)
    expect(limited.body.data).toMatchObject({
      id: ids.first,
      delivery: "steer",
      payload: { text: "Limited work", turn },
    })
    const plain = yield* prompt({ id: ids.second, text: "Plain work", delivery: "queue" })
    expect(plain.status).toBe(200)
    expect((plain.body.data as { payload: object }).payload).not.toHaveProperty("turn")

    const messages = (yield* request(`/api/session/${sessionID}/message?order=asc`)).body.data as Array<
      Record<string, unknown>
    >
    expect(messages).toMatchObject([
      { id: ids.first, type: "user", text: "Limited work", turn, delivery: "steer" },
      { id: ids.second, type: "user", text: "Plain work", delivery: "queue" },
    ])
    expect(messages[1]).not.toHaveProperty("turn")
  }),
)
