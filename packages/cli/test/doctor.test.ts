import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sandboxCheck, sandboxState, type SandboxProbe, type SandboxState } from "../src/util/doctor-sandbox"
import { isolatedEnv } from "./fixture/environment"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-doctor-"))
afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const wsl1 = "Shell sandboxing is enabled but WSL1 cannot sandbox commands. Upgrade the distribution to WSL2 or turn it off"
const probes: Record<string, SandboxProbe> = {
  wrapped: { type: "wrapped", command: "/usr/bin/bwrap" },
  missing: { type: "missing", tool: "bwrap" },
  wsl1: { type: "unsupported", reason: wsl1 },
  win32: { type: "unwrapped" },
  freebsd: { type: "unwrapped" },
}
const states: SandboxState[] = ["on", "off", "unknown"]

describe("the sandbox line", () => {
  // Marker per cell: ok, "!!" or blank. A red line is for someone who turned the sandbox on, and nobody else.
  const expected = {
    wrapped: { on: "ok", off: " ", unknown: " " },
    missing: { on: "!!", off: " ", unknown: " " },
    wsl1: { on: "!!", off: " ", unknown: " " },
    win32: { on: "!!", off: " ", unknown: " " },
    freebsd: { on: "!!", off: " ", unknown: " " },
  } as const
  for (const [name, probe] of Object.entries(probes))
    for (const state of states)
      test(`${name} with the sandbox ${state}`, () => {
        const check = sandboxCheck(probe, state)
        const marker = check.ok === undefined ? " " : check.ok ? "ok" : "!!"
        expect(marker).toBe(expected[name as keyof typeof expected][state])
        if (probe.type === "wrapped") expect(check.detail).toContain("/usr/bin/bwrap")
        if (probe.type === "missing") expect(check.detail).toContain("bwrap")
        if (name === "wsl1") expect(check.detail).toContain("WSL2")
        if (state === "on") expect(check.detail).toContain("managed settings")
      })

  test("a managed sandbox object decides, and no managed object leaves it unknown", () => {
    expect(sandboxState(undefined)).toBe("unknown")
    expect(sandboxState({})).toBe("off")
    expect(sandboxState({ enabled: false })).toBe("off")
    expect(sandboxState({ enabled: true })).toBe("on")
  })
})

async function doctor(managed: Record<string, unknown> | string, env: Record<string, string | undefined> = {}) {
  const dir = typeof managed === "string" ? managed : path.join(root, `m-${crypto.randomUUID()}`)
  if (typeof managed !== "string") {
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "managed-settings.json"), JSON.stringify(managed))
  }
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), "doctor"], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { ORBIT_MANAGED_DIR: dir, ...env }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { stdout, exitCode }
}

describe("orb doctor on this host", () => {
  test.skipIf(process.platform !== "win32")("windows: red only when managed settings turn the sandbox on", async () => {
    const on = await doctor({ sandbox: { enabled: true } })
    expect(on.stdout).toMatch(/!! sandbox\s+on in managed settings; this platform has no OS sandbox/)
    expect(on.exitCode).toBe(1)
    const unknown = await doctor({})
    expect(unknown.stdout).toMatch(/\n {3}sandbox\s+no OS sandbox on this platform/)
    expect(unknown.stdout).not.toContain("!! sandbox")
  })

  test.skipIf(process.platform !== "linux")("linux: a missing bwrap is red only with the sandbox on", async () => {
    const empty = path.join(root, "empty-path")
    await fs.mkdir(empty, { recursive: true })
    const on = await doctor({ sandbox: { enabled: true } }, { PATH: empty })
    expect(on.stdout).toMatch(/!! sandbox\s+on in managed settings; bwrap is not on PATH/)
    expect(on.exitCode).toBe(1)
    const off = await doctor({ sandbox: {} }, { PATH: empty })
    expect(off.stdout).not.toContain("!! sandbox")
    expect(off.stdout).toMatch(/ sandbox\s+off in managed settings/)
  })

  test.skipIf(process.platform !== "linux")("linux: finds bwrap as the runner does, not from a relative PATH entry", async () => {
    const project = path.join(root, "decoy-project")
    const bin = path.join(project, "node_modules", ".bin")
    const absolute = path.join(root, "real-bin")
    const empty = path.join(root, "empty-path-2")
    await Promise.all([bin, absolute, empty].map((dir) => fs.mkdir(dir, { recursive: true })))
    for (const dir of [bin, absolute]) {
      await Bun.write(path.join(dir, "bwrap"), "#!/bin/sh\nexit 0\n")
      await fs.chmod(path.join(dir, "bwrap"), 0o755)
    }
    const managed = { sandbox: { enabled: true } }
    const relative = await doctor(managed, { PATH: `${path.relative(path.join(import.meta.dir, ".."), bin)}:${empty}` })
    expect(relative.stdout).toMatch(/!! sandbox\s+on in managed settings; bwrap is not on PATH/)
    const control = await doctor(managed, { PATH: `${absolute}:${empty}` })
    expect(control.stdout).toContain(path.join(absolute, "bwrap"))
    expect(control.stdout).not.toContain("!! sandbox")
  })
})

describe("orb doctor escapes at the sink", () => {
  const marker = "\u001b]0;x\u0007\u001b[2K\r"
  test("a managed folder name with control characters", async () => {
    const result = await doctor(path.join(root, `m${marker}`))
    expect(result.stdout).toContain("no managed settings in")
    expect(result.stdout).not.toContain("\u001b")
    expect(result.stdout).not.toContain("\u0007")
    expect(result.stdout.replaceAll("\r\n", "\n")).not.toContain("\r")
    expect(result.stdout).toContain("\\x1b")
  })

  test.skipIf(process.platform === "win32")("a PATH folder name with control characters", async () => {
    const dir = path.join(root, `bin${marker}`)
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "rg"), "#!/bin/sh\nexit 0\n")
    await fs.chmod(path.join(dir, "rg"), 0o755)
    const result = await doctor({}, { PATH: `${dir}:${process.env.PATH}` })
    expect(result.stdout).not.toContain("\u001b")
    expect(result.stdout).not.toContain("\u0007")
    expect(result.stdout.replaceAll("\r\n", "\n")).not.toContain("\r")
    expect(result.stdout).toContain("\\x1b")
  })
})

describe("orb doctor prints checks through the escaping sink", () => {
  const marker = "\u001b]0;x\u0007\u001b[2K\r"
  // A label (a model ID the user typed) and a detail (a probe reply or provider error) are both untrusted text.
  const cases = [
    { name: "label", check: { ok: true, label: `ollama/m${marker}`, detail: "ok" } },
    { name: "detail", check: { ok: false, label: "ollama/m", detail: `${marker}failed` } },
    { name: "both", check: { ok: undefined, label: `a${marker}`, detail: `b${marker}` } },
  ]
  for (const row of cases)
    test(row.name, async () => {
      const { lines } = await import("../src/commands/handlers/doctor")
      const text = lines([row.check])
      expect(text).not.toContain("\u001b")
      expect(text).not.toContain("\u0007")
      expect(text.replaceAll(os.EOL, "\n")).not.toContain("\r")
      expect(text).toContain("\\x1b")
    })
})