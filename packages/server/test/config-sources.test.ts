import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// The server runs with its file watcher off, as a server started with ORBIT_DISABLE_FILEWATCHER does, so only a report
// of a changed file can make it read the agent files again.

const agent = (description: string) => `---\ndescription: ${JSON.stringify(description)}\n---\n\nYou help with ${description}.\n`

const setup = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  const agents = path.join(project, ".orbit", "agents")
  yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
  yield* Effect.promise(() => fs.mkdir(agents, { recursive: true }))
  // The directory entry exists once a file is in it.
  yield* Effect.promise(() => fs.writeFile(path.join(agents, "base.md"), agent("the base")))
  const server = yield* startServer(global)
  const call = (route: string, body?: unknown) => {
    const url = new URL(route, server.base)
    url.searchParams.set("location[directory]", project)
    return Effect.promise(() =>
      fetch(
        url,
        body === undefined
          ? { headers: server.headers }
          : { method: "POST", headers: { ...server.headers, "content-type": "application/json" }, body: JSON.stringify(body) },
      ),
    )
  }
  const names = Effect.gen(function* () {
    const response = yield* call("/api/agent")
    const body = (yield* Effect.promise(() => response.json())) as { data: { id: string }[] }
    return body.data.map((item) => item.id)
  })
  // The agent plugin rebuilds after a 100 ms debounce.
  const appears = (id: string, present = true) =>
    names.pipe(
      Effect.flatMap((list) => (list.includes(id) === present ? Effect.void : Effect.fail("not yet"))),
      Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 60 }),
    )
  return { tmp, project, agents, call, names, appears }
})

it.live("a reported agent file is read again, and an unreported one is not", () =>
  Effect.gen(function* () {
    const { agents, call, names, appears } = yield* setup
    yield* appears("base")
    const file = path.join(agents, "x.md")
    yield* Effect.promise(() => fs.writeFile(file, agent("x things")))
    yield* Effect.sleep("500 millis")
    // Without a watcher nothing has noticed the new file.
    expect(yield* names).not.toContain("x")

    const response = yield* call("/api/experimental/config/sources/changed", { paths: [file] })
    expect(response.status).toBe(204)
    yield* appears("x")
  }),
)

it.live("a path outside every config directory changes nothing", () =>
  Effect.gen(function* () {
    const { tmp, project, call, names, appears } = yield* setup
    // Build the location first, so that what follows is read only if something asks for it.
    yield* appears("base")
    // An agent file under a folder that is not a config directory, and one that is only named like one.
    const stray = path.join(project, "docs", "agents")
    yield* Effect.promise(() => fs.mkdir(stray, { recursive: true }))
    const outside = path.join(stray, "y.md")
    yield* Effect.promise(() => fs.writeFile(outside, agent("y things")))
    const elsewhere = path.join(tmp.path, "elsewhere.md")
    yield* Effect.promise(() => fs.writeFile(elsewhere, agent("z things")))
    // Written into the real config directory, but reported by neither the directory nor a path inside it.
    const hidden = path.join(project, ".orbit", "agents", "w.md")
    yield* Effect.promise(() => fs.writeFile(hidden, agent("w things")))

    const response = yield* call("/api/experimental/config/sources/changed", {
      paths: [outside, elsewhere, "relative/y.md", path.join(project, "does-not-exist.md")],
    })
    expect(response.status).toBe(204)
    yield* Effect.sleep("600 millis")
    const list = yield* names
    expect(list).not.toContain("y")
    expect(list).not.toContain("z")
    // The hidden file was never reported, and none of the ignored paths made the server read the directory again.
    expect(list).not.toContain("w")
  }),
)

it.live("a link out of the config directory is not followed", () =>
  Effect.gen(function* () {
    const { tmp, agents, call, names, appears } = yield* setup
    yield* appears("base")
    const outside = path.join(tmp.path, "outside")
    yield* Effect.promise(() => fs.mkdir(outside, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(outside, "v.md"), agent("v things")))
    const link = path.join(agents, "linked")
    const made = yield* Effect.promise(() =>
      fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir").then(
        () => true,
        () => false,
      ),
    )
    if (!made) return
    yield* call("/api/experimental/config/sources/changed", { paths: [path.join(link, "v.md")] })
    yield* Effect.sleep("600 millis")
    expect(yield* names).not.toContain("v")
  }),
)

it.live("more than a hundred paths are refused", () =>
  Effect.gen(function* () {
    const { project, call } = yield* setup
    const response = yield* call("/api/experimental/config/sources/changed", {
      paths: Array.from({ length: 101 }, (_, index) => path.join(project, `${index}.md`)),
    })
    expect(response.status).toBe(400)
  }),
)
