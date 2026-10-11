import path from "path"
import { describe, expect, test } from "bun:test"
import { FSUtil } from "../src/fs-util.js"

const windows = process.platform === "win32"

// A path in a tool call is drawn and resolved by `resolveFrom`, on the server and in each client, so each spelling of a
// Windows path names the file that Windows opens: a `\\?\` or `\\.\` prefix is the plain path, and trailing periods
// and spaces go as Windows drops them. Elsewhere these are names like any other.
describe("FSUtil.resolveFrom on Windows spellings", () => {
  const directory = path.resolve(windows ? "C:\\work\\project" : "/work/project")
  const home = path.resolve(windows ? "C:\\Users\\person" : "/home/person")
  const rows: ReadonlyArray<readonly [input: string, windows: string]> = [
    ["\\\\?\\C:\\work\\project\\.env", "C:\\work\\project\\.env"],
    ["\\\\.\\C:\\work\\project\\.env", "C:\\work\\project\\.env"],
    ["//?/C:/work/project/.env", "C:\\work\\project\\.env"],
    ["\\\\?\\c:\\work\\project\\.env", "C:\\work\\project\\.env"],
    ["\\\\?\\UNC\\server\\share\\.env", "\\\\server\\share\\.env"],
    [".env.", "C:\\work\\project\\.env"],
    [".env ", "C:\\work\\project\\.env"],
    [".env. . ", "C:\\work\\project\\.env"],
    ["cfg.\\orbit.json", "C:\\work\\project\\cfg\\orbit.json"],
    ["cfg.", "C:\\work\\project\\cfg"],
    // Windows keeps a space, or a second period, at the end of a part that is not the last.
    ["cfg \\orbit.json", "C:\\work\\project\\cfg \\orbit.json"],
    ["cfg..\\orbit.json", "C:\\work\\project\\cfg..\\orbit.json"],
    // A part of only periods is a name, and `..` climbs.
    ["...", "C:\\work\\project\\..."],
    ["sub\\..\\.env", "C:\\work\\project\\.env"],
    ["~\\.env.", "C:\\Users\\person\\.env"],
    // Controls.
    [".env", "C:\\work\\project\\.env"],
    [".env.local", "C:\\work\\project\\.env.local"],
  ]
  for (const [input, expected] of rows)
    test(`resolves ${JSON.stringify(input)}`, () => {
      expect(FSUtil.resolveFrom(directory, input, home)).toBe(windows ? expected : path.resolve(directory, input))
    })

  test("leaves a path alone off Windows", () => {
    if (windows) return
    expect(FSUtil.windowsTrim("/work/project/.env.")).toBe("/work/project/.env.")
    expect(FSUtil.windowsPath("//?/C:/x")).toBe("//?/C:/x")
  })
})

// The shell analysis asks for a platform that is not the host's, so Windows rules run on any host and POSIX rules on Windows.
describe("FSUtil.resolveFrom with an injected platform", () => {
  const rows: ReadonlyArray<readonly [platform: NodeJS.Platform, directory: string, input: string, expected: string]> = [
    ["win32", "C:\\work", "/c/Users/u/x", "C:\\Users\\u\\x"],
    ["win32", "C:\\work", "/cygdrive/d/x", "D:\\x"],
    ["win32", "C:\\work", "/mnt/c/x", "C:\\x"],
    ["win32", "C:\\work", "\\\\?\\C:\\x", "C:\\x"],
    ["win32", "C:\\work", "x. ", "C:\\work\\x"],
    ["win32", "C:\\work", "~/x", "C:\\Users\\u\\x"],
    ["win32", "C:\\work", "..\\..\\x", "C:\\x"],
    ["linux", "/work", "/c/Users/u/x", "/c/Users/u/x"],
    ["linux", "/work", "x. ", "/work/x. "],
    ["linux", "/work", "~/x", "/home/u/x"],
    ["linux", "/work", "a/../../x", "/x"],
    ["darwin", "/work", "//srv/x", "/srv/x"],
  ]
  for (const [platform, directory, input, expected] of rows)
    test(`${platform} resolves ${JSON.stringify(input)}`, () => {
      expect(FSUtil.resolveFrom(directory, input, platform === "win32" ? "C:\\Users\\u" : "/home/u", platform)).toBe(expected)
    })

  test("windowsPath and windowsTrim take the platform too", () => {
    expect(FSUtil.windowsPath("/c/x", "win32")).toBe("C:/x")
    expect(FSUtil.windowsPath("/c/x", "linux")).toBe("/c/x")
    expect(FSUtil.windowsTrim("C:\\work\\x. ", "win32")).toBe("C:\\work\\x")
    expect(FSUtil.windowsTrim("/work/x. ", "linux")).toBe("/work/x. ")
  })
})
