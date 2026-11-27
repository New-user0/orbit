import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Integration } from "@orbit/core/integration"
import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { OllamaPlugin, make } from "@orbit/core/plugin/provider/ollama"
import { ProviderPlugins } from "@orbit/core/plugin/provider"
import { Provider } from "@orbit/core/provider"
import { Document, Event, Info } from "@orbit/schema/config"
import { describe, expect } from "bun:test"
import { Clock, Duration, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { waitingClock } from "../lib/clock"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))
const decode = Schema.decodeUnknownSync(Info)
const decodeShowRequest = Schema.decodeUnknownSync(Schema.Struct({ model: Schema.String }))

const addPlugin = Effect.fn(function* (origin: string, interval: Duration.Input = "1 hour", served?: number) {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* make(origin, interval, served).effect(host)
})

function eventually<A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  remaining = 3000,
): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

// Like eventually, but bounded by the clock: Windows timers make a count of 1 ms sleeps a poor measure of time.
function within<A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, ms: number): Effect.Effect<A, Error> {
  const deadline = Date.now() + ms
  const attempt: Effect.Effect<A, Error> = Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (Date.now() > deadline) return yield* Effect.fail(new Error(`Timed out after ${ms} ms waiting for value`))
    yield* Effect.promise(() => Bun.sleep(20))
    return yield* attempt
  })
  return attempt
}

describe("OllamaPlugin", () => {
  it.live("discovers local completion models and native metadata", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: Array<{ method: string; path: string; model?: string }> = []
        return {
          requests,
          server: Bun.serve({
            port: 0,
            fetch: async (request) => {
              const path = new URL(request.url).pathname
              if (request.method === "GET") {
                requests.push({ method: request.method, path })
                return Response.json({
                  models: [
                    summary("gemma3:4b", "gemma-digest", "gemma3"),
                    summary("unknown-context", "unknown-digest"),
                    summary("nomic-embed", "embed-digest"),
                    summary("removed-model", "removed-digest"),
                  ],
                })
              }
              const body = decodeShowRequest(await request.json())
              requests.push({ method: request.method, path, model: body.model })
              if (body.model === "removed-model") return new Response("Not found", { status: 404 })
              return Response.json(
                body.model === "gemma3:4b"
                  ? {
                      capabilities: ["completion", "tools", "vision"],
                      model_info: { "gemma3.context_length": 131_072 },
                    }
                  : body.model === "unknown-context"
                    ? show({ family: "unknown", capabilities: ["completion"], context: 0 })
                    : show({ family: "nomic-bert", capabilities: ["embedding"], context: 8192 }),
              )
            },
          }),
        }
      }),
      ({ requests, server }) =>
        Effect.gen(function* () {
          const providers = yield* Provider.Service
          const modelState = yield* Model.Service
          const providerID = Provider.ID.make("ollama")
          expect(OllamaPlugin.id).toBe("orbit.provider.ollama")
          expect(ProviderPlugins.map((item) => item.id)).toContain("orbit.provider.ollama")
          yield* addPlugin(server.url.origin)
          const model = yield* eventually(
            modelState.get(providerID, Model.ID.make("gemma3:4b")),
            (item) => item !== undefined,
          )

          expect(yield* providers.get(providerID)).toEqual({
            id: providerID,
            name: "Ollama",
            activation: "enabled",
            package: "@orbit/ai/providers/openai-compatible",
            settings: { baseURL: `${server.url.origin}/v1`, provider: "ollama", apiKey: "" },
          })
          expect(model).toMatchObject({
            modelID: "gemma3:4b",
            name: "gemma3:4b",
            family: "gemma3",
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            limit: { context: 131_072, output: 32_000 },
          })
          expect(model?.compatibility?.toolCalling).toBeUndefined()
          expect(yield* modelState.get(providerID, Model.ID.make("unknown-context"))).toMatchObject({
            capabilities: { tools: true },
            compatibility: { toolCalling: "text" },
            limit: { context: 200_000, output: 32_000 },
          })
          expect(yield* modelState.get(providerID, Model.ID.make("nomic-embed"))).toBeUndefined()
          expect(requests).toContainEqual({ method: "GET", path: "/api/tags" })
          expect(requests).toContainEqual({ method: "POST", path: "/api/show", model: "gemma3:4b" })
          expect(requests).toContainEqual({ method: "POST", path: "/api/show", model: "nomic-embed" })
          expect(requests).toContainEqual({ method: "POST", path: "/api/show", model: "removed-model" })
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  // Table: how long /api/show takes to answer. A default model is resolved right after the location starts, so the
  // catalog has to be filled by the time the plugin has started, however long discovery takes within its limits.
  for (const delay of [0, 50, 250, 700]) {
    it.live(`has the catalog filled once the plugin has started when /api/show takes ${delay} ms`, () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: async (request) => {
              if (request.method === "GET") return Response.json({ models: [summary("slow:1b", "slow-digest")] })
              await Bun.sleep(delay)
              return Response.json(show({ capabilities: ["completion", "tools"], context: 8192 }))
            },
          }),
        ),
        (server) =>
          Effect.gen(function* () {
            const modelState = yield* Model.Service
            yield* addPlugin(server.url.origin)
            expect(yield* modelState.get(Provider.ID.make("ollama"), Model.ID.make("slow:1b"))).toBeDefined()
          }),
        (server) => Effect.promise(() => server.stop(true)),
      ),
    )
  }

  it.live("budgets context to the window Ollama serves", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) =>
            request.method === "GET"
              ? Response.json({
                  models: [summary("large:27b", "large-digest", "qwen3"), summary("small:1b", "small-digest", "qwen3")],
                })
              : request.json().then((body) =>
                  Response.json(
                    show({
                      family: "qwen3",
                      capabilities: ["completion", "tools"],
                      context: decodeShowRequest(body).model === "large:27b" ? 262_144 : 8_192,
                    }),
                  ),
                ),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          const modelState = yield* Model.Service
          const providerID = Provider.ID.make("ollama")
          yield* addPlugin(server.url.origin, "1 hour", 32_768)
          const large = yield* eventually(
            modelState.get(providerID, Model.ID.make("large:27b")),
            (item) => item !== undefined,
          )

          expect(large?.limit.context).toBe(32_768)
          expect((yield* modelState.get(providerID, Model.ID.make("small:1b")))?.limit.context).toBe(8_192)
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live("refreshes changed digests and retains inventory through transient failures", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state = { digest: "digest-1", context: 32_768, fail: false }
        const requests = { tags: 0, show: 0 }
        return {
          state,
          requests,
          server: Bun.serve({
            port: 0,
            fetch: async (request) => {
              if (request.method === "GET") {
                requests.tags++
                if (state.fail) return new Response("unavailable", { status: 503 })
                return Response.json({ models: [summary("qwen3:8b", state.digest, "qwen3")] })
              }
              decodeShowRequest(await request.json())
              requests.show++
              return Response.json(
                show({ family: "qwen3", capabilities: ["completion", "tools"], context: state.context }),
              )
            },
          }),
        }
      }),
      ({ state, requests, server }) =>
        Effect.gen(function* () {
          const modelState = yield* Model.Service
          const providerID = Provider.ID.make("ollama")
          const modelID = Model.ID.make("qwen3:8b")
          yield* addPlugin(server.url.origin, "5 millis")
          yield* eventually(modelState.get(providerID, modelID), (model) => model?.limit.context === 32_768)
          yield* eventually(
            Effect.sync(() => requests.tags),
            (count) => count >= 2,
          )
          expect(requests.show).toBe(1)

          state.digest = "digest-2"
          state.context = 65_536
          yield* eventually(modelState.get(providerID, modelID), (model) => model?.limit.context === 65_536)
          expect(requests.show).toBe(2)

          state.fail = true
          yield* Effect.promise(() => Bun.sleep(30))
          expect((yield* modelState.get(providerID, modelID))?.limit.context).toBe(65_536)
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  // A server under load can answer /api/tags after its 1 second limit. Discovery then has no models, and until it is
  // tried again every node and prompt that names an Ollama model fails with "has no models here" (FU-M3-385: the cli
  // trust-doors control and the YAML `permissions:auto` row of flow.test.ts on a loaded runner).
  const slowFirstTags = (delay: number) => {
    const requests = { tags: 0 }
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          requests.tags++
          if (requests.tags === 1) await Bun.sleep(delay)
          return Response.json({ models: [summary("late:1b", "late-digest")] })
        }
        decodeShowRequest(await request.json())
        return Response.json(show({ capabilities: ["completion", "tools"], context: 8192 }))
      },
    })
    return { requests, server }
  }

  it.live(
    "a first discovery that runs out of time is tried again soon, not after the interval",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => slowFirstTags(1_500)),
        ({ requests, server }) =>
          Effect.gen(function* () {
            const modelState = yield* Model.Service
            yield* addPlugin(server.url.origin, "1 hour")
            const model = yield* within(
              modelState.get(Provider.ID.make("ollama"), Model.ID.make("late:1b")),
              (item) => item !== undefined,
              8_000,
            )
            expect(model).toBeDefined()
            expect(requests.tags).toBeGreaterThanOrEqual(2)
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
    15_000,
  )

  it.live(
    "a discovery that ran out of time is not kept as a fresh answer for the next plugin of the same server",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => slowFirstTags(1_500)),
        ({ requests, server }) =>
          Effect.gen(function* () {
            const modelState = yield* Model.Service
            yield* addPlugin(server.url.origin, "30 seconds")
            // A second Location of the same server starts its plugin; its first discovery asks the server again.
            yield* addPlugin(server.url.origin, "30 seconds")
            expect(requests.tags).toBeGreaterThanOrEqual(2)
            expect(yield* modelState.get(Provider.ID.make("ollama"), Model.ID.make("late:1b"))).toBeDefined()
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
    15_000,
  )

  // Control: a discovery that answered in time is not asked again before its interval, so a retry after a failure
  // never becomes polling.
  it.live(
    "a discovery that answered in time is not asked again before its interval",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => slowFirstTags(0)),
        ({ requests, server }) =>
          Effect.gen(function* () {
            const modelState = yield* Model.Service
            yield* addPlugin(server.url.origin, "1 hour")
            expect(yield* modelState.get(Provider.ID.make("ollama"), Model.ID.make("late:1b"))).toBeDefined()
            yield* Effect.promise(() => Bun.sleep(2_500))
            expect(requests.tags).toBe(1)
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
    15_000,
  )

  // A server whose /api/tags answers come from `tags`, and plugins of it that run on a clock that moves only while the
  // plugins and their requests wait (test/lib/clock.ts `waitingClock`). A row reads the clock's time at each request,
  // so a slow or stalled runner can neither stretch a pause nor make a request count come out short.
  const onWaitingClock = Effect.fn(function* (tags: (request: number) => Response) {
    const time = yield* waitingClock
    // A server that records the clock's time of each /api/tags request it gets.
    const serve = Effect.fn(function* (answer: (request: number) => Response) {
      const asked: number[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: async (request) => {
              if (request.method === "GET") {
                asked.push(time.now())
                return answer(asked.length)
              }
              decodeShowRequest(await request.json())
              return Response.json(show({ capabilities: ["completion", "tools"], context: 8192 }))
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      return { asked, origin: server.url.origin }
    })
    const served = yield* serve(tags)
    const asked = served.asked
    const http = yield* HttpClient.HttpClient
    return {
      asked,
      // Another server on the same clock, for a row that points the plugin elsewhere.
      serve,
      plugin: (interval: Duration.Input) =>
        addPlugin(served.origin, interval).pipe(
          // A request holds the clock while it runs, so its own 1 second limit never ends it early.
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.transform(http, (response) => time.work(response)),
          ),
          Effect.provideService(Clock.Clock, time.clock),
        ),
      // The pauses between the first `requests` requests, once that many have come.
      pauses: (requests: number) =>
        within(
          Effect.sync(() => asked.length),
          (count) => count >= requests,
          10_000,
        ).pipe(Effect.map(() => asked.slice(1, requests).map((at, index) => at - asked[index]!))),
    }
  })
  const pauses = Effect.fn(function* (interval: Duration.Input, tags: (request: number) => Response, requests: number) {
    const served = yield* onWaitingClock(tags)
    yield* served.plugin(interval)
    return yield* served.pauses(requests)
  })
  const unavailable = () => new Response("unavailable", { status: 503 })

  // The retry backs off: a server that keeps failing is asked after 1 s, then 2 s, then 4 s, not every second. The
  // pauses after the second and third requests need a retry that failed to count as unanswered too, not only the first
  // discovery.
  it.live("a server that keeps failing is asked again after pauses that double", () =>
    Effect.gen(function* () {
      expect(yield* pauses("1 hour", unavailable, 4)).toEqual([1_000, 2_000, 4_000])
    }),
  )

  // The doubling stops at the interval: with a 1.5 s interval a failing server is asked after 1 s, then every 1.5 s; a
  // pause that kept doubling past it would wait 2 s and then 4 s.
  it.live("a server that keeps failing is never asked after a pause longer than the interval", () =>
    Effect.gen(function* () {
      expect(yield* pauses("1500 millis", unavailable, 5)).toEqual([1_000, 1_500, 1_500, 1_500])
    }),
  )

  // A plugin that holds an inventory keeps its interval through a failure: the 1 s retry is only for a plugin that has
  // nothing yet. Here the interval is 4 s and the server fails from its second request on; the backoff would ask 2 s
  // after that failure, the interval asks 4 s after it.
  it.live("a server that fails after it answered with models is asked again only after the interval", () =>
    Effect.gen(function* () {
      const tags = (request: number) =>
        request > 1 ? unavailable() : Response.json({ models: [summary("kept:1b", "kept-digest")] })
      expect(yield* pauses("4 seconds", tags, 3)).toEqual([4_000, 4_000])
      const modelState = yield* Model.Service
      expect(yield* modelState.get(Provider.ID.make("ollama"), Model.ID.make("kept:1b"))).toBeDefined()
    }),
  )

  // An answer with no models is an answer too, so the plugin waits its interval after it and not the 1 s backoff of a
  // plugin whose read failed. A backoff would find the cached answer fresh until the interval ends and ask only at the
  // first pause past it: 7 s after the first request with a 4 s interval, where the interval asks after 4 s.
  it.live("a server that answered with no models is asked again only after the interval", () =>
    Effect.gen(function* () {
      expect(yield* pauses("4 seconds", () => Response.json({ models: [] }), 3)).toEqual([4_000, 4_000])
    }),
  )

  // An answer that came in time is kept for the interval: the next plugin of the same server takes it without asking.
  // Both plugins run on one clock, so the row fails if the cache and the refresh loop read different clocks.
  it.live("a discovery that answered is kept as a fresh answer for the next plugin of the same server", () =>
    Effect.gen(function* () {
      const served = yield* onWaitingClock(() => Response.json({ models: [summary("kept:1b", "kept-digest")] }))
      yield* served.plugin("1 hour")
      yield* served.plugin("1 hour")
      expect(served.asked).toHaveLength(1)
    }),
  )

  // A config reload that points the plugin at another server is a first read of that server, so its retry pauses start
  // at 1 s again. Before the reload the plugin answered from the first server through six intervals, after which a pause
  // that went on doubling would be the whole 30 s interval; the second server fails twice and then answers.
  it.live("a reload to a server whose first read fails is asked again after 1 s, then 2 s", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const config = yield* Config.Test
      const modelState = yield* Model.Service
      const first = yield* onWaitingClock(() => Response.json({ models: [summary("first:1b", "first-digest")] }))
      const second = yield* first.serve((request) =>
        request > 2 ? Response.json({ models: [summary("second:1b", "second-digest")] }) : unavailable(),
      )
      yield* first.plugin("30 seconds")
      yield* first.pauses(7)
      const asked = second.asked
      yield* config.setEntries([configuration({ baseURL: `${second.origin}/v1` })])
      yield* bus.publish(Event.Updated, {})
      yield* within(
        Effect.sync(() => asked.length),
        (count) => count >= 3,
        10_000,
      )
      expect(asked.slice(1, 3).map((at, index) => at - asked[index]!)).toEqual([1_000, 2_000])
      yield* within(
        modelState.get(Provider.ID.make("ollama"), Model.ID.make("second:1b")),
        (model) => model !== undefined,
        5_000,
      )
    }),
  )

  // Control: a server that answered with no models has answered; the plugin has nothing, but it does not ask again
  // before its interval either.
  it.live(
    "a server that answered with no models is not asked again before its interval",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const requests = { tags: 0 }
          const server = Bun.serve({
            port: 0,
            fetch: () => {
              requests.tags++
              return Response.json({ models: [] })
            },
          })
          return { requests, server }
        }),
        ({ requests, server }) =>
          Effect.gen(function* () {
            yield* addPlugin(server.url.origin, "1 hour")
            yield* Effect.promise(() => Bun.sleep(2_500))
            expect(requests.tags).toBe(1)
          }),
        ({ server }) => Effect.promise(() => server.stop(true)),
      ),
    15_000,
  )

  it.live("replaces and restores the same-ID Models.dev provider", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const models = [summary("discovered-model", "digest")]
        return {
          models,
          server: Bun.serve({
            port: 0,
            fetch: async (request) => {
              if (request.method === "GET") return Response.json({ models })
              decodeShowRequest(await request.json())
              return Response.json(show({ capabilities: ["completion"], context: 32_768 }))
            },
          }),
        }
      }),
      ({ models, server }) =>
        Effect.gen(function* () {
          const providers = yield* Provider.Service
          const modelState = yield* Model.Service
          const integrations = yield* Integration.Service
          const providerID = Provider.ID.make("ollama")
          yield* integrations.transform((editor) => {
            editor.update(Integration.ID.make("ollama"), (integration) => {
              integration.name = "Ollama"
            })
            editor.method.update({
              integrationID: Integration.ID.make("ollama"),
              method: { type: "env", names: ["OLLAMA_API_KEY"] },
            })
          })
          yield* providers.transform((editor) => {
            editor.update(providerID, (provider) => {
              provider.name = "Ollama"
              provider.package = "@orbit/ai/providers/openai-compatible"
              provider.integrationID = Integration.ID.make("ollama")
            })
            editor.models.update(providerID, Model.ID.make("static-model"), () => {})
          })

          yield* addPlugin(server.url.origin, "5 millis")
          yield* eventually(
            modelState.get(providerID, Model.ID.make("discovered-model")),
            (model) => model !== undefined,
          )
          expect(yield* integrations.get(Integration.ID.make("ollama"))).toBeUndefined()
          expect((yield* providers.get(providerID))?.activation).toBe("enabled")
          expect(yield* modelState.get(providerID, Model.ID.make("static-model"))).toBeUndefined()

          models.splice(0)
          yield* eventually(
            providers.snapshot(),
            (snapshot) => snapshot.records.get(providerID)?.models.has(Model.ID.make("static-model")) === true,
          )
          expect(yield* modelState.get(providerID, Model.ID.make("discovered-model"))).toBeUndefined()
          expect(yield* modelState.get(providerID, Model.ID.make("static-model"))).toBeUndefined()
          expect(yield* integrations.get(Integration.ID.make("ollama"))).toBeDefined()
          expect((yield* providers.get(providerID))?.activation).toBe("auto")
          expect((yield* providers.get(providerID))?.integrationID).toBe(Integration.ID.make("ollama"))
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.live(
    "reloads layered endpoint and bearer authentication settings",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const requests: Array<{ authorization: string | null; method: string; path: string }> = []
          return {
            requests,
            initial: Bun.serve({
              port: 0,
              fetch: async (request) => {
                if (request.method === "GET")
                  return Response.json({ models: [summary("initial-model", "initial-digest")] })
                decodeShowRequest(await request.json())
                return Response.json(show({ capabilities: ["completion"], context: 4096 }))
              },
            }),
            configured: Bun.serve({
              port: 0,
              fetch: async (request) => {
                requests.push({
                  authorization: request.headers.get("authorization"),
                  method: request.method,
                  path: new URL(request.url).pathname,
                })
                if (request.method === "GET")
                  return Response.json({ models: [summary("configured-model", "configured-digest")] })
                decodeShowRequest(await request.json())
                return Response.json(show({ capabilities: ["completion", "vision"], context: 65_536 }))
              },
            }),
          }
        }),
        ({ requests, initial, configured }) =>
          Effect.gen(function* () {
            const bus = yield* Bus.Service
            const providers = yield* Provider.Service
            const modelState = yield* Model.Service
            const config = yield* Config.Test
            const providerID = Provider.ID.make("ollama")
            yield* addPlugin(initial.url.origin)
            yield* eventually(
              modelState.get(providerID, Model.ID.make("initial-model")),
              (model) => model !== undefined,
            )

            const baseURL = `${configured.url.origin}/proxy/v1`
            yield* config.setEntries([configuration({ baseURL, apiKey: "old" }), configuration({ apiKey: "secret" })])
            yield* bus.publish(Event.Updated, {})
            yield* eventually(
              modelState.get(providerID, Model.ID.make("configured-model")),
              (model) => model !== undefined,
            )
            expect(requests).toContainEqual({ authorization: "Bearer secret", method: "GET", path: "/proxy/api/tags" })
            expect(requests).toContainEqual({ authorization: "Bearer secret", method: "POST", path: "/proxy/api/show" })
            expect(yield* modelState.get(providerID, Model.ID.make("initial-model"))).toBeUndefined()
            expect((yield* providers.get(providerID))?.settings).toEqual({
              baseURL,
              provider: "ollama",
              apiKey: "secret",
            })

            requests.splice(0)
            yield* config.setEntries([configuration({ baseURL, apiKey: "secret" }), configuration({ apiKey: null })])
            yield* bus.publish(Event.Updated, {})
            yield* eventually(providers.get(providerID), (provider) => provider?.settings?.apiKey === "")
            expect(requests).toContainEqual({ authorization: null, method: "GET", path: "/proxy/api/tags" })
            expect(requests).toContainEqual({ authorization: null, method: "POST", path: "/proxy/api/show" })
          }),
        ({ initial, configured }) => Effect.promise(() => Promise.all([initial.stop(true), configured.stop(true)])),
      ),
    10_000,
  )
})

function summary(model: string, digest: string, family = "llama") {
  return {
    name: model,
    model,
    modified_at: "2026-01-01T00:00:00Z",
    size: 1_000_000,
    digest,
    details: {
      format: "gguf",
      family,
      families: [family],
      parameter_size: "8B",
      quantization_level: "Q4_K_M",
    },
  }
}

function show(input: { family?: string; capabilities: string[]; context: number }) {
  const family = input.family ?? "llama"
  return {
    parameters: "temperature 0.7",
    details: {
      parent_model: "",
      format: "gguf",
      family,
      families: [family],
      parameter_size: "8B",
      quantization_level: "Q4_K_M",
    },
    capabilities: input.capabilities,
    model_info: {
      "general.architecture": family,
      [`${family}.context_length`]: input.context,
    },
  }
}

function configuration(settings: Record<string, string | null>) {
  return new Document({
    type: "document",
    info: decode({ providers: { ollama: { settings } } }),
  })
}
