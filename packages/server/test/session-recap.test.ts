// clients-ux-27: `POST /api/session/:sessionID/recap` is the transport the terminal UI's blur timer calls. The server
// owns the recap, so the one-recap-per-user-turn rule holds whichever client asks, and a request the client drops
// (the person came back) records nothing.
import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

type Server = { readonly base: string; readonly headers: Record<string, string> }

type Body = {
  readonly recorded?: boolean
  readonly data?: unknown
  readonly _tag?: string
}

function request(
  server: Server,
  method: string,
  route: string,
  input: { directory?: string; body?: unknown; signal?: AbortSignal } = {},
) {
  const url = new URL(route, server.base)
  if (input.directory) url.searchParams.set("location[directory]", input.directory)
  return fetch(url, {
    method,
    headers: { ...server.headers, "content-type": "application/json" },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: input.signal,
  }).then(async (response) => ({
    status: response.status,
    body: (await response.text().then((text) => (text ? JSON.parse(text) : undefined))) as Body | undefined,
  }))
}

// An OpenAI-compatible model on a port. A request with tools is the session's own step; one without is a side call
// (title or recap). While `hold` is set, a recap waits until it is released.
const recordingModel = Effect.acquireRelease(
  Effect.sync(() => {
    const bodies: string[] = []
    const state: { hold?: PromiseWithResolvers<void>; started?: PromiseWithResolvers<void> } = {}
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: unknown; messages?: Array<{ role: string }> }
        bodies.push(JSON.stringify(body))
        // A title request has a system prompt; a recap has none.
        const recap = !body.tools && !body.messages?.some((message) => message.role === "system")
        if (recap && state.hold) {
          state.started?.resolve()
          await state.hold.promise
        }
        const events = [
          {
            choices: [
              { index: 0, delta: { role: "assistant", content: body.tools ? "done" : "Fixing the build. Next: tests." } },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
        return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    return { bodies, server, state }
  }),
  (llm) => Effect.promise(() => llm.server.stop(true)),
)

// The server trusts every folder, unless `granted` is set: then no folder is trusted until the repo is granted, so a
// test can revoke it again.
const setup = (options: { granted?: boolean } = {}) => Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-recap-route-")))
  const root = yield* Effect.promise(() => fs.realpath(tmp.path))
  const folders = { config: path.join(root, "config"), repo: path.join(root, "repo") }
  const llm = yield* recordingModel
  yield* Effect.promise(async () => {
    await fs.mkdir(folders.repo, { recursive: true })
    await Bun.write(
      path.join(folders.config, "orbit.json"),
      JSON.stringify({
        model: "test/test-model",
        // The test provider has no small model of its own; the person's side-work model stands in for it.
        agents: { side: { model: "test/test-model" } },
        providers: {
          test: {
            name: "Test",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { apiKey: "test-key", baseURL: `http://127.0.0.1:${llm.server.port}/v1` },
            models: {
              "test-model": {
                name: "Test Model",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: { input: 0, output: 0 },
                limit: { context: 100_000, output: 10_000 },
              },
            },
          },
        },
      }),
    )
  })
  const server = yield* startServer(folders.config, options.granted ? { trust: { implicit: false } } : {})
  if (options.granted) yield* Effect.promise(() => trust(server, folders.repo, true))
  const created = yield* Effect.promise(() =>
    request(server, "POST", "/api/session", { directory: folders.repo, body: { location: { directory: folders.repo } } }),
  )
  const id = (created.body?.data as { id: string } | undefined)?.id ?? ""
  yield* Effect.promise(async () => {
    expect((await request(server, "POST", `/api/session/${id}/prompt`, { body: { text: "Fix the build" } })).status).toBe(
      200,
    )
    expect((await request(server, "POST", `/api/experimental/session/${id}/wait`)).status).toBe(204)
  })
  return { server, llm, id, folders }
})

const recaps = (server: Server, id: string) =>
  request(server, "GET", `/api/session/${id}/message`).then((response) =>
    ((response.body?.data ?? []) as Array<{ type: string; text?: string }>).filter((message) => message.type === "recap"),
  )

function trust(server: Server, directory: string, trusted: boolean) {
  return request(server, "POST", "/api/location/trust", {
    directory,
    body: trusted ? { trust: true, persist: false } : { trust: false },
  })
}

// Classes 1 and 12: the recap reads the session's history into a model call, so a folder revoked after the prompt gets
// a refusal before that history is read, not a refusal after the call. The same request recaps once trust is back.
it.live(
  "a session whose folder was revoked after its prompt is refused before the model is asked, and recapped once trusted",
  () =>
    Effect.gen(function* () {
      const { server, llm, id, folders } = yield* setup({ granted: true })
      yield* Effect.promise(async () => {
        const before = llm.bodies.length
        expect((await trust(server, folders.repo, false)).status).toBe(200)
        expect(await request(server, "POST", `/api/session/${id}/recap`, { body: {} })).toEqual({
          status: 403,
          body: expect.objectContaining({ _tag: "UntrustedFolderError", directory: folders.repo }),
        })
        expect(llm.bodies.length).toBe(before)
        expect(await recaps(server, id)).toEqual([])

        expect((await trust(server, folders.repo, true)).status).toBe(200)
        expect(await request(server, "POST", `/api/session/${id}/recap`, { body: {} })).toEqual({
          status: 200,
          body: { recorded: true },
        })
        expect(llm.bodies.length).toBe(before + 1)
      })
    }),
  60_000,
)

it.live(
  "the recap route records one recap per user turn and sends the model no tools and no system prompt",
  () =>
    Effect.gen(function* () {
      const { server, llm, id } = yield* setup()
      yield* Effect.promise(async () => {
        const before = llm.bodies.length
        const first = await request(server, "POST", `/api/session/${id}/recap`, { body: {} })
        expect(first).toEqual({ status: 200, body: { recorded: true } })
        expect(llm.bodies.length).toBe(before + 1)
        const sent = JSON.parse(llm.bodies.at(-1) ?? "{}") as {
          tools?: unknown
          messages: Array<{ role: string; content: unknown }>
        }
        expect(sent.tools).toBeUndefined()
        expect(sent.messages.filter((message) => message.role === "system")).toEqual([])
        expect(sent.messages.at(-1)?.role).toBe("user")
        expect(JSON.stringify(sent.messages)).toContain("Fix the build")
        expect(await recaps(server, id)).toEqual([
          expect.objectContaining({ type: "recap", text: "Fixing the build. Next: tests." }),
        ])

        // Asked again, by this client or another, before the person says anything new: nothing is sent.
        expect(await request(server, "POST", `/api/session/${id}/recap`, { body: {} })).toEqual({
          status: 200,
          body: { recorded: false },
        })
        expect(llm.bodies.length).toBe(before + 1)
        expect(await recaps(server, id)).toHaveLength(1)
      })
    }),
  60_000,
)

it.live("a session that does not exist answers 404 and asks no model", () =>
  Effect.gen(function* () {
    const { server, llm } = yield* setup()
    yield* Effect.promise(async () => {
      const before = llm.bodies.length
      expect(await request(server, "POST", "/api/session/ses_recap_missing/recap", { body: {} })).toEqual({
        status: 404,
        body: expect.objectContaining({ _tag: "SessionNotFoundError" }),
      })
      expect(llm.bodies.length).toBe(before)
    })
  }),
  60_000,
)

it.live(
  "a recap request the client drops records nothing, as the reference drops a recap when the person comes back",
  () =>
    Effect.gen(function* () {
      const { server, llm, id } = yield* setup()
      yield* Effect.promise(async () => {
        llm.state.hold = Promise.withResolvers<void>()
        llm.state.started = Promise.withResolvers<void>()
        const controller = new AbortController()
        const pending = request(server, "POST", `/api/session/${id}/recap`, {
          body: {},
          signal: controller.signal,
        }).catch((error: unknown) => error)
        expect(
          await Promise.race([llm.state.started.promise.then(() => "asked"), Bun.sleep(10_000).then(() => "not asked")]),
        ).toBe("asked")
        controller.abort()
        await pending
        // Let the model answer after the client left; the server must not record it.
        llm.state.hold.resolve()
        llm.state.hold = undefined
        await Bun.sleep(500)
        expect(await recaps(server, id)).toEqual([])

        // The dropped request does not block the next one.
        expect(await request(server, "POST", `/api/session/${id}/recap`, { body: {} })).toEqual({
          status: 200,
          body: { recorded: true },
        })
      })
    }),
  60_000,
)
