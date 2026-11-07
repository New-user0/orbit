import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

// trust-first: no work starts in a folder that is not trusted, and that covers the work no request route asks for. A
// drain checks the session's folder before the runner starts, so work admitted before a revoke and woken after it asks
// the model nothing, and a session skipped at startup keeps its claim, gets no restart notice, and resumes once the
// folder is trusted again. Every server here trusts a folder only when a request grants it.

type Server = (request: Request) => Promise<Response>

const call = (server: Server, method: string, route: string, input: { directory?: string; body?: unknown } = {}) => {
  const url = new URL(route, "http://orbit.local")
  if (input.directory !== undefined) url.searchParams.set("location[directory]", input.directory)
  return server(
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    }),
  ).then(async (response) => ({
    status: response.status,
    body: (await response.json().catch(() => undefined)) as
      | { readonly data?: { readonly id: string; readonly role?: string; readonly text?: string }[] | { readonly id: string } }
      | undefined,
  }))
}

// A model server that records each request, and answers it, or never does (so a server can stop mid-step).
const model = (answer: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const requests: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { tools?: unknown }
          if (body.tools) requests.push(new URL(request.url).pathname)
          if (!answer) return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
          const events = [
            { choices: [{ index: 0, delta: { role: "assistant", content: body.tools ? "done" : "Title" } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]
          return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      return { requests, server }
    }),
    (llm) => Effect.promise(() => llm.server.stop(true)),
  )

const layout = (port: number | undefined) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-trust-first-drain-")))
    const root = yield* Effect.promise(() => fs.realpath(tmp.path))
    const config = path.join(root, "config")
    const repo = path.join(root, "repo")
    yield* Effect.promise(async () => {
      await fs.mkdir(repo, { recursive: true })
      await Bun.write(
        path.join(config, "orbit.json"),
        JSON.stringify({
          model: "test/test-model",
          providers: {
            test: {
              name: "Test",
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { apiKey: "test-key", baseURL: `http://127.0.0.1:${port}/v1` },
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
    return { config, repo, database: path.join(root, "orbit.db") }
  })

const start = (folders: { config: string; database: string }) =>
  ServerFetch.make({
    app: { version: "test-version" },
    database: { path: folders.database },
    config: { directory: folders.config },
    managed: { directory: path.join(folders.config, "managed-missing") },
    fs: { filewatcher: false },
    models: { fetch: false },
    trust: { implicit: false },
  })

const until = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms
  while (!check() && Date.now() < deadline) await Bun.sleep(50)
}

for (const revoked of [true, false])
  it.live(
    revoked
      ? "work admitted before a revoke and woken after it asks the model nothing"
      : "work admitted and woken in a folder still trusted asks the model: the control for the row above",
    () =>
      Effect.gen(function* () {
        const llm = yield* model(true)
        const folders = yield* layout(llm.server.port)
        const server = yield* start(folders)
        yield* Effect.promise(async () => {
          expect(
            (await call(server, "POST", "/api/location/trust", { directory: folders.repo, body: { trust: true, persist: false } }))
              .status,
          ).toBe(200)
          const created = await call(server, "POST", "/api/session", {
            directory: folders.repo,
            body: { location: { directory: folders.repo } },
          })
          const id = (created.body?.data as { id: string }).id
          // Admitted without starting work: a steer that waits in the inbox.
          expect((await call(server, "POST", `/api/session/${id}/prompt`, { body: { text: "hi", resume: false } })).status).toBe(200)
          if (revoked)
            expect(
              (await call(server, "POST", "/api/location/trust", { directory: folders.repo, body: { trust: false } })).status,
            ).toBe(200)

          // Interrupting with resume wakes the session for the waiting steer, which no route that starts work refuses.
          expect((await call(server, "POST", `/api/session/${id}/interrupt?resume=true`)).status).toBe(200)
          await until(() => llm.requests.length > 0, revoked ? 3_000 : 20_000)
          if (revoked) expect(llm.requests).toEqual([])
          else expect(llm.requests.length).toBeGreaterThan(0)
        })
      }),
    60_000,
  )

it.live(
  "a session skipped at startup in an untrusted folder keeps its claim and gets no restart notice, and resumes once the folder is trusted",
  () =>
    Effect.gen(function* () {
      const llm = yield* model(false)
      const folders = yield* layout(llm.server.port)
      const grant = (server: Server, persist: boolean) =>
        call(server, "POST", "/api/location/trust", { directory: folders.repo, body: { trust: true, persist } })
      const restartNotices = async (server: Server, id: string) => {
        const messages = await call(server, "GET", `/api/session/${id}/message`)
        return JSON.stringify(messages.body).split("The server restarted").length - 1
      }

      // The first server: a grant for this process only, and a prompt that is mid-step when the server stops.
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* start(folders)
          return yield* Effect.promise(async () => {
            expect((await grant(server, false)).status).toBe(200)
            const created = await call(server, "POST", "/api/session", {
              directory: folders.repo,
              body: { location: { directory: folders.repo } },
            })
            const id = (created.body?.data as { id: string }).id
            expect((await call(server, "POST", `/api/session/${id}/prompt`, { body: { text: "hi" } })).status).toBe(200)
            await until(() => llm.requests.length > 0, 20_000)
            expect(llm.requests.length).toBeGreaterThan(0)
            return id
          })
        }),
      )
      const before = llm.requests.length

      // The second server does not trust the folder: no resume, no restart notice, and the claim stays.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* start(folders)
          yield* Effect.promise(async () => {
            await Bun.sleep(2_000)
            expect(llm.requests.length).toBe(before)
            expect(await restartNotices(server, id)).toBe(0)
            // A stored grant, so that the next server trusts the folder from the start.
            expect((await grant(server, true)).status).toBe(200)
          })
        }),
      )

      // The third server trusts it, and resumes the session the second one left claimed.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* start(folders)
          yield* Effect.promise(async () => {
            await until(() => llm.requests.length > before, 20_000)
            expect(llm.requests.length).toBeGreaterThan(before)
            expect(await restartNotices(server, id)).toBe(1)
          })
        }),
      )
    }),
  90_000,
)
