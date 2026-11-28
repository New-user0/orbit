import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runOrb } from "./fixture/orb"

describe("debug paths command", () => {
  test("is included in troubleshooting help", async () => {
    const [debug, paths] = await Promise.all([runOrb(["debug", "--help"]), runOrb(["debug", "paths", "--help"])])

    expect(debug.exitCode).toBe(0)
    expect(debug.stdout).toContain("paths")
    expect(debug.stdout).toContain("Show global paths (data, config, cache, state)")
    expect(paths.exitCode).toBe(0)
    expect(paths.stdout).toContain("orb debug paths [flags]")
  })

  test("prints resolved global paths without starting a server", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-debug-paths-"))

    try {
      // The child's home is `root`, as its isolated environment names it (fixture/orb.ts). The config folder comes from
      // XDG_CONFIG_HOME only without the ORBIT_CONFIG_DIR that environment sets.
      const result = await runOrb(["debug", "paths"], {
        home: root,
        env: {
          ORBIT_CONFIG_DIR: undefined,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
        },
      })
      const paths = Object.fromEntries(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/, 2)),
      )

      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(paths).toMatchObject({
        home: root,
        data: path.join(root, "data", "orbit"),
        config: path.join(root, "config", "orbit"),
        cache: path.join(root, "cache", "orbit"),
        state: path.join(root, "state", "orbit"),
        bin: path.join(root, "cache", "orbit", "bin"),
        log: path.join(root, "data", "orbit", "log"),
        repos: path.join(root, "data", "orbit", "repos"),
      })
      expect(paths.tmp).toBeTruthy()
      expect(await Bun.file(path.join(root, "state", "orbit", "service-local.json")).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("debug paths managed", () => {
  test("lists the managed settings folder, honours ORBIT_MANAGED_DIR and never creates it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-debug-managed-"))
    try {
      const managed = path.join(root, "managed")
      const listed = await runOrb(["debug", "paths"], { env: { ORBIT_MANAGED_DIR: managed } })
      const paths = Object.fromEntries(
        listed.stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/, 2)),
      )
      expect({ exitCode: listed.exitCode, managed: paths.managed }).toEqual({ exitCode: 0, managed })

      const only = await runOrb(["debug", "paths", "managed"], { env: { ORBIT_MANAGED_DIR: managed } })
      expect(only.stdout.trim()).toBe(managed)
      await expect(fs.stat(managed)).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("falls back to the per-OS default without the override", async () => {
    const only = await runOrb(["debug", "paths", "managed"], { env: { ORBIT_MANAGED_DIR: "" } })
    const expected =
      process.platform === "win32"
        ? path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "Orbit")
        : process.platform === "darwin"
          ? "/Library/Application Support/Orbit"
          : "/etc/orbit"
    expect(only.stdout.trim()).toBe(expected)
  })
})
