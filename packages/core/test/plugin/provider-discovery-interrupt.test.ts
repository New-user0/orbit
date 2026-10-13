// A plugin activation can be interrupted while discovery is still waiting on the server: `--trust` rebuilds the
// locations, which closes the first activation. The next activation must still fill the catalog instead of finding a
// fresh "checked" entry that holds no models.
import { Config } from "@orbit/core/config"
import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { make as makeLMStudio } from "@orbit/core/plugin/provider/lmstudio"
import { make as makeOllama } from "@orbit/core/plugin/provider/ollama"
import { make as makeVLLM } from "@orbit/core/plugin/provider/vllm"
import { Provider } from "@orbit/core/provider"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(Layer.merge(PluginTestLayer, Config.testLayer()))

const details = { format: "gguf", family: "llama", families: ["llama"], parameter_size: "8B", quantization_level: "Q4" }

const rows = [
  {
    name: "ollama",
    model: "slow:1b",
    make: makeOllama,
    respond: async (request: Request, delay: number) => {
      if (request.method === "GET")
        return Response.json({
          models: [
            { name: "slow:1b", model: "slow:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
          ],
        })
      await Bun.sleep(delay)
      return Response.json({ capabilities: ["completion", "tools"], model_info: { "llama.context_length": 8192 } })
    },
  },
  {
    name: "lmstudio",
    model: "slow",
    make: makeLMStudio,
    respond: async (_request: Request, delay: number) => {
      await Bun.sleep(delay)
      return Response.json({
        models: [{ type: "llm", key: "slow", display_name: "Slow", loaded_instances: [], max_context_length: 4096 }],
      })
    },
  },
  {
    name: "vllm",
    model: "slow",
    make: makeVLLM,
    respond: async (request: Request, delay: number) => {
      if (new URL(request.url).pathname === "/health") return new Response()
      await Bun.sleep(delay)
      return Response.json({ object: "list", data: [{ id: "slow", owned_by: "vllm", max_model_len: 4096 }] })
    },
  },
]

for (const row of rows)
  for (const delay of [50, 250])
    it.live(`${row.name}: an activation interrupted while the server takes ${delay} ms leaves the next one a filled catalog`, () =>
      Effect.acquireUseRelease(
        Effect.sync(() => Bun.serve({ port: 0, fetch: (request) => row.respond(request, delay) })),
        (server) =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            const host = yield* PluginHost.make(plugin)
            const modelState = yield* Model.Service
            const activate = row.make(server.url.origin, "1 hour").effect(host)
            // The first activation is closed part way through discovery, as a location rebuild closes it.
            yield* Effect.scoped(activate.pipe(Effect.andThen(Effect.sleep("20 millis")))).pipe(
              Effect.timeout("20 millis"),
              Effect.ignore,
            )
            yield* activate
            const model = modelState.get(Provider.ID.make(row.name), Model.ID.make(row.model))
            for (let attempt = 0; attempt < 600; attempt++) {
              if ((yield* model) !== undefined) return
              yield* Effect.promise(() => Bun.sleep(10))
            }
            expect(yield* model).toBeDefined()
          }),
        (server) => Effect.promise(() => server.stop(true)),
      ),
    )
