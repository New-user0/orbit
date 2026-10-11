import { expect, test } from "bun:test"
import { mkdir, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"

// A project of its own, with a plugin whose setup and cleanup leave a trace the test can read.
async function project() {
  const root = await tmpdir()
  const marks = path.join(root.path, "marks.txt")
  const plugin = path.join(root.path, ".orbit", "plugins", "hello")
  await mkdir(path.join(root.path, ".git"), { recursive: true })
  await mkdir(plugin, { recursive: true })
  await Bun.write(
    path.join(plugin, "tui.ts"),
    [
      'import { appendFileSync } from "node:fs"',
      "export default {",
      '  id: "project.hello",',
      "  setup() {",
      `    appendFileSync(${JSON.stringify(marks)}, "loaded\\n")`,
      `    return () => appendFileSync(${JSON.stringify(marks)}, "unloaded\\n")`,
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  return {
    path: root.path,
    // A file is read through a new handle each time, because a handle keeps what it first found.
    marks: async () => ((await Bun.file(marks).exists()) ? (await Bun.file(marks).text()).trim().split("\n") : []),
    [Symbol.asyncDispose]: () => root[Symbol.asyncDispose](),
  }
}

// The terminal UI finds its project from the directory it was started in.
async function inside<T>(directory: string, run: () => Promise<T>) {
  const before = process.cwd()
  process.chdir(directory)
  try {
    return await run()
  } finally {
    process.chdir(before)
  }
}

function status(directory: string, trusted: boolean) {
  return { directory, trusted, persistent: true, ...(trusted ? { source: "saved" } : {}), withheld: [] }
}

test("a project's plugins load once its folder is trusted and unload when the trust is taken away", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  let trusted = false
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        return json(status(fixture.path, trusted))
      },
    })
    const trust = (next: boolean) => {
      trusted = next
      setup.events.emit({
        id: `evt_trust_${next}`,
        created: 1,
        type: "trust.updated",
        data: { directory: fixture.path, trusted: next },
      })
    }
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    expect(await fixture.marks()).toEqual([])

    trust(true)
    await setup.waitFor(async () => (await fixture.marks()).length > 0, { maxPasses: 200 })
    expect(await fixture.marks()).toEqual(["loaded"])

    trust(false)
    await setup.waitFor(async () => (await fixture.marks()).length > 1, { maxPasses: 200 })
    expect(await fixture.marks()).toEqual(["loaded", "unloaded"])
  })
})

test("nothing is imported before the first answer, and a trusted folder's plugins load once with it", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  const asked = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<void>()
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        asked.resolve()
        return answer.promise.then(() => json(status(fixture.path, true)))
      },
    })
    // The startup screen stays up while the question is open, and nothing of the project has run.
    await asked.promise
    await setup.flush()
    expect(promptReady(setup.captureCharFrame())).toBe(false)
    expect(await fixture.marks()).toEqual([])

    answer.resolve()
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    expect(await fixture.marks()).toEqual(["loaded"])
  })
})

test("the project's plugins follow the trust of the folder they are found from, not that of the server's default folder", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  const asked: string[] = []
  let trusted = false
  await inside(fixture.path, async () => {
    const cwd = process.cwd()
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        const folder = url.searchParams.get("location[directory]") ?? ""
        asked.push(folder)
        // Every folder is trusted but the one the plugins are in, which is not the one the server calls its own.
        return json(status(folder, folder !== cwd || trusted))
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await setup.flush()
    expect(asked).toContain(cwd)
    expect(await fixture.marks()).toEqual([])

    trusted = true
    setup.events.emit({ id: "evt_trust", created: 1, type: "trust.updated", data: { directory: cwd, trusted: true } })
    await setup.waitFor(async () => (await fixture.marks()).length > 0, { maxPasses: 200 })
    expect(await fixture.marks()).toEqual(["loaded"])
  })
})

test("a server that takes the first read and never answers does not hold the terminal UI up, and a later change asks again", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  let answering = false
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: async (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        if (answering) return json(status(fixture.path, true))
        // Silent until the terminal UI gives up on the request.
        await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }))
        return new Response("gone", { status: 503 })
      },
    })
    await setup.ready
    // The terminal UI gives up on the read after two seconds, which takes more passes than the default allows.
    await setup.waitForFrame((frame) => promptReady(frame), { maxPasses: 600 })
    expect(await fixture.marks()).toEqual([])

    answering = true
    setup.events.emit({
      id: "evt_trust",
      created: 1,
      type: "trust.updated",
      data: { directory: fixture.path, trusted: true },
    })
    await setup.waitFor(async () => (await fixture.marks()).length > 0, { maxPasses: 200 })
    expect(await fixture.marks()).toEqual(["loaded"])
  })
}, 20_000)

test("a plugin in a folder above the folder the server calls its project waits until that folder is trusted too", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  const sub = path.join(fixture.path, "sub")
  await mkdir(sub)
  let held = true
  // The terminal UI looks for the project's root on its own and finds the repository around `sub`. The server, which
  // could not open that repository, takes `sub` as its project, and lists the folder around it as config above.
  await inside(sub, async () => {
    const cwd = process.cwd()
    const above = path.dirname(cwd)
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        return json({
          ...status(cwd, true),
          withheld: held ? [{ path: path.join(above, ".orbit"), kinds: ["plugins"], directory: above }] : [],
        })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await setup.flush()
    // The folder in view is trusted, and no dialog asks about the one above it, but its plugin has not run.
    expect(await fixture.marks()).toEqual([])

    held = false
    setup.events.emit({ id: "evt_trust", created: 1, type: "trust.updated", data: { directory: above, trusted: true } })
    await setup.waitFor(async () => (await fixture.marks()).length > 0, { maxPasses: 200 })
    expect(await fixture.marks()).toEqual(["loaded"])
  })
})

test.each([
  ["has no trust route", () => new Response("not found", { status: 404 })],
  ["fails", () => new Response("unavailable", { status: 503 })],
])("a server that %s leaves the project's plugins off and does not hold the terminal UI up", async (_, respond) => {
  await using fixture = await project()
  await using state = await tmpdir()
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        return respond()
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    expect(await fixture.marks()).toEqual([])
  })
})

test("a plugin planted while the server cannot answer is not imported on the answer from before, and the project's plugins wait", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  let answering = true
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        // The shared status keeps the last answer when a read fails, and that answer says trusted.
        return answering ? json(status(fixture.path, true)) : new Response("unavailable", { status: 503 })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await setup.waitFor(async () => (await fixture.marks()).length > 0, { maxPasses: 200 })
    expect(await fixture.marks()).toEqual(["loaded"])

    // Reconciling that the first answer started has finished, so none is still holding an answer from before.
    await setup.flush()
    await Bun.sleep(500)
    answering = false
    const planted = path.join(fixture.path, ".orbit", "plugins", "planted")
    await mkdir(planted, { recursive: true })
    await Bun.write(
      path.join(planted, "tui.ts"),
      `import { appendFileSync } from "node:fs"\nexport default { id: "project.planted", setup() { appendFileSync(${JSON.stringify(path.join(fixture.path, "marks.txt"))}, "planted\\n") } }\n`,
    )
    // The read that reconciling makes fails, so nothing of the project is imported on the older answer: the plugin that
    // was loaded is unloaded with the rest, and the new one never runs.
    await setup.waitFor(async () => (await fixture.marks()).includes("unloaded"), { maxPasses: 400 })
    expect(await fixture.marks()).toEqual(["loaded", "unloaded"])
  })
}, 30_000)

test("a project's tui-only plugin is not imported while the server reports its plugins as changed", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        return json({
          ...status(fixture.path, true),
          changed: [{ path: path.join(fixture.path, ".orbit"), kinds: ["plugins"] }],
        })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await Bun.sleep(500)
    expect(await fixture.marks()).toEqual([])
  })
}, 30_000)

test("a project's tui entry that links out of its folder is not imported", async () => {
  await using fixture = await project()
  await using state = await tmpdir()
  const entry = path.join(fixture.path, ".orbit", "plugins", "hello", "tui.ts")
  const outside = `${fixture.path}-outside.ts`
  await Bun.write(outside, await Bun.file(entry).text())
  await rm(entry)
  const linked = await symlink(outside, entry, "file").then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM" || error.code === "UNKNOWN") return false
      throw error
    },
  )
  if (!linked) return
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        return json(status(fixture.path, true))
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await Bun.sleep(500)
    expect(await fixture.marks()).toEqual([])
  })
  await rm(outside)
}, 30_000)
