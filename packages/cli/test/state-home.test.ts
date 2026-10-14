import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

// Pins the preload in test/fixture/state-home.ts: the temporary state folder is gone once a run ends.
const probe = path.join(import.meta.dir, "fixture", "state-home-probe.test.ts")

test.each([
  ["serial", []],
  ["parallel", ["--parallel=2"]],
])(
  "the %s run leaves no temporary state folder",
  async (_, flags) => {
    const child = Bun.spawn([process.execPath, "test", ...flags, probe], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, ORBIT_STATE_HOME_PROBE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text())
    expect(await child.exited).toBe(0)
    const folder = out.match(/STATE_HOME=(.+)/)?.[1]?.trim()
    expect(folder).toBeTruthy()
    expect(fs.existsSync(folder!)).toBe(false)
  },
  60_000,
)
