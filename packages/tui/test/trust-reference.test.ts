import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { allThemes, setCustomThemes } from "../src/theme"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"

// trust-first part 2: the owner's two "match refrence" decisions of 2026-10-21, in the terminal UI, drawn against a
// scripted server.
// - D8: a folder that is trusted is never asked about again, and whatever it holds loads as it is now. An answer that
//   still lists changes since the grant, as a server older than this change sends, asks nothing and holds nothing back.
// - D7: the terminal UI reads nothing from a folder above the project, and what the project's own folders supply waits
//   for the folder to be trusted, as everything else a folder supplies does: the themes in `.orbit/themes` included.
const changedTitle = "Trust the changes?"

// The answer of a server older than this change for a trusted folder whose config changed since the grant.
const changedSince = (directory: string) => ({
  directory,
  trusted: true,
  persistent: true,
  source: "saved",
  withheld: [
    { path: path.join(directory, "orbit.json"), kinds: ["hooks"] },
    { path: path.join(directory, ".orbit"), kinds: ["plugins"] },
  ],
  changed: [
    { path: path.join(directory, "orbit.json"), kinds: ["hooks"] },
    { path: path.join(directory, ".orbit"), kinds: ["plugins"] },
  ],
})

const status = (directory: string, trusted: boolean) => ({
  directory,
  trusted,
  persistent: true,
  ...(trusted ? { source: "saved" } : {}),
  withheld: [],
})

// A folder above a repository, and the repository, each with a theme in `.orbit/themes` and the repository with a plugin
// whose setup leaves a trace the test can read.
async function layout() {
  const root = await tmpdir()
  const above = root.path
  const repo = path.join(above, "repo")
  const marks = path.join(above, "marks.txt")
  const plugin = path.join(repo, ".orbit", "plugins", "hello")
  await mkdir(path.join(repo, ".git"), { recursive: true })
  await mkdir(plugin, { recursive: true })
  await Bun.write(path.join(above, ".orbit", "themes", "clone-above-theme.json"), JSON.stringify({ base: "orbit" }))
  await Bun.write(path.join(repo, ".orbit", "themes", "clone-own-theme.json"), JSON.stringify({ base: "orbit" }))
  await Bun.write(
    path.join(plugin, "tui.ts"),
    [
      'import { appendFileSync } from "node:fs"',
      "export default {",
      '  id: "project.hello",',
      "  setup() {",
      `    appendFileSync(${JSON.stringify(marks)}, "loaded\\n")`,
      "  },",
      "}",
      "",
    ].join("\n"),
  )
  return {
    above,
    repo,
    marks: async () => ((await Bun.file(marks).exists()) ? (await Bun.file(marks).text()).trim().split("\n") : []),
    [Symbol.asyncDispose]: () => root[Symbol.asyncDispose](),
  }
}

// The terminal UI finds its project, its plugins and its themes from the folder it was started in.
async function inside<T>(directory: string, run: () => Promise<T>) {
  const before = process.cwd()
  process.chdir(directory)
  try {
    return await run()
  } finally {
    process.chdir(before)
  }
}

const trustRoute = (answer: (folder: string) => unknown) => (url: URL, request: Request) => {
  if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
  return json(answer(url.searchParams.get("location[directory]") ?? ""))
}

test("a trusted folder is not asked about again, even when an older server lists changes since the grant", async () => {
  await using folders = await layout()
  await using state = await tmpdir()
  await inside(folders.repo, async () => {
    await using setup = await createAppFixture({ state: state.path, fetch: trustRoute(() => changedSince(folders.repo)) })
    await setup.waitForFrame((frame) => promptReady(frame))
    // The question opens within a moment of the first answer when it opens at all.
    await Bun.sleep(1_000)
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain(changedTitle)
    expect(frame).not.toContain("Trust this folder?")
    expect(promptReady(frame)).toBe(true)
  })
}, 30_000)

test("a trusted project's own plugins load, even when an older server lists them as changed since the grant", async () => {
  await using folders = await layout()
  await using state = await tmpdir()
  await inside(folders.repo, async () => {
    await using setup = await createAppFixture({ state: state.path, fetch: trustRoute(() => changedSince(folders.repo)) })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await setup.waitFor(async () => (await folders.marks()).length > 0, { maxPasses: 200 }).catch(() => undefined)
    expect(await folders.marks()).toEqual(["loaded"])
  })
}, 30_000)

// The themes the terminal UI finds are kept in the theme module, which every app of this file shares, so each theme row
// starts with none.
test("the start folder's themes wait for it to be trusted, and a folder above the project supplies none", async () => {
  setCustomThemes({})
  await using folders = await layout()
  await using state = await tmpdir()
  await inside(folders.repo, async () => {
    await using setup = await createAppFixture({ state: state.path, fetch: trustRoute((folder) => status(folder, false)) })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Trust this folder?"))
    await Bun.sleep(500)
    const names = Object.keys(allThemes())
    expect(names).not.toContain("clone-own-theme")
    expect(names).not.toContain("clone-above-theme")
  })
}, 30_000)

// Class 7: a trust read that fails says nothing about the folder, so the project's themes stay out, as its plugins do.
test("the start folder's themes stay out when its trust cannot be read", async () => {
  setCustomThemes({})
  await using folders = await layout()
  await using state = await tmpdir()
  await inside(folders.repo, async () => {
    await using setup = await createAppFixture({
      state: state.path,
      fetch: (url) => (url.pathname === "/api/location/trust" ? new Response("unavailable", { status: 503 }) : undefined),
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Trust this folder?"))
    await Bun.sleep(500)
    const names = Object.keys(allThemes())
    expect(names).not.toContain("clone-own-theme")
    expect(names).not.toContain("clone-above-theme")
  })
}, 30_000)

test("a trusted start folder's own themes load, and a folder above the project still supplies none", async () => {
  setCustomThemes({})
  await using folders = await layout()
  await using state = await tmpdir()
  await inside(folders.repo, async () => {
    await using setup = await createAppFixture({ state: state.path, fetch: trustRoute((folder) => status(folder, true)) })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    await setup
      .waitFor(() => Object.keys(allThemes()).includes("clone-own-theme"), { maxPasses: 200 })
      .catch(() => undefined)
    const names = Object.keys(allThemes())
    // The control: the project's own theme is read once the folder is trusted.
    expect(names).toContain("clone-own-theme")
    expect(names).not.toContain("clone-above-theme")
  })
}, 30_000)
