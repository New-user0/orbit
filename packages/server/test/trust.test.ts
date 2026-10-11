import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Orbit } from "@orbit/client"
import { Effect } from "effect"
import { withEnv } from "../../core/test/fixture/env"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// Servers here never trust a folder on their own, so a repository is untrusted until a request says otherwise.
const untrusted = { trust: { implicit: false } }

// A repository with the two things that run code on their own: a hook in its settings and a plugin in its `.orbit`
// directory. A folder of its own stands in for the home directory.
const layout = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-trust-endpoint-")))
  const folders = {
    config: path.join(tmp.path, "config"),
    home: path.join(tmp.path, "home"),
    repo: path.join(tmp.path, "repo"),
  }
  yield* Effect.promise(async () => {
    await fs.mkdir(folders.home, { recursive: true })
    await Bun.write(
      path.join(folders.repo, "orbit.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "echo project" }] }] },
      }),
    )
    await Bun.write(
      path.join(folders.repo, ".orbit", "plugins", "greeter.ts"),
      `export default { id: "greeter", async setup() {} }`,
    )
  })
  return folders
})

it.live("lists what an untrusted repository holds back, then trusts it for good and lists the grant", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    yield* Effect.promise(async () => {
      const before = await api.location.trust.get({ location })
      expect(before).toEqual({
        directory: folders.repo,
        trusted: false,
        persistent: true,
        withheld: [
          { path: path.join(folders.repo, "orbit.json"), kinds: ["hooks"] },
          { path: path.join(folders.repo, ".orbit"), kinds: ["plugins"] },
        ],
        changed: [],
      })
      expect(await api.location.trust.list()).toEqual([])

      // Persisting is the default, which is what a person at a terminal means by "trust this folder".
      const granted = await api.location.trust.update({ location, trust: true })
      expect(granted).toEqual({
        directory: folders.repo,
        trusted: true,
        persistent: true,
        source: "saved",
        withheld: [],
        changed: [],
      })
      expect(await api.location.trust.get({ location })).toEqual(granted)

      const [grant, ...rest] = await api.location.trust.list()
      expect(rest).toEqual([])
      expect(grant).toMatchObject({ directory: folders.repo, via: "api" })
      expect(grant?.time).toBeGreaterThan(0)

      // Revoking ends the grant and puts back what it had let through.
      expect(await api.location.trust.update({ location, trust: false })).toEqual(before)
      expect(await api.location.trust.get({ location })).toEqual(before)
      expect(await api.location.trust.list()).toEqual([])
    })
  }),
)

it.live("answers over HTTP in the shape the schema describes, and holds every route to the server's credentials", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    const url = (route: string) => {
      const target = new URL(route, server.base)
      target.searchParams.set("location[directory]", folders.repo)
      return target
    }
    const post = (body: unknown, headers: Record<string, string> = server.headers) =>
      fetch(url("/api/location/trust"), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    yield* Effect.promise(async () => {
      const response = await fetch(url("/api/location/trust"), { headers: server.headers })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ directory: folders.repo, trusted: false, persistent: true })
      expect(response.headers.get("content-type")).toContain("application/json")

      // A body that does not say which way to go is a bad request, not a revoke.
      expect((await post({})).status).toBe(400)
      expect((await post({ trust: "yes" })).status).toBe(400)
      expect((await fetch(url("/api/location/trust"), { headers: server.headers })).status).toBe(200)

      expect((await post({ trust: true })).status).toBe(200)
      const listed = await fetch(new URL("/api/trust", server.base), { headers: server.headers })
      expect(listed.status).toBe(200)
      expect(await listed.json()).toEqual([{ directory: folders.repo, time: expect.any(Number), via: "api" }])

      // Without the credentials none of the three answers, and a grant cannot be made.
      expect((await fetch(url("/api/location/trust"))).status).toBe(401)
      expect((await fetch(new URL("/api/trust", server.base))).status).toBe(401)
      expect((await post({ trust: false }, {})).status).toBe(401)
      expect(await (await fetch(new URL("/api/trust", server.base), { headers: server.headers })).json()).toHaveLength(
        1,
      )
    })
  }),
)

it.live("trusts the home directory only until the server restarts, and never stores that grant", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    yield* withEnv({ ORBIT_TEST_HOME: folders.home }, () =>
      Effect.gen(function* () {
        const server = yield* startServer(folders.config, untrusted)
        const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
        const location = { directory: folders.home }
        yield* Effect.promise(async () => {
          expect(await api.location.trust.get({ location })).toEqual({
            directory: folders.home,
            trusted: false,
            persistent: false,
            withheld: [],
            changed: [],
          })

          // Asking to persist is not refused: the grant is made, and the status says what kind of grant it is.
          const granted = await api.location.trust.update({ location, trust: true, persist: true })
          expect(granted).toEqual({
            directory: folders.home,
            trusted: true,
            persistent: false,
            source: "session",
            withheld: [],
            changed: [],
          })
          expect(await api.location.trust.list()).toEqual([])

          expect(await api.location.trust.update({ location, trust: false })).toMatchObject({
            trusted: false,
            persistent: false,
          })
        })
      }),
    )
  }),
)

it.live("trusts a repository for this server process alone when the grant is not persisted", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    yield* Effect.promise(async () => {
      expect(await api.location.trust.update({ location, trust: true, persist: false })).toEqual({
        directory: folders.repo,
        trusted: true,
        persistent: true,
        source: "session",
        withheld: [],
        changed: [],
      })
      // Nothing was stored, so no later server knows about it.
      expect(await api.location.trust.list()).toEqual([])
      expect(await api.location.trust.update({ location, trust: false })).toMatchObject({ trusted: false })
    })
  }),
)

it.live("lists grants without loading a location", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    yield* Effect.promise(async () => {
      expect(await api.location.trust.list()).toEqual([])
      expect(await api.debug.location.list()).toEqual([])
      // The same listing does show a location once a request that needs one has booted it.
      await api.location.trust.get({ location: { directory: folders.repo } })
      expect(await api.debug.location.list()).toHaveLength(1)
    })
  }),
)

it.live("revokes a stored grant by the folder's name, and trusts a holder only where the location holds config back for it", () =>
  Effect.gen(function* () {
    const folders = yield* layout
    const server = yield* startServer(folders.config, untrusted)
    const api = Orbit.make({ baseUrl: server.base, headers: server.headers })
    const location = { directory: folders.repo }
    yield* Effect.promise(async () => {
      // A folder that holds nothing back here is not trusted through this location, whatever the request names.
      const stray = await api.location.trust.update({ location, trust: true, holder: folders.home })
      expect(stray).toMatchObject({ directory: folders.repo, trusted: false })
      expect(await api.location.trust.list()).toEqual([])

      // The project's own root is a holder, and the answer is the location's status.
      const granted = await api.location.trust.update({ location, trust: true, holder: folders.repo })
      expect(granted).toMatchObject({ directory: folders.repo, trusted: true, source: "saved" })

      // By name: the folder is deleted, and the grant goes with its records.
      await fs.rm(folders.repo, { recursive: true, force: true })
      expect(await api.location.trust.revoke({ directory: folders.repo })).toEqual([folders.repo])
      expect(await api.location.trust.list()).toEqual([])
      expect(await api.location.trust.revoke({ directory: folders.repo })).toEqual([])
    })
  }),
)
