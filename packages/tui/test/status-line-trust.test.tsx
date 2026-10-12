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
