import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Test preload (bunfig.toml): gives this test process a state folder of its own before any test file loads.
// `@orbit/util/global` reads XDG_STATE_HOME once, when it is first imported, so setting it inside one test file is too
// late in a serial run, where an earlier file has already imported it. The folder is not the developer's real one,
// which other worktrees and the installed client share. It runs once per process: the serial run and each parallel
// worker get their own folder, and each removes it on exit.
const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cli-state-"))
process.env.XDG_STATE_HOME = stateHome
process.on("exit", () => fs.rmSync(stateHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
