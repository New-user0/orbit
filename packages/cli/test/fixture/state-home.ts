import { afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Test preload (bunfig.toml): gives this test process a state folder of its own before any test file loads.
// `@orbit/util/global` reads XDG_STATE_HOME once, when it is first imported, so setting it inside one test file is too
// late in a serial run, where an earlier file has already imported it. The folder is not the developer's real one,
// which other worktrees and the installed client share. Bun runs the preload once for a serial run and once per test
// file in a parallel run, and never fires a process `exit` event for a preload, so the folder is removed by an
// `afterAll` registered here, which runs at the end of the run (serial) or of each file (parallel).
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cli-state-"))
process.env.XDG_STATE_HOME = stateHome
afterAll(() => fs.promises.rm(stateHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
