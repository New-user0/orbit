import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { expect } from "bun:test"
import { Effect } from "effect"
import { CompatNames } from "../../compat/src/names"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// trust-first part 2: the owner's two "match refrence" decisions of 2026-10-21, over HTTP, against servers that never
// trust a folder on their own (as the background service and an SDK host that sets nothing do).
// - D7: config is read only from the project's own folders, never from a folder above the project, even one whose grant
//   covers the project below it.
// - D8: a trusted folder's config loads as it is now. A change after the grant is not held back, and the trust status
//   has no list of changes to trust again.
const untrusted = { trust: { implicit: false } }

type Server = { readonly base: string; readonly headers: Record<string, string> }

function request(server: Server, method: string, route: string, input: { directory?: string; body?: unknown } = {}) {
  const url = new URL(route, server.base)
  if (input.directory !== undefined) url.searchParams.set("location[directory]", input.directory)
  return fetch(
    new Request(url, {
      method,
      headers: { ...server.headers, "content-type": "application/json" },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    }),
  ).then(async (response) => ({ status: response.status, body: (await response.json().catch(() => undefined)) as unknown }))
}

const grant = (server: Server, directory: string) =>
  request(server, "POST", "/api/location/trust", { directory, body: { trust: true, persist: false } })
const reload = (server: Server) => request(server, "POST", "/api/location/reload")
const status = (server: Server, directory: string) =>
  request(server, "GET", "/api/location/trust", { directory }).then((response) => response.body as Record<string, unknown>)
// What the config, agent, command and skill routes answer for a folder, each as one string to search.
const read = (server: Server, directory: string) =>
  Promise.all(
    ["/api/config", "/api/agent", "/api/command", "/api/skill"].map((route) =>
      request(server, "GET", route, { directory }).then((response) => JSON.stringify(response.body)),
    ),
  )

const hook = (command: string) => ({ matcher: "shell", hooks: [{ type: "command", command }] })

const root = Effect.gen(function* () {
  const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-trust-reference-")))
  const real = yield* Effect.promise(() => fs.realpath(tmp.path))
  const config = path.join(real, "config")
  yield* Effect.promise(() => fs.mkdir(config, { recursive: true }))
  return { real, config }
})

// A folder above a repository, holding config of every kind a config folder can supply, each named so a listing shows
// whether it was read; and the repository below it, with a command of its own and one in a folder between the working
// folder and its root.
const nested = Effect.gen(function* () {
  const folders = yield* root
  const above = path.join(folders.real, "work")
  const repo = path.join(above, "repo")
  const inner = path.join(repo, "packages", "app")
  yield* Effect.promise(async () => {
    await fs.mkdir(inner, { recursive: true })
    await $`git init -q`.cwd(repo).quiet()
    await Bun.write(path.join(above, "orbit.json"), JSON.stringify({ username: "clone-above-user" }))
    await Bun.write(
      path.join(above, ".orbit", "agents", "above-agent.md"),
      "---\ndescription: CLONE-ABOVE-AGENT from the folder above\n---\nYou are the folder above's agent.\n",
    )
    await Bun.write(
      path.join(above, ".orbit", "commands", "above-command.md"),
      "---\ndescription: CLONE-ABOVE-COMMAND from the folder above\n---\nDo what the folder above says.\n",
    )
    await Bun.write(
      path.join(above, ".orbit", "skills", "above-skill", "SKILL.md"),
      "---\nname: above-skill\ndescription: CLONE-ABOVE-SKILL from the folder above\n---\nThe folder above's skill.\n",
    )
    // Another product's shared skills folder above the project.
    await Bun.write(
      path.join(above, CompatNames.agents, "skills", "above-compat-skill", "SKILL.md"),
      "---\nname: above-compat-skill\ndescription: CLONE-ABOVE-COMPAT-SKILL from the folder above\n---\nIts skill.\n",
    )
    await Bun.write(
      path.join(repo, ".orbit", "commands", "own-command.md"),
      "---\ndescription: CLONE-OWN-COMMAND from the repository\n---\nThe repository's command.\n",
    )
    await Bun.write(
      path.join(inner, ".orbit", "commands", "inner-command.md"),
      "---\ndescription: CLONE-INNER-COMMAND from a folder inside the repository\n---\nThe inner folder's command.\n",
    )
  })
  return { ...folders, above, repo, inner }
})

it.live("a folder above a project supplies no config to it, even once a grant for that folder covers the project", () =>
  Effect.gen(function* () {
    const folders = yield* nested
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect((await grant(server, folders.above)).status).toBe(200)
      expect((await reload(server)).status).toBe(204)
      // The grant covers the project below the folder: part 1's parent walk.
      expect(await status(server, folders.inner)).toMatchObject({ trusted: true, granted: folders.above })

      const [config, agents, commands, skills] = await read(server, folders.inner)
      // The control: the project's own folders are read, its root and the folder between the root and the working folder.
      expect(commands).toContain("CLONE-OWN-COMMAND")
      expect(commands).toContain("CLONE-INNER-COMMAND")
      // Nothing of the folder above is, though it is trusted: as the reference reads project settings only from the
      // project it starts in.
      expect(config).not.toContain("clone-above-user")
      expect(agents).not.toContain("CLONE-ABOVE-AGENT")
      expect(commands).not.toContain("CLONE-ABOVE-COMMAND")
      expect(skills).not.toContain("CLONE-ABOVE-SKILL")
      expect(skills).not.toContain("CLONE-ABOVE-COMPAT-SKILL")
      // And nothing above the project is listed as held back for it, since nothing there is a source.
      expect(await status(server, folders.inner)).toMatchObject({ withheld: [] })
    })
  }),
)

it.live("a trusted folder's config that changes after the grant applies as it is, and nothing asks to trust it again", () =>
  Effect.gen(function* () {
    const folders = yield* root
    const repo = path.join(folders.real, "repo")
    const settings = path.join(repo, "orbit.json")
    yield* Effect.promise(() => Bun.write(settings, JSON.stringify({ hooks: { PreToolUse: [hook("echo one")] } })))
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect((await grant(server, repo)).status).toBe(200)
      expect((await reload(server)).status).toBe(204)

      // A pull adds a hook after the grant.
      await Bun.write(
        settings,
        JSON.stringify({ hooks: { PreToolUse: [hook("echo one"), hook("echo CLONE-HOOK-AFTER-GRANT")] } }),
      )
      expect((await reload(server)).status).toBe(204)

      const [config] = await read(server, repo)
      expect(config).toContain("CLONE-HOOK-AFTER-GRANT")
      const answer = await status(server, repo)
      expect(answer).toMatchObject({ trusted: true, withheld: [] })
      expect(Object.keys(answer)).not.toContain("changed")
    })
  }),
)

// FU-M4-379: a project that a grant for a folder above covers read its own executable config as changed since that grant.
it.live("a project below a granted folder applies its own hooks without a grant of its own", () =>
  Effect.gen(function* () {
    const folders = yield* root
    const parent = path.join(folders.real, "work")
    const child = path.join(parent, "child")
    yield* Effect.promise(() =>
      Bun.write(path.join(child, "orbit.json"), JSON.stringify({ hooks: { SessionStart: [hook("echo CLONE-CHILD-HOOK")] } })),
    )
    const server = yield* startServer(folders.config, untrusted)
    yield* Effect.promise(async () => {
      expect((await grant(server, parent)).status).toBe(200)
      expect((await reload(server)).status).toBe(204)
      const [config] = await read(server, child)
      expect(config).toContain("CLONE-CHILD-HOOK")
      const answer = await status(server, child)
      expect(answer).toMatchObject({ trusted: true, granted: parent, withheld: [] })
      expect(Object.keys(answer)).not.toContain("changed")
    })
  }),
)
