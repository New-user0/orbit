import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { afterAll, expect } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// A grant answers once the folder's plugins that are available locally are active (trust-grant-models.test.ts). A
// folder can also name a plugin package that has to be installed first, and an install takes as long as the registry
// does. The clients wait for a grant with a limit (VS Code's is 10 s), so a grant that waited for the install would be
// reported as failed although it was stored. Here the registry accepts the connection and never answers.
const silent = net.createServer(() => {})
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
const registry = process.env.npm_config_registry
process.env.npm_config_registry = `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}/`
afterAll(() => {
  if (registry === undefined) delete process.env.npm_config_registry
  if (registry !== undefined) process.env.npm_config_registry = registry
  silent.close()
})

it.live(
  "a grant of a folder that names a plugin package to install answers before the install and is stored",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-trust-grant-install-")))
      const folders = { config: path.join(tmp.path, "config"), repo: path.join(tmp.path, "repo") }
      yield* Effect.promise(async () => {
        await fs.mkdir(folders.config, { recursive: true })
        await Bun.write(
          path.join(folders.repo, "orbit.json"),
          JSON.stringify({
            plugins: ["orbit-grant-install-plugin@1.0.0"],
            providers: {
              clone: {
                package: "aisdk:@ai-sdk/openai-compatible",
                settings: { apiKey: "secret", baseURL: "http://127.0.0.1:9/v1" },
                models: { "clone-model": {} },
              },
            },
          }),
        )
      })
      const server = yield* startServer(folders.config, { trust: { implicit: false } })
      const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
      const location = { directory: folders.repo }
      yield* Effect.promise(async () => {
        const started = performance.now()
        const granted = await api.location.trust.update(
          { location, trust: true },
          { signal: AbortSignal.timeout(10_000) },
        )
        expect(performance.now() - started).toBeLessThan(10_000)
        expect(granted).toMatchObject({ directory: folders.repo, trusted: true, source: "saved" })
        expect(await api.location.trust.get({ location })).toEqual(granted)
        expect((await api.location.trust.list()).map((grant) => grant.directory)).toEqual([folders.repo])
        // What was available locally is active by the answer: the folder's own provider.
        expect(
          (await api.model.list({ location })).data.some(
            (model) => model.providerID === "clone" && model.id === "clone-model",
          ),
        ).toBe(true)
      })
    }),
  30_000,
)
