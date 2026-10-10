import { describe, expect, test } from "bun:test"
import { SandboxPlatform } from "./sandbox-platform.js"

const kind = (platform: NodeJS.Platform, release: string, env: Record<string, string> = {}) =>
  SandboxPlatform.platform({ platform, release, env })

describe("SandboxPlatform.platform", () => {
  test("tells WSL2, WSL1 and plain Linux apart by kernel release", () => {
    expect(kind("linux", "5.15.153.1-microsoft-standard-WSL2")).toBe("wsl2")
    expect(kind("linux", "5.10.16.3-WSL2")).toBe("wsl2")
    expect(kind("linux", "4.4.0-19041-Microsoft")).toBe("wsl1")
    expect(kind("linux", "4.4.0-19041-microsoft")).toBe("wsl1")
    expect(kind("linux", "6.8.0-45-generic")).toBe("linux")
  })

  test("uses the distro name only to promote a plain release, never to demote WSL1", () => {
    expect(kind("linux", "6.6.0-custom", { WSL_DISTRO_NAME: "Ubuntu" })).toBe("wsl2")
    expect(kind("linux", "4.4.0-19041-Microsoft", { WSL_DISTRO_NAME: "Ubuntu" })).toBe("wsl1")
    expect(kind("linux", "6.8.0-45-generic", {})).toBe("linux")
  })

  test("ignores the release off Linux", () => {
    expect(kind("darwin", "4.4.0-Microsoft")).toBe("darwin")
    expect(kind("win32", "10.0.26200")).toBe("win32")
    expect(kind("freebsd", "14.0")).toBeUndefined()
  })

  test("names a sandbox tool for macOS, Linux and WSL2 only", () => {
    expect(SandboxPlatform.TOOL.linux).toBe("bwrap")
    expect(SandboxPlatform.TOOL.wsl2).toBe("bwrap")
    expect(SandboxPlatform.TOOL.darwin).toBe("sandbox-exec")
    expect(SandboxPlatform.TOOL.wsl1).toBeUndefined()
    expect(SandboxPlatform.TOOL.win32).toBeUndefined()
  })
})
