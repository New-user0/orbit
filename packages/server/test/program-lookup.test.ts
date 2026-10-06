import { expect } from "bun:test"
import { Effect } from "effect"
import { withCurrentDirectoryOnPath } from "../../core/test/fixture/decoy"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

// A server process is an entry of its own: whoever starts it without the CLI runs the programs that it starts by name in
// the folders it is pointed at, which can be clones that are not trusted yet. Windows looks in that folder before PATH,
// unless NoDefaultCurrentDirectoryInExePath is in the environment of the process.
it.live("starting the server keeps the working folder out of how Windows finds a program", () =>
  withCurrentDirectoryOnPath(
    Effect.gen(function* () {
      yield* ServerProcess.start<never, never>({
        hostname: "127.0.0.1",
        port: 0,
        password: "secret",
        app: { version: "test-version" },
        database: { path: ":memory:" },
      })

      expect(process.env.NoDefaultCurrentDirectoryInExePath).toBe(process.platform === "win32" ? "1" : undefined)
    }),
  ),
)
