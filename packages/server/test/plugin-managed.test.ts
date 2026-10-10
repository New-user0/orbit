import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// Sets environment variables for the rest of the test's scope.
const environment = (values: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
      Object.assign(process.env, values)
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
  )

it.live("refuses with a 403 to update or check a plugin package that managed settings block, before any registry request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("orbit-plugin-managed-")
      const global = path.join(tmp.path, "global")
      const project = path.join(tmp.path, "project")
      const managed = path.join(tmp.path, "managed")
      yield* Effect.promise(() =>
        Promise.all([global, project, managed].map((directory) => fs.mkdir(directory, { recursive: true }))),
      )
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(
            path.join(managed, "managed-settings.json"),
            JSON.stringify({ managed: { plugins: { block: ["@corp/blocked"] } } }),
          ),
          fs.writeFile(
            path.join(project, "orbit.json"),
            JSON.stringify({ plugins: ["@corp/blocked@^1", "@corp/fine@^1"] }),
          ),
        ]),
      )
      // A registry that records every request, so "never contacted" is something the test can see.
      const requests: string[] = []
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch(request) {
              requests.push(decodeURIComponent(new URL(request.url).pathname))
              return new Response("{}", { status: 404 })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      yield* environment({
        ORBIT_TEST_HOME: path.join(tmp.path, "home"),
        npm_config_registry: `http://127.0.0.1:${registry.port}/`,
      })
      const server = yield* startServer(global, { managed })
      const post = (route: string, body: unknown) => {
        const url = new URL(route, server.base)
        url.searchParams.set("location[directory]", project)
        return Effect.promise(() =>
          fetch(url, {
            method: "POST",
            headers: { ...server.headers, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        )
      }
      const mentions = (name: string) => requests.filter((item) => item.includes(name))
      // Both packages are in the inventory (one as a failed entry) once the first activation has finished.
      const listed = new URL("/api/plugin", server.base)
      listed.searchParams.set("location[directory]", project)
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const body: { data: { source?: { target?: string } }[] } = await (
            await fetch(listed, { headers: server.headers })
          ).json()
          if (body.data.some((plugin) => plugin.source?.target === "@corp/blocked@^1")) return
          await Bun.sleep(100)
        }
        throw new Error("the blocked package never appeared in the inventory")
      })

      const refused = yield* post("/api/plugin/update", { targets: ["@corp/blocked@^1"] })
      expect(refused.status).toBe(403)
      expect(yield* Effect.promise(() => refused.json())).toMatchObject({ _tag: "ForbiddenError" })
      const checked = yield* post("/api/plugin/check", { target: "@corp/blocked@^1" })
      expect(checked.status).toBe(200)
      expect(mentions("blocked")).toEqual([])

      // The control: the registry is wired, because the package the lists do not touch was requested while loading.
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 100 && mentions("fine").length === 0; attempt++) await Bun.sleep(100)
      })
      expect(mentions("fine").length).toBeGreaterThan(0)
      expect(mentions("blocked")).toEqual([])
    }),
  ),
)
