import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
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
