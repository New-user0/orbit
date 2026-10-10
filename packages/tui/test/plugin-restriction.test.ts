import { expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"

// A project with one plugin that leaves a trace when its module is evaluated, when its setup runs and when it unloads.
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
      `appendFileSync(${JSON.stringify(marks)}, "imported\\n")`,
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
    plugin,
    real: await realpath(plugin),
    marks: async () => ((await Bun.file(marks).exists()) ? (await Bun.file(marks).text()).trim().split("\n") : []),
    [Symbol.asyncDispose]: () => root[Symbol.asyncDispose](),
  }
}

type Fixture = Awaited<ReturnType<typeof project>>

async function inside<T>(directory: string, run: () => Promise<T>) {
  const before = process.cwd()
  process.chdir(directory)
  try {
    return await run()
  } finally {
    process.chdir(before)
  }
}

// `answer` is what the server says about the organization's plugin lists, asked again on every read so a test can change it.
async function run(
  answer: (fixture: Fixture) => Response,
  check: (fixture: Fixture, setup: Awaited<ReturnType<typeof createAppFixture>>) => Promise<void>,
) {
  await using fixture = await project()
  await using state = await tmpdir()
  await inside(fixture.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url) => (url.pathname === "/api/config/effective" ? answer(fixture) : undefined),
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await setup.flush()
    await check(fixture, setup)
  })
}

const reply = (plugins: (fixture: Fixture) => unknown) => (fixture: Fixture) =>
  json({ compatibility: true, plugins: plugins(fixture) })

test("a plugin nothing restricts is imported and set up (control)", async () => {
  await run(
    reply(() => ({})),
    async (fixture, setup) => {
      await setup.waitFor(async () => (await fixture.marks()).includes("loaded"), { maxPasses: 200 })
      expect(await fixture.marks()).toEqual(["imported", "loaded"])
    },
  )
})

test("a blocked project plugin directory is never imported", async () => {
  await run(
    reply((fixture) => ({ block: [fixture.real, fixture.plugin] })),
    async (fixture) => expect(await fixture.marks()).toEqual([]),
  )
})

test("a plugin that is off the allow list, or under an empty one, is never imported", async () => {
  for (const allow of [[], ["@corp/other"]])
    await run(
      reply(() => ({ allow })),
      async (fixture) => expect(await fixture.marks()).toEqual([]),
    )
})

test("a plugin on the allow list is imported (control)", async () => {
  await run(
    reply((fixture) => ({ allow: [fixture.real] })),
    async (fixture, setup) => {
      await setup.waitFor(async () => (await fixture.marks()).includes("loaded"), { maxPasses: 200 })
      expect(await fixture.marks()).toEqual(["imported", "loaded"])
    },
  )
})

test("a plugin whose ID is blocked is imported but never set up", async () => {
  await run(
    reply(() => ({ block: ["project.*"] })),
    async (fixture, setup) => {
      await setup.waitFor(async () => (await fixture.marks()).includes("imported"), { maxPasses: 200 })
      await setup.flush()
      expect(await fixture.marks()).toEqual(["imported"])
    },
  )
})

test("a server that does not report the lists, or cannot be read, leaves no external plugin to load", async () => {
  await run(
    () => json({ compatibility: true }),
    async (fixture) => expect(await fixture.marks()).toEqual([]),
  )
  await run(
    () => new Response("gone", { status: 503 }),
    async (fixture) => expect(await fixture.marks()).toEqual([]),
  )
})

test("a block that arrives later takes a running plugin down", async () => {
  let blocked = false
  await run(
    reply(() => (blocked ? { block: ["project.hello"] } : {})),
    async (fixture, setup) => {
      await setup.waitFor(async () => (await fixture.marks()).includes("loaded"), { maxPasses: 200 })
      blocked = true
      setup.events.emit({ id: "evt_config", created: 1, type: "config.updated", data: {} })
      await setup.waitFor(async () => (await fixture.marks()).includes("unloaded"), { maxPasses: 200 })
      expect(await fixture.marks()).toEqual(["imported", "loaded", "unloaded"])
    },
  )
})
