import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// `script/test.ts` runs every worker process in the same root folder. Each process gets a home, XDG and temp folder of
// its own below it, so files that run side by side never write to the same config, data or temp path.
const root = process.env.ORBIT_TEST_ROOT
if (root) {
  const home = path.join(root, `worker-${process.pid}`)
  const temporary = path.join(home, "tmp")
  mkdirSync(temporary, { recursive: true })
  Object.assign(process.env, {
    HOME: home,
    ORBIT_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    ORBIT_CONFIG_DIR: path.join(home, ".config", "orbit"),
    TMPDIR: temporary,
    ...(process.platform === "win32" ? { USERPROFILE: home, TMP: temporary, TEMP: temporary } : {}),
  })
}

process.env.ORBIT_DB = ":memory:"
// A real /etc/orbit or %ProgramFiles%\Orbit must never reach a test: point the managed settings at a folder that does
// not exist. Tests that exercise them pass their own directory.
process.env.ORBIT_MANAGED_DIR = path.join(process.env.ORBIT_TEST_HOME ?? os.tmpdir(), "orbit-managed-missing")
process.env.NPM_CONFIG_AUDIT = "false"
// Tests write project config next to the code under test, so the default node graph trusts every folder. Trust
// behavior is covered where a test builds WorkspaceTrust with `implicit: false`.
process.env.ORBIT_TRUST_PROJECT = "1"
// A Git Bash terminal exports SHELL=/bin/bash.exe, which the shell tool honours, but the tests send PowerShell
// commands on win32. Clear it so the shell files give the same result from any terminal.
if (process.platform === "win32") delete process.env.SHELL
