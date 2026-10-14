import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Global } from "@orbit/util/global"

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
