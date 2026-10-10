import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-doctor-managed-"))

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

async function doctor(managed: string) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), "doctor"], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { ORBIT_MANAGED_DIR: managed }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { stdout, exitCode }
}

describe("orb doctor managed settings", () => {
  test("says so when there are no managed settings", async () => {
    const managed = path.join(root, "none")
    const result = await doctor(managed)
    expect(result.stdout).toContain(`no managed settings in ${managed}`)
    await expect(fs.stat(managed)).rejects.toThrow()
  })

  test("lists the files by name and each problem, and never a value", async () => {
    const managed = path.join(root, "present")
    await fs.mkdir(path.join(managed, "managed-settings.d"), { recursive: true })
    await Bun.write(
      path.join(managed, "managed-settings.json"),
      JSON.stringify({ managed: { organization: "Secret Org Value", mcp: { deny: [5] } } }),
    )
    await Bun.write(path.join(managed, "managed-settings.d", "10-broken.json"), '{ "managed": ')

    const result = await doctor(managed)

    expect(result.stdout).toContain("managed-settings.json")
    expect(result.stdout).toContain(path.join("managed-settings.d", "10-broken.json"))
    expect(result.stdout).toContain("$.managed.mcp.deny.0")
    expect(result.stdout).not.toContain("Secret Org Value")
    expect(result.exitCode).toBe(1)
  })

  test("writes control characters from a file out instead of sending them to the terminal", async () => {
    const managed = path.join(root, "control")
    await fs.mkdir(managed, { recursive: true })
    await Bun.write(path.join(managed, "managed-settings.json"), JSON.stringify({ agents: { "bad\u001b[2Jname": 5 } }))

    const result = await doctor(managed)

    expect(result.stdout).toContain("managed-settings.json")
    expect(result.stdout).toContain("bad")
    expect(result.stdout).not.toContain("\u001b[2J")
  })
})
