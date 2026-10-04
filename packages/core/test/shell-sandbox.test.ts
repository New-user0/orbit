import { describe, expect, test } from "bun:test"
import { ShellSandbox } from "@orbit/core/shell/sandbox"
import { which } from "@orbit/core/util/which"

const base = {
  shell: "/bin/sh",
  args: ["-c", "echo hi"],
  cwd: "/repo/pkg",
  writable: ["/repo", "/repo/pkg", "/tmp"],
}

describe("ShellSandbox.wrap", () => {
  test("leaves commands alone unless sandboxing is enabled, and on Windows", () => {
    expect(ShellSandbox.wrap({ ...base, platform: "linux", settings: {}, tool: "/usr/bin/bwrap" })).toEqual({
      type: "unwrapped",
    })
    expect(ShellSandbox.wrap({ ...base, platform: "win32", settings: { enabled: true } })).toEqual({
      type: "unwrapped",
    })
  })

  test("reports a missing sandbox tool instead of running unsandboxed", () => {
    expect(ShellSandbox.wrap({ ...base, platform: "linux", settings: { enabled: true } })).toEqual({
      type: "missing",
      tool: "bwrap",
    })
  })

  test("binds the writable directories with bubblewrap and cuts the network by default", () => {
    const result = ShellSandbox.wrap({
      ...base,
      platform: "linux",
      settings: { enabled: true, write: ["/cache"] },
      tool: "/usr/bin/bwrap",
    })
    expect(result).toEqual({
      type: "wrapped",
      command: "/usr/bin/bwrap",
      args: [
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--bind",
        "/repo",
        "/repo",
        "--bind",
        "/repo/pkg",
        "/repo/pkg",
        "--bind",
        "/tmp",
        "/tmp",
        "--bind",
        "/cache",
        "/cache",
        "--unshare-net",
        "--die-with-parent",
        "--chdir",
        "/repo/pkg",
        "--",
        "/bin/sh",
        "-c",
        "echo hi",
      ],
    })
    const online = ShellSandbox.wrap({
      ...base,
      platform: "linux",
      settings: { enabled: true, network: true },
      tool: "bwrap",
    })
    expect(online.type === "wrapped" && online.args.includes("--unshare-net")).toBe(false)
  })

  test("generates a sandbox-exec profile on macOS that only allows the writable directories", () => {
    const result = ShellSandbox.wrap({
      ...base,
      platform: "darwin",
      settings: { enabled: true },
      tool: "/usr/bin/sandbox-exec",
    })
    if (result.type !== "wrapped") throw new Error("expected a wrapped command")
    expect(result.args[0]).toBe("-p")
    expect(result.args[1]).toContain("(deny file-write*)")
    expect(result.args[1]).toContain('(subpath "/repo/pkg")')
    expect(result.args[1]).toContain("(deny network*)")
    expect(result.args.slice(2)).toEqual(["/bin/sh", "-c", "echo hi"])
  })

  // Runs the real thing where bubblewrap is installed: writes inside the project work, writes elsewhere fail.
  test.skipIf(process.platform !== "linux" || which("bwrap") === null)("confines writes with bubblewrap", async () => {
    const project = await Bun.$`mktemp -d`.text()
    const run = (script: string) => {
      const result = ShellSandbox.wrap({
        shell: "/bin/sh",
        args: ["-c", script],
        cwd: project.trim(),
        writable: [project.trim()],
        platform: "linux",
        settings: { enabled: true },
        tool: which("bwrap")!,
      })
      if (result.type !== "wrapped") throw new Error("expected a wrapped command")
      return Bun.spawnSync([result.command, ...result.args]).exitCode
    }
    expect(run("echo ok > inside.txt")).toBe(0)
    expect(run("echo no > /etc/orbit-sandbox-test")).not.toBe(0)
  })
})
