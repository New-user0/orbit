import fs from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { afterAll, expect, setDefaultTimeout } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// Each row builds a server, which a loaded Windows runner takes up to 5 s to start (row-limits.test.ts).
setDefaultTimeout(30_000)

// A grant answers once the folder's plugins that are available locally are active (trust-grant-models.test.ts). A
// folder can also name a plugin package that has to be installed first, and an install takes as long as the registry
// does. The clients wait for a grant with a limit (VS Code's is 10 s), so a grant that waited for the install would be
// reported as failed although it was stored. Here the registry accepts the connection and never answers.
// Its connections are cut when the file ends, so the install fails then and lets go of what it holds (the package
// cache's lock) before the next file runs.
const connections = new Set<net.Socket>()
const silent = net.createServer((socket) => {
  connections.add(socket)
})
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
const registry = process.env.npm_config_registry
process.env.npm_config_registry = `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}/`
afterAll(() => {
  if (registry === undefined) delete process.env.npm_config_registry
  if (registry !== undefined) process.env.npm_config_registry = registry
  connections.forEach((socket) => socket.destroy())
  silent.close()
})

const clone = {
  package: "aisdk:@ai-sdk/openai-compatible",
  settings: { apiKey: "secret", baseURL: "http://127.0.0.1:9/v1" },
  models: { "clone-model": {} },
}

// A config folder and a repository whose orbit.json files name the given packages. The repository also names its own
// provider, which applies without any install.
const project = (packages: { readonly global?: string; readonly folder?: string }) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-trust-grant-install-")))
    const folders = { config: path.join(tmp.path, "config"), repo: path.join(tmp.path, "repo") }
    yield* Effect.promise(async () => {
      await fs.mkdir(folders.config, { recursive: true })
      if (packages.global)
        await Bun.write(path.join(folders.config, "orbit.json"), JSON.stringify({ plugins: [packages.global] }))
      await Bun.write(
        path.join(folders.repo, "orbit.json"),
        JSON.stringify({ ...(packages.folder ? { plugins: [packages.folder] } : {}), providers: { clone } }),
      )
    })
    return folders
  })

const lists = (models: ReadonlyArray<{ readonly providerID: string; readonly id: string }>) =>
  models.some((model) => model.providerID === "clone" && model.id === "clone-model")

// Each call answers within the limit a client gives it (VS Code's grant waits 10 s).
const within = async <A>(call: (signal: AbortSignal) => Promise<A>) => {
  const started = performance.now()
  const result = await call(AbortSignal.timeout(10_000))
  expect(performance.now() - started).toBeLessThan(10_000)
  return result
}

// The install the first grant started still waits on the registry when the revoke and the second grant arrive. Each is
// taken up and answered on its own, not queued behind that install, and the model list follows each one.
it.live(
  "a revoke and a second grant while the first grant's package install waits each answer and list the folder as it then stands",
  () =>
    Effect.gen(function* () {
      const folders = yield* project({ folder: "orbit-grant-install-again@1.0.0" })
      const server = yield* startServer(folders.config, { trust: { implicit: false } })
      const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
      const location = { directory: folders.repo }
      yield* Effect.promise(async () => {
        const models = async () => lists((await within((signal) => api.model.list({ location }, { signal }))).data)
        const update = (trust: boolean) =>
          within((signal) => api.location.trust.update({ location, trust }, { signal }))
        expect(await update(true)).toMatchObject({ trusted: true })
        expect(await models()).toBe(true)
        expect(await update(false)).toMatchObject({ trusted: false })
        expect(await models()).toBe(false)
        expect(await update(true)).toMatchObject({ trusted: true })
        expect(await models()).toBe(true)
      })
    }),
  30_000,
)

// Here the package that waits is a global one, named by the config folder: the server's first activation starts its
// install before any request, and a grant that follows does not wait for it.
it.live(
  "a grant while a global plugin's package install waits answers and lists the folder's models",
  () =>
    Effect.gen(function* () {
      const folders = yield* project({ global: "orbit-grant-install-global@1.0.0" })
      const server = yield* startServer(folders.config, { trust: { implicit: false } })
      const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
      const location = { directory: folders.repo }
      yield* Effect.promise(async () => {
        expect(lists((await within((signal) => api.model.list({ location }, { signal }))).data)).toBe(false)
        expect(
          await within((signal) => api.location.trust.update({ location, trust: true }, { signal })),
        ).toMatchObject({ trusted: true })
        expect(lists((await within((signal) => api.model.list({ location }, { signal }))).data)).toBe(true)
      })
    }),
  30_000,
)

it.live(
  "a grant of a folder that names a plugin package to install answers before the install and is stored",
  () =>
    Effect.gen(function* () {
      const folders = yield* project({ folder: "orbit-grant-install-plugin@1.0.0" })
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
