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
