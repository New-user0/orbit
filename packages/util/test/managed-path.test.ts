import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { ManagedPath } from "../src/managed-path.js"

describe("ManagedPath.directory", () => {
  test.each([
    ["linux", {}, "/etc/orbit"],
    ["freebsd", {}, "/etc/orbit"],
    ["darwin", {}, "/Library/Application Support/Orbit"],
    ["win32", { ProgramFiles: "D:\\Apps" }, "D:\\Apps\\Orbit"],
    ["win32", {}, "C:\\Program Files\\Orbit"],
    ["win32", { ProgramFiles: "" }, "C:\\Program Files\\Orbit"],
    ["win32", { ProgramFiles: "." }, "C:\\Program Files\\Orbit"],
    ["win32", { ProgramFiles: "apps" }, "C:\\Program Files\\Orbit"],
    // A standard user can write under ProgramData, so it is never the default, whatever the variable says.
    ["win32", { ProgramData: "C:\\ProgramData", ProgramFiles: "" }, "C:\\Program Files\\Orbit"],
    ["win32", { ProgramData: "D:\\Data" }, "C:\\Program Files\\Orbit"],
  ] as const)("%s %j resolves to %s", (platform, env, expected) => {
    expect(ManagedPath.directory(platform, env)).toBe(expected)
  })

  test.each(["linux", "darwin", "win32"] as const)("ORBIT_MANAGED_DIR overrides %s", (platform) => {
    expect(ManagedPath.directory(platform, { ORBIT_MANAGED_DIR: "/tmp/managed", ProgramFiles: "D:\\Apps" })).toBe(
      "/tmp/managed",
    )
  })

  test("an empty override is ignored", () => {
    expect(ManagedPath.directory("linux", { ORBIT_MANAGED_DIR: "" })).toBe("/etc/orbit")
  })

  test.each(["linux", "darwin"] as const)("a relative override is ignored on %s", (platform) => {
    expect(ManagedPath.directory(platform, { ORBIT_MANAGED_DIR: "." })).toBe(
      platform === "linux" ? "/etc/orbit" : "/Library/Application Support/Orbit",
    )
    expect(ManagedPath.directory(platform, { ORBIT_MANAGED_DIR: "managed" })).not.toBe("managed")
  })

  test("a relative override is ignored on win32", () => {
    expect(ManagedPath.directory("win32", { ORBIT_MANAGED_DIR: "managed", ProgramFiles: "D:\\Apps" })).toBe(
      "D:\\Apps\\Orbit",
    )
  })

  test("asking for a missing folder does not create it", () => {
    const missing = "/definitely/not/here/orbit-managed"
    expect(ManagedPath.directory("linux", { ORBIT_MANAGED_DIR: missing })).toBe(missing)
    expect(existsSync(missing)).toBe(false)
  })
})
