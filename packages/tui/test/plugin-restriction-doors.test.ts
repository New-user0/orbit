import { expect, test } from "bun:test"
import { mkdir, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"
import type { Config } from "../src/config"

// The other doors a plugin reaches the TUI by: a package named in cli.json, one the server lists for the TUI, and a
// folder reached through a link. Each is checked in this process, before the package is prepared or the folder read.

async function inside<T>(directory: string, run: () => Promise<T>) {
  const before = process.cwd()
  process.chdir(directory)
  try {
    return await run()
  } finally {
    process.chdir(before)
  }
}

async function run(input: {
  plugins: { allow?: string[]; block?: string[]; organization?: string }
  config?: Config.Info
  server?: unknown[]
  root?: string
  check: (setup: Awaited<ReturnType<typeof createAppFixture>>, prepared: string[]) => Promise<void>
}) {
  await using project = await tmpdir()
  await using state = await tmpdir()
  const prepared: string[] = []
  await mkdir(path.join(project.path, ".git"), { recursive: true })
  await inside(input.root ?? project.path, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      config: { animations: false, ...input.config },
      packages: {
        prepare: async (spec) => {
          prepared.push(spec)
          return { directory: path.join(project.path, "nowhere") }
        },
      },
      fetch: (url) => {
        if (url.pathname === "/api/config/effective") return json({ compatibility: true, plugins: input.plugins })
        if (url.pathname === "/api/plugin" && input.server)
          return json({
            location: { directory: project.path, project: { id: "proj_test", directory: project.path, canonical: project.path } },
            data: input.server,
          })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await setup.flush()
    await input.check(setup, prepared)
  })
}

const serverPlugin = (target: string) => ({
  id: `server.${target}`,
  source: { type: "package", target },
  state: { status: "active" },
  features: { server: true, tui: true },
})

test("a package named in cli.json is checked by its name, and is never prepared when blocked", async () => {
  await run({
    plugins: { block: ["@corp/blocked"] },
    config: { plugins: ["@corp/blocked@^1", "@corp/fine@^1"] },
    check: async (setup, prepared) => {
      // The control: the allowed package is prepared, so the blocked one had the same chance.
      await setup.waitFor(async () => prepared.includes("@corp/fine@^1"), { maxPasses: 200 })
      expect([...new Set(prepared)]).toEqual(["@corp/fine@^1"])
    },
  })
})

test("a package the server lists for the TUI is held to the same lists", async () => {
  await run({
    plugins: { allow: ["@corp/fine"], block: ["@corp/blocked"] },
    server: [serverPlugin("@corp/blocked@^1"), serverPlugin("@corp/fine@^1"), serverPlugin("@corp/other@^1")],
    check: async (setup, prepared) => {
      await setup.waitFor(async () => prepared.includes("@corp/fine@^1"), { maxPasses: 200 })
      await setup.flush()
      expect([...new Set(prepared)]).toEqual(["@corp/fine@^1"])
    },
  })
})

test("a selector written through a link meets the real folder, in both directions", async () => {
  for (const [name, spell] of [
    ["a link selector, blocked", (_real: string, link: string) => ({ block: [link] })],
    ["a real selector, blocked", (real: string) => ({ block: [real] })],
  ] as const) {
    await using fixture = await tmpdir()
    const plugin = path.join(fixture.path, ".orbit", "plugins", "hello")
    const marks = path.join(fixture.path, "marks.txt")
    await mkdir(path.join(fixture.path, ".git"), { recursive: true })
    await mkdir(plugin, { recursive: true })
    await Bun.write(
      path.join(plugin, "tui.ts"),
      `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(marks)}, "imported\\n")\nexport default { id: "project.hello", setup() {} }\n`,
    )
    const link = path.join(fixture.path, "link")
    await symlink(plugin, link, "junction")
    const real = await realpath(plugin)
    await run({
      plugins: spell(real, link),
      root: fixture.path,
      check: async () => expect(await Bun.file(marks).exists(), name).toBe(false),
    })
  }
})

test("an allow list written through a link admits the real folder (control)", async () => {
  await using fixture = await tmpdir()
  const plugin = path.join(fixture.path, ".orbit", "plugins", "hello")
  const marks = path.join(fixture.path, "marks.txt")
  await mkdir(path.join(fixture.path, ".git"), { recursive: true })
  await mkdir(plugin, { recursive: true })
  await Bun.write(
    path.join(plugin, "tui.ts"),
    `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(marks)}, "imported\\n")\nexport default { id: "project.hello", setup() {} }\n`,
  )
  const link = path.join(fixture.path, "link")
  await symlink(plugin, link, "junction")
  await run({
    plugins: { allow: [link] },
    root: fixture.path,
    check: async (setup) => {
      await setup.waitFor(async () => await Bun.file(marks).exists(), { maxPasses: 200 })
      expect(await Bun.file(marks).exists()).toBe(true)
    },
  })
})
