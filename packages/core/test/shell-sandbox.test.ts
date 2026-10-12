import { existsSync } from "node:fs"
import os from "node:os"
import { describe, expect, test } from "bun:test"
import { ShellSandbox } from "@orbit/core/shell/sandbox"
import { which } from "@orbit/util/which"

const base = {
  shell: "/bin/sh",
  args: ["-c", "echo hi"],
  cwd: "/repo/pkg",
  writable: ["/repo", "/repo/pkg", "/tmp"],
  release: "",
  env: {},
  interop: false,
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

  test("fails closed on WSL1 and takes the Linux path on WSL2", () => {
    const wsl1 = { ...base, platform: "linux" as const, release: "4.4.0-19041-Microsoft", tool: "/usr/bin/bwrap" }
    const result = ShellSandbox.wrap({ ...wsl1, settings: { enabled: true } })
    expect(result.type).toBe("unsupported")
    // Even a present bwrap, and even a WSL_DISTRO_NAME, must not turn WSL1 into a wrapped command.
    expect(ShellSandbox.wrap({ ...wsl1, env: { WSL_DISTRO_NAME: "Ubuntu" }, settings: { enabled: true } }).type).toBe(
      "unsupported",
    )
    expect(ShellSandbox.wrap({ ...wsl1, settings: {} })).toEqual({ type: "unwrapped" })

    const wsl2 = { ...base, platform: "linux" as const, release: "5.15.153.1-microsoft-standard-WSL2" }
    expect(ShellSandbox.wrap({ ...wsl2, settings: { enabled: true }, tool: "/usr/bin/bwrap" }).type).toBe("wrapped")
    expect(ShellSandbox.wrap({ ...wsl2, settings: { enabled: true } })).toEqual({ type: "missing", tool: "bwrap" })
  })

  test("hides the WSL interop sockets only on WSL2 where they exist", () => {
    const args = (release: string, interop: boolean) => {
      const result = ShellSandbox.wrap({
        ...base,
        platform: "linux",
        release,
        interop,
        settings: { enabled: true },
        tool: "bwrap",
      })
      if (result.type !== "wrapped") throw new Error("expected a wrapped command")
      return result.args.join(" ")
    }
    const wsl2 = "5.15.153.1-microsoft-standard-WSL2"
    expect(args(wsl2, true)).toContain("--tmpfs /run/WSL")
    expect(args(wsl2, false)).not.toContain("/run/WSL")
    expect(args("6.1.0-generic", true)).not.toContain("/run/WSL")
  })

  test("hides the WSL interop sockets after every writable bind, so a bind of /run or / cannot restore them", () => {
    const wsl2 = "5.15.153.1-microsoft-standard-WSL2"
    ;[["/run"], ["/"]].forEach((writable) => {
      const result = ShellSandbox.wrap({
        ...base,
        writable,
        platform: "linux",
        release: wsl2,
        interop: true,
        settings: { enabled: true },
        tool: "bwrap",
      })
      if (result.type !== "wrapped") throw new Error("expected a wrapped command")
      expect(result.args.indexOf("--tmpfs")).toBeGreaterThan(result.args.lastIndexOf("--bind"))
    })
  })

  test("launch passes the host's interop flag, so only a WSL2 host with /run/WSL gets the tmpfs", () => {
    const previous = { ...ShellSandbox.host }
    const previousTool = ShellSandbox.TOOL.linux
    ShellSandbox.TOOL.linux = "bun"
    try {
      const args = (interop: boolean) => {
        Object.assign(ShellSandbox.host, {
          platform: "linux",
          release: "5.15.153.1-microsoft-standard-WSL2",
          env: {},
          interop,
        })
        const result = ShellSandbox.launch({
          settings: { enabled: true },
          shell: "/bin/sh",
          args: ["-c", "echo hi"],
          cwd: "/repo",
          writable: ["/repo"],
        })
        if (result.type !== "wrapped") throw new Error("expected a wrapped command")
        return result.args.join(" ")
      }
      expect(args(true)).toContain("--tmpfs /run/WSL")
      expect(args(false)).not.toContain("/run/WSL")
    } finally {
      Object.assign(ShellSandbox.host, previous)
      if (previousTool === undefined) delete ShellSandbox.TOOL.linux
      else ShellSandbox.TOOL.linux = previousTool
    }
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
        // The real host values: on a WSL2 kernel without /run/WSL (a container) this fails if the guard is dropped.
        release: os.release(),
        env: {},
        interop: existsSync("/run/WSL"),
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
