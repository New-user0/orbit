import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Global } from "@orbit/util/global"
import { NpmConfig } from "@orbit/util/npm-config"
import { Effect } from "effect"

// Bun reads HOME once at startup on Linux and macOS, so a worker that sets HOME afterwards still sees the shared root
// from os.homedir(); on Windows os.homedir() follows USERPROFILE as it changes. Either way it is never the real home.
const osHomedir = (home: string, root: string | undefined) => (process.platform === "win32" ? home : (root ?? home))

describe("Core test environment", () => {
  test("disables public npm security audits", () => {
    expect(process.env.NPM_CONFIG_AUDIT).toBe("false")
  })

  test("trusts project folders in the default node graph", () => {
    // Trust tests build WorkspaceTrust with `implicit: false` instead.
    expect(process.env.ORBIT_TRUST_PROJECT).toBe("1")
  })

  test("gives each worker process a home of its own below the shared root", () => {
    // Without this, files that run side by side write to one config, data and temp folder.
    const root = process.env.ORBIT_TEST_ROOT
    expect(root).toBeDefined()
    if (!root) return
    expect(process.env.ORBIT_TEST_HOME).toBe(path.join(root, `worker-${process.pid}`))
    expect(os.homedir()).toBe(osHomedir(process.env.ORBIT_TEST_HOME!, root))
    expect(os.tmpdir().startsWith(process.env.ORBIT_TEST_HOME!)).toBe(true)
  })

  // npm keeps its cache in %LOCALAPPDATA%\npm-cache on Windows and in ~/.npm elsewhere, and Npm.add reads npm's own
  // config. Neither was a worker's: CI's Git installs cloned into the runner's C:\Users\runneradmin\AppData\Local\npm-cache
  // (run 45898058796), which every worker and job on the machine shares, and on Linux HOME stays the shared root.
  test("gives each worker an npm cache of its own", async () => {
    const home = process.env.ORBIT_TEST_HOME
    expect(home).toBeDefined()
    if (!home) return
    // Inside the worker's home: a relative path that does not climb out of it (another drive gives an absolute one).
    const within = (folder: unknown) => {
      if (typeof folder !== "string" || folder === "") return `not a folder: ${String(folder)}`
      const relative = path.relative(home, folder)
      return relative.startsWith("..") || path.isAbsolute(relative) ? `outside ${home}: ${folder}` : "inside"
    }
    const config = await Effect.runPromise(NpmConfig.load(home))
    expect(within(config.cache)).toBe("inside")
    if (process.platform === "win32") {
      expect(within(process.env.LOCALAPPDATA)).toBe("inside")
      expect(within(process.env.APPDATA)).toBe("inside")
    }
  })

  test("isolates global home and XDG roots", () => {
    const home = process.env.ORBIT_TEST_HOME
    expect(home).toBeDefined()
    if (!home) return

    expect(os.homedir()).toBe(osHomedir(home, process.env.ORBIT_TEST_ROOT))
    expect(Global.Path.home).toBe(home)
    expect(Global.Path.config).toBe(path.join(home, ".config", "orbit"))
    expect(Global.Path.data).toBe(path.join(home, ".local", "share", "orbit"))
    expect(Global.Path.cache).toBe(path.join(home, ".cache", "orbit"))
    expect(Global.Path.state).toBe(path.join(home, ".local", "state", "orbit"))
    expect(os.tmpdir()).toBe(path.join(home, "tmp"))
    expect(process.env.ORBIT_CONFIG_DIR).toBe(Global.Path.config)
    expect(process.env.ORBIT_CONFIG).toBeUndefined()
    expect(process.env.ORBIT_CONFIG_CONTENT).toBeUndefined()
    expect(process.env.AWS_REGION).toBeUndefined()
    expect(process.env.GOOGLE_VERTEX_PROJECT).toBeUndefined()
    expect(process.env.NPM_CONFIG_REGISTRY).toBeUndefined()
    expect(process.env.UIDOTSH_AUTHORIZATION).toBeUndefined()
    if (process.env.RECORD !== "true") expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })
})
