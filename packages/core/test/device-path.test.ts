import { describe, expect, test } from "bun:test"
import { DevicePath } from "@orbit/core/device-path"

// Every platform's table runs on any host, because `blocked` chooses its rules from the platform argument.
const cases: ReadonlyArray<readonly [NodeJS.Platform, string, boolean]> = [
  ["linux", "/dev/zero", true],
  ["linux", "/dev/random", true],
  ["linux", "/dev/urandom", true],
  ["linux", "/dev/full", true],
  ["linux", "/dev/stdin", true],
  ["linux", "/dev/stdout", true],
  ["linux", "/dev/stderr", true],
  ["linux", "/dev/tty", true],
  ["linux", "/dev/tty1", true],
  ["linux", "/dev/ttyS0", true],
  ["linux", "/dev/console", true],
  ["linux", "/dev/pts/0", true],
  ["linux", "/dev/fd/0", true],
  ["linux", "/proc/self/fd/0", true],
  ["linux", "/proc/123/fd/0", true],
  ["linux", "/proc/thread-self/fd/0", true],
  ["linux", "/proc/self/task/42/fd/0", true],
  ["linux", "/proc/123/task/42/fd/0", true],
  ["linux", "/proc/thread-self/task/42/fd/3", true],
  ["linux", "/dev/ptmx", true],
  ["darwin", "/dev/cu.usbmodem1", true],
  ["linux", "/proc/self/task/abc/fd/0", false],
  ["linux", "/proc/thread-self/status", false],
  ["linux", "/dev/./zero", true],
  ["linux", "/tmp/../dev/zero", true],
  ["darwin", "/dev/zero", true],
  ["darwin", "/dev/fd/3", true],
  ["darwin", "/dev/ttys001", true],
  ["linux", "/dev-notes/a.md", false],
  ["linux", "/dev/null.txt", false],
  ["linux", "/home/me/dev/zero", false],
  ["linux", "/proc/self/status", false],
  ["linux", "/proc/123/cmdline", false],
  ["linux", "/proc/abc/fd/0", false],
  ["linux", "/work/stdin", false],
  ["win32", "C:\\work\\NUL", true],
  ["win32", "C:\\work\\nul.txt", true],
  ["win32", "C:\\work\\con.txt", true],
  ["win32", "C:\\work\\CON", true],
  ["win32", "C:\\work\\Prn.log", true],
  ["win32", "C:\\work\\AUX.tar.gz", true],
  ["win32", "C:\\work\\COM1", true],
  ["win32", "C:\\work\\com9.txt", true],
  ["win32", "C:\\work\\LPT1", true],
  ["win32", "C:\\work\\COM\u00b9", true],
  ["win32", "C:\\work\\LPT\u00b3.txt", true],
  ["win32", "C:\\work\\com\u00b2", true],
  ["win32", "C:\\work\\lpt9.md", true],
  ["win32", "C:\\work\\CONIN$", true],
  ["win32", "C:\\work\\CONOUT$", true],
  ["win32", "C:\\work\\NUL.", true],
  ["win32", "C:\\work\\nul .txt", true],
  ["win32", "C:/work/nul", true],
  ["win32", "\\\\.\\PhysicalDrive0", true],
  ["win32", "\\\\.\\COM1", true],
  ["win32", "\\\\?\\GLOBALROOT\\Device\\x", true],
  ["win32", "//./PhysicalDrive0", true],
  ["win32", "C:\\work\\console.log", false],
  ["win32", "C:\\work\\con-notes.md", false],
  ["win32", "C:\\work\\nullable.ts", false],
  ["win32", "C:\\work\\COM10", false],
  ["win32", "C:\\work\\COM0", false],
  ["win32", "C:\\work\\aux-file\\readme.md", false],
  ["win32", "C:\\work\\a.nul", false],
  ["win32", "C:\\dev\\zero", false],
  // The Windows names are plain files elsewhere.
  ["linux", "/work/nul", false],
  ["linux", "/work/CON.txt", false],
  ["darwin", "/work/COM1", false],
  // The Unix devices are not Windows paths.
  ["win32", "/dev/zero", false],
]

describe("DevicePath.blocked", () => {
  for (const [platform, file, expected] of cases)
    test(`${platform} ${file} is ${expected ? "blocked" : "allowed"}`, () => {
      expect(DevicePath.blocked(file, platform)).toBe(expected)
    })

  test("defaults to the host platform", () => {
    expect(DevicePath.blocked(process.platform === "win32" ? "C:\\work\\NUL" : "/dev/zero")).toBe(true)
  })
})
