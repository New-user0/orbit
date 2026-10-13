import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Gives this test process a state folder of its own. `@orbit/util/global` reads XDG_STATE_HOME once, when it is first
// imported, so a test file imports this module before anything that imports it, and the folder is not the developer's
// real one, which other worktrees and the installed client share.
export const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-cli-state-"))
process.env.XDG_STATE_HOME = stateHome
