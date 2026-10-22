import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { json } from "./fixture/tui-client"

// The status line command runs in the folder the terminal UI was started in, whose contents a clone chooses (a
// bunfig.toml preload, a git config). Nothing runs, and no line is drawn, until that folder is trusted.
const bun = process.execPath.replaceAll("\\", "/")

// "the command itself" writes the marker. In the bunfig row the command is harmless, but the program that runs it reads
// a preload from the start folder, so only a command that never starts leaves no marker.
const spellings = [
  {
    name: "the command itself",
    prepare: async (_clone: string, _marker: string) => {},
    script: (marker: string) => `await Bun.write(${JSON.stringify(marker)}, "x"); console.log("LINE-DRAWN")`,
  },
  {
    name: "a bunfig.toml preload in the start folder",
    prepare: async (clone: string, marker: string) => {
      await Bun.write(path.join(clone, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
      await Bun.write(path.join(clone, "evil.ts"), `await Bun.write(${JSON.stringify(marker)}, "x")\n`)
    },
    script: (_marker: string) => `console.log("LINE-DRAWN")`,
  },
]

test.each(spellings)("no status line runs in an untrusted start folder: $name", async (spelling) => {
  await using clone = await tmpdir()
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  await mkdir(path.join(clone.path, ".git"), { recursive: true })
  const marker = path.join(scripts.path, "marker.txt").replaceAll("\\", "/")
  const script = path.join(scripts.path, "line.ts").replaceAll("\\", "/")
  await Bun.write(script, spelling.script(marker))
  await spelling.prepare(clone.path, marker)
  let trusted = false
  const before = process.cwd()
  process.chdir(clone.path)
  try {
    await using setup = await createAppFixture({
      state: state.path,
      width: 120,
      config: { animations: false, status_line: { interval: 1_000, command: `${bun} ${script}` } },
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        return json({
          directory: process.cwd(),
          trusted,
          persistent: true,
          ...(trusted ? { source: "saved" } : {}),
          withheld: trusted ? [] : [{ path: path.join(process.cwd(), "orbit.json"), kinds: ["hooks"] }],
        })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => promptReady(frame))
    // Past the interval, and a trigger that would run the command if it were allowed to.
    await Bun.sleep(2_500)
    setup.events.emit({
      id: "evt_start",
      created: 1,
      type: "session.execution.started",
      data: { sessionID: "ses_any" },
    } as never)
    await Bun.sleep(1_000)
    await setup.renderOnce()
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(setup.captureCharFrame()).not.toContain("LINE-DRAWN")

    // The control: the same setup, once trusted, runs the command and draws its line.
    trusted = true
    setup.events.emit({ id: "evt_trust", created: 2, type: "trust.updated", data: {} } as never)
    await setup.waitForFrame((frame) => frame.includes("LINE-DRAWN"))
    expect(await Bun.file(marker).exists()).toBe(true)
  } finally {
    process.chdir(before)
  }
}, 40_000)

// A change of the prompt's vim mode asks the status line for a run, and the ask only helps if the gate says yes: in an
// untrusted start folder it starts nothing, and the same change in a trusted one does (the control).
// trust-first: the terminal UI asks about an untrusted start folder before anything can be typed, so no mode change
// reaches the prompt; while the question is open no status line command runs, and once the folder is trusted it does.
test("an untrusted start folder starts no status line command while its question is open", async () => {
  await using clone = await tmpdir()
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  await mkdir(path.join(clone.path, ".git"), { recursive: true })
  const marker = path.join(scripts.path, "marker.txt").replaceAll("\\", "/")
  const script = path.join(scripts.path, "line.ts").replaceAll("\\", "/")
  await Bun.write(
    script,
    `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(marker)}, "x")
const input = JSON.parse(await Bun.stdin.text())
console.log("MODE-" + input.vim_mode)
`,
  )
  let trusted = false
  const before = process.cwd()
  process.chdir(clone.path)
  try {
    await using setup = await createAppFixture({
      state: state.path,
      width: 120,
      config: { animations: false, prompt: { vim: true }, status_line: { interval: 60_000, command: `${bun} ${script}` } },
      fetch: (url, request) => {
        if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
        return json({
          directory: process.cwd(),
          trusted,
          persistent: true,
          ...(trusted ? { source: "saved" } : {}),
          withheld: trusted ? [] : [{ path: path.join(process.cwd(), "orbit.json"), kinds: ["hooks"] }],
        })
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Trust this folder?"))
    await Bun.sleep(2_000)
    await setup.renderOnce()
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(setup.captureCharFrame()).not.toContain("MODE-")

    // The control: once trusted, the same mode change runs the command and the line shows the new mode.
    trusted = true
    setup.events.emit({ id: "evt_trust", created: 2, type: "trust.updated", data: {} } as never)
    await setup.waitForFrame((frame) => !frame.includes("Trust this folder?") && frame.includes("MODE-insert"))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => frame.includes("MODE-normal"))
  } finally {
    process.chdir(before)
  }
}, 40_000)

// The command is also handed the folder of the session in view as `cwd` and `project_dir`, and a status line that shows
// repository state runs its VCS program there, which reads `core.fsmonitor` from the folder's own config (a bunfig.toml
// preload for bun). The start folder being trusted says nothing about that folder, so nothing runs until it is trusted
// too (class 3 and 1).
const handed = [
  {
    name: "core.fsmonitor in the repository config of the folder it is handed",
    prepare: async (clone: string, marker: string) => {
      Bun.spawnSync(["git", "init", "-q", clone])
      Bun.spawnSync(["git", "-C", clone, "config", "core.fsmonitor", `echo ran > "${marker}"; false`])
    },
    run: `Bun.spawnSync(["git", "-C", input.cwd, "status", "--short"])`,
  },
  {
    name: "a bunfig.toml preload in the folder it is handed",
    prepare: async (clone: string, marker: string) => {
      await Bun.write(path.join(clone, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
      await Bun.write(path.join(clone, "evil.ts"), `await Bun.write(${JSON.stringify(marker)}, "x")\n`)
    },
    run: `Bun.spawnSync([process.execPath, "-e", "0"], { cwd: input.cwd })`,
  },
]

test.each(handed)("no status line runs for a session in an untrusted folder: $name", async (spelling) => {
  await using state = await tmpdir()
  await using scripts = await tmpdir()
  await using clone = await tmpdir()
  const marker = path.join(scripts.path, "marker.txt").replaceAll("\\", "/")
  await spelling.prepare(clone.path, marker)
  const script = path.join(scripts.path, "line.ts")
  await Bun.write(
    script,
    [
      `const input = JSON.parse(await Bun.stdin.text())`,
      `await Bun.write(${JSON.stringify(path.join(scripts.path, "cwd.txt").replaceAll("\\", "/"))}, String(input.cwd))`,
      `if (input.cwd) ${spelling.run}`,
      `console.log("LINE-DRAWN")`,
    ].join("\n"),
  )
  const cloneDir = clone.path.replaceAll("\\", "/")
  const session = {
    id: `ses_${crypto.randomUUID()}`,
    projectID: "clone",
    title: "Clone session",
    agent: "build",
    model: { providerID: "demo", id: "first" },
    location: { directory: cloneDir },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  let trusted = false
  await using setup = await createAppFixture({
    state: state.path,
    width: 300,
    config: {
      animations: false,
      status_line: { interval: 1_000, command: `${bun} ${script.replaceAll("\\", "/")}` },
    },
    args: { sessionID: session.id },
    fetch: async (url) => {
      const forClone = url.searchParams.get("location[directory]") === cloneDir
      if (url.pathname === "/api/location/trust" && forClone)
        return json({
          directory: cloneDir,
          trusted,
          persistent: true,
          ...(trusted ? { source: "saved" } : {}),
          withheld: trusted ? [] : [{ path: path.join(cloneDir, "orbit.json"), kinds: ["hooks"] }],
        })
      if (url.pathname === "/api/location" && forClone)
        return json({ directory: cloneDir, project: { id: "clone", directory: cloneDir, canonical: cloneDir } })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  await Bun.sleep(3_500)
  await setup.renderOnce()
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(setup.captureCharFrame()).not.toContain("LINE-DRAWN")

  // The control: the same folder, once trusted, gets the command, so the marker above is not absent for another reason.
  trusted = true
  setup.events.emit({ id: "evt_trust", created: 2, type: "trust.updated", data: {} } as never)
  const started = Date.now()
  while (!setup.captureCharFrame().includes("LINE-DRAWN") && Date.now() - started < 15_000) {
    await Bun.sleep(250)
    await setup.renderOnce()
  }
  expect(setup.captureCharFrame()).toContain("LINE-DRAWN")
  expect(await Bun.file(path.join(scripts.path, "cwd.txt")).text()).toBe(cloneDir)
  expect(await Bun.file(marker).exists()).toBe(true)
}, 60_000)
