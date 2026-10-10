import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { ManagedPath } from "../src/managed-path.js"

describe("ManagedPath.directory", () => {
  test.each([
    ["linux", {}, "/etc/orbit"],
    ["freebsd", {}, "/etc/orbit"],
    ["darwin", {}, "/Library/Application Support/Orbit"],
    ["win32", { ProgramData: "D:\\Data" }, "D:\\Data\\Orbit"],
    ["win32", {}, "C:\\ProgramData\\Orbit"],
    ["win32", { ProgramData: "" }, "C:\\ProgramData\\Orbit"],
  ] as const)("%s %j resolves to %s", (platform, env, expected) => {
    expect(ManagedPath.directory(platform, env)).toBe(expected)
  })

  test.each(["linux", "darwin", "win32"] as const)("ORBIT_MANAGED_DIR overrides %s", (platform) => {
    expect(ManagedPath.directory(platform, { ORBIT_MANAGED_DIR: "/tmp/managed", ProgramData: "D:\\Data" })).toBe(
      "/tmp/managed",
    )
  })

  test("an empty override is ignored", () => {
    expect(ManagedPath.directory("linux", { ORBIT_MANAGED_DIR: "" })).toBe("/etc/orbit")
  })

  test("asking for a missing folder does not create it", () => {
    const missing = "/definitely/not/here/orbit-managed"
    expect(ManagedPath.directory("linux", { ORBIT_MANAGED_DIR: missing })).toBe(missing)
    expect(existsSync(missing)).toBe(false)
  })
})
