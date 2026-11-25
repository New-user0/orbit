import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// `ProjectTrust.grant` says that what the project holds applies by the time its answer arrives. The config was read
// again before the answer, but the providers that config names come from plugins that reactivate after it, so a client
// that listed the folder's models right after the grant got the list of before the grant. `orb doctor --probe --trust`
// does exactly that (class 3: the models it lists and probes must be those of the folder it was granted for): in the
// Windows cli run of PR #150 the probe listed only the global `ollama` model, not the folder's own `clone` provider
// (docs/known-failures.md, `packages/cli/test/trust-first.test.ts`), because `settledModels` took the stale list as
// settled after three unchanged polls.
const project = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-trust-grant-models-")))
  const folders = { config: path.join(tmp.path, "config"), repo: path.join(tmp.path, "repo") }
  yield* Effect.promise(async () => {
    await fs.mkdir(folders.config, { recursive: true })
    await Bun.write(
      path.join(folders.repo, "orbit.json"),
      JSON.stringify({
        providers: {
          clone: {
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { apiKey: "secret", baseURL: "http://127.0.0.1:9/v1" },
            models: { "clone-model": {} },
          },
        },
      }),
    )
    // A plugin the folder ships, which only a trusted folder runs: what it adds tells whether it is active.
    await Bun.write(
      path.join(folders.repo, ".orbit/plugins/greeter.ts"),
      `export default {
        id: "greeter",
        async setup(ctx) {
          await ctx.command.transform((editor) => editor.add({ name: "greet-project", execute: async () => {} }))
        },
      }`,
    )
  })
  return folders
})

const lists = (models: ReadonlyArray<{ readonly providerID: string; readonly id: string }>) =>
  models.some((model) => model.providerID === "clone" && model.id === "clone-model")

const greets = (commands: ReadonlyArray<{ readonly name: string }>) =>
  commands.some((command) => command.name === "greet-project")

// The plugin list answers from what is running now, without waiting for an activation that is under way.
const runs = (plugins: ReadonlyArray<{ readonly id?: string; readonly state: { readonly status: string } }>) =>
  plugins.some((plugin) => plugin.id === "greeter" && plugin.state.status === "active")

it.live("the models listed right after a grant are those of the folder that was granted", () =>
  Effect.gen(function* () {
    const folders = yield* project
    const server = yield* startServer(folders.config, { trust: { implicit: false } })
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    yield* Effect.promise(async () => {
      // Untrusted, nothing of the folder is read: its provider is not listed.
      expect(lists((await api.model.list({ location })).data)).toBe(false)
      await api.location.trust.update({ location, trust: true })
      // Asked once, at once, as a client that trusts the grant's answer does.
      expect(lists((await api.model.list({ location })).data)).toBe(true)
    })
  }),
)

it.live("a folder trusted from the start lists its provider: the control for the row above", () =>
  Effect.gen(function* () {
    const folders = yield* project
    const server = yield* startServer(folders.config, { trust: { implicit: true } })
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    yield* Effect.promise(async () => {
      const deadline = Date.now() + 10_000
      while (!lists((await api.model.list({ location })).data) && Date.now() < deadline) await Bun.sleep(25)
      expect(lists((await api.model.list({ location })).data)).toBe(true)
    })
  }),
  15_000,
)

// The same route ends trust, and a revoke has to take effect as promptly as a grant: a client that revokes and then
// starts work must not reach the provider, and the address, that the folder chose.
it.live("the models listed right after a revoke no longer include the folder's provider", () =>
  Effect.gen(function* () {
    const folders = yield* project
    const server = yield* startServer(folders.config, { trust: { implicit: false } })
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    yield* Effect.promise(async () => {
      await api.location.trust.update({ location, trust: true })
      expect(lists((await api.model.list({ location })).data)).toBe(true)
      expect(greets((await api.command.list({ location })).data)).toBe(true)
      await api.location.trust.update({ location, trust: false })
      expect(lists((await api.model.list({ location })).data)).toBe(false)
      // The folder's own plugin has stopped by the answer too.
      expect(runs((await api.plugin.list({ location })).data)).toBe(false)
      expect(greets((await api.command.list({ location })).data)).toBe(false)
    })
  }),
)

// A grant can also be ended by the folder's name, with no Location in the request. The Location the server holds for
// that folder stops listing its provider before the answer.
it.live("the models listed right after a revoke by name no longer include the folder's provider", () =>
  Effect.gen(function* () {
    const folders = yield* project
    const server = yield* startServer(folders.config, { trust: { implicit: false } })
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    yield* Effect.promise(async () => {
      await api.location.trust.update({ location, trust: true })
      expect(lists((await api.model.list({ location })).data)).toBe(true)
      expect(greets((await api.command.list({ location })).data)).toBe(true)
      expect(await api.location.trust.revoke({ directory: folders.repo })).toEqual([folders.repo])
      expect(lists((await api.model.list({ location })).data)).toBe(false)
      expect(runs((await api.plugin.list({ location })).data)).toBe(false)
      expect(greets((await api.command.list({ location })).data)).toBe(false)
    })
  }),
)
