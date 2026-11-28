import { mkdirSync, mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// `script/test.ts` runs every worker process in the same root folder. Each process gets a home, XDG and temp folder of
// its own below it, so files that run side by side never write to the same config, data or temp path.
const root = process.env.ORBIT_TEST_ROOT
if (root) {
  const home = path.join(root, `worker-${process.pid}`)
  const temporary = path.join(home, "tmp")
  mkdirSync(temporary, { recursive: true })
  // A parallel worker runs this preload again for each file. Each file gets a config folder of its own: a runtime with
  // the default Global watches it, and a file's native watches outlive the file (test/fixture/native-watcher.ts), so a
  // later file that wrote to the same folder would wake a watch whose callback belongs to a file that has ended.
  const config = mkdtempSync(path.join(home, "config-"))
  // Bun reads HOME once at startup on Linux and macOS, so os.homedir() keeps naming the shared root there; HOME stays the
  // root as well, so a child shell's `~` agrees with it. Everything the tests derive from ORBIT_TEST_HOME, XDG and TMPDIR
  // is per worker. On Windows os.homedir() follows USERPROFILE, so all of them move.
  Object.assign(process.env, {
    ...(process.platform === "win32" ? { HOME: home } : {}),
    ORBIT_TEST_HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    ORBIT_CONFIG_DIR: path.join(config, "orbit"),
    TMPDIR: temporary,
    // npm keeps its cache in %LOCALAPPDATA%\npm-cache on Windows and in the start-up home's ~/.npm elsewhere, which
    // every worker and every job on the runner then share: CI's Git installs cloned into the runner's own cache. The
    // cache and the per-user folders that Windows programs write to are the worker's own.
    npm_config_cache: path.join(home, ".npm"),
    // Bun keeps its transpiler cache under XDG_CACHE_HOME, which is the worker's own, so the first `bun` child of each
    // worker transpiled what it imports from nothing: a shell-parser child that takes 0.4 s ran past 5 s on a loaded
    // Windows runner (run 45924043976, attempt 2). Every child shares the run's one cache (tools/test/watchdog.ts).
    ...(process.env.ORBIT_TEST_TRANSPILER_CACHE
      ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.ORBIT_TEST_TRANSPILER_CACHE }
      : {}),
    ...(process.platform === "win32"
      ? {
          USERPROFILE: home,
          TMP: temporary,
          TEMP: temporary,
          LOCALAPPDATA: path.join(home, "AppData", "Local"),
          APPDATA: path.join(home, "AppData", "Roaming"),
        }
      : {}),
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
