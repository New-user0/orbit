import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { withCurrentDirectoryOnPath } from "../../core/test/fixture/decoy"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

const variable = "ZZ_MANAGED_BOOT_ENV"

// The managed `env` reaches this process once at boot, only when the host asks for it. A managed file that names the
// variable which keeps Windows out of the working folder cannot change it.
const start = (directory: string, applyEnv: boolean | undefined) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(directory, "managed-settings.json"),
        JSON.stringify({ env: { [variable]: "from-managed", NoDefaultCurrentDirectoryInExePath: "" } }),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env[variable]))
    yield* ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      managed: { directory, applyEnv },
    })
  })

it.live("puts the managed env into the server's own environment when the host asks for it", () =>
  withCurrentDirectoryOnPath(
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      delete process.env[variable]

      yield* start(directory, true)

      expect(process.env[variable]).toBe("from-managed")
      expect(process.env.NoDefaultCurrentDirectoryInExePath).toBe(process.platform === "win32" ? "1" : undefined)
    }),
  ),
)

for (const applyEnv of [false, undefined]) {
  it.live(`leaves the environment alone when applyEnv is ${applyEnv}`, () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      delete process.env[variable]

      yield* start(directory, applyEnv)

      expect(process.env[variable]).toBeUndefined()
    }),
  )
}
