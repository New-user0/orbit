import { expect } from "bun:test"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { Plugin } from "@orbit/plugin/effect"
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/unstable/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

it.live(
  "provider reads wait for plugins, as authentication discovery does",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("orbit-provider-endpoints-")
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const context = yield* Layer.build(
        createRoutes({
          password: "secret",
          database: { path: ":memory:" },
          models: { fetch: false },
          fs: { filewatcher: false },
          config: {
            directory: tmp.path,
            project: false,
            content: JSON.stringify({
              providers: {
                custom: {
                  name: "Configured Custom Provider",
                  package: "@orbit/ai/providers/openai-compatible",
                  settings: { apiKey: "secret" },
                  models: { chat: {} },
                },
              },
            }),
          },
        }).pipe(Layer.provide(HttpServer.layerServices)),
      )
      const sdk = Context.get(context, SdkPlugins.Service)
      yield* sdk.register(
        Plugin.define({
          id: "slow-plugin",
          effect: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
            }),
        }),
      )
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const request = (method: "GET" | "POST", route: string) =>
        Effect.promise((signal) => {
          const url = new URL(route, "http://orbit.local")
          url.searchParams.set("location[directory]", tmp.path)
          return handler(
            new Request(url, {
              method,
              headers: { authorization: `Basic ${btoa("orbit:secret")}` },
              signal,
            }),
          )
        })
      // Config providers activate after SDK plugins, so the reads wait for that instead of answering without them: the
      // model routes wait too, and a client that asks for providers and models together would otherwise get models
      // whose provider it was told does not exist.
      const list = yield* request("GET", "/api/provider").pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const get = yield* request("GET", "/api/provider/custom").pipe(Effect.forkScoped)
      const integrations = yield* request("GET", "/api/integration").pipe(Effect.forkScoped)
      // Still unanswered while the slow plugin holds activation.
      expect(yield* Fiber.join(list).pipe(Effect.timeoutOption("500 millis"))).toEqual(Option.none())
      expect(yield* Fiber.join(get).pipe(Effect.timeoutOption("1 millis"))).toEqual(Option.none())
      yield* Deferred.succeed(release, undefined)
      const listed = yield* Fiber.join(list)
      expect(listed.status).toBe(200)
      expect(yield* Effect.promise(() => listed.json())).toMatchObject({
        location: { directory: tmp.path },
        data: expect.arrayContaining([expect.objectContaining({ id: "custom" })]),
      })
      const found = yield* Fiber.join(get)
      expect(found.status).toBe(200)
      expect(yield* Effect.promise(() => found.json())).toMatchObject({ data: { id: "custom" } })
      const discovered = yield* Fiber.join(integrations)
      expect(discovered.status).toBe(200)
      expect(yield* Effect.promise(() => discovered.json())).toMatchObject({
        data: expect.arrayContaining([expect.objectContaining({ id: "anthropic" })]),
      })
    }),
  15_000,
)
