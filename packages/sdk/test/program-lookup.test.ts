import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { currentDirectoryOnPath } from "../../core/test/fixture/decoy"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Orbit } from "../src"

// The embedded host runs in the process of whoever embeds it and starts programs by their names in the folders it is
// pointed at, which can be clones that are not trusted yet. Windows looks in that folder before PATH, unless
// NoDefaultCurrentDirectoryInExePath is in the environment of the process, so creating the host has to put it there.
test("creating an embedded host keeps the working folder out of how Windows finds a program", async () => {
  await using directory = await tmpdir("orbit-program-lookup-")
  const config = join(directory.path, "config")
  await mkdir(config)
  using _ = currentDirectoryOnPath()

  await using orbit = await Orbit.create({ config: { directory: config, project: false, content: "{}" } })

  expect(orbit).toBeDefined()
  expect(process.env.NoDefaultCurrentDirectoryInExePath).toBe(process.platform === "win32" ? "1" : undefined)
})
