import { describe, expect, test } from "bun:test"
import { bash, linux, powershell, pwsh, windows } from "./helper"

// Class 6 matrix, round 3: the /proc/sys view of the NT namespace and mixed-separator NT prefixes, on win32.
// Spellings x surfaces: plain word, redirect target, diff --from-file=, wc and du --files0-from=.
describe("Git Bash spellings of a share (class 6)", () => {
  const spellings = [
    "/proc/sys/Device/Mup/evil/share/x",
    "/proc/sys/Device/LanmanRedirector/evil/share/x",
    "/proc/sys/??/UNC/evil/share/x",
    "/proc/sys/GLOBAL??/UNC/evil/share/x",
    "/proc/sys/DosDevices/UNC/evil/share/x",
    "/proc/./sys/Device/Mup/evil/share/x",
    "/proc//sys/Device/Mup/evil/share/x",
    "/proc/self/root/proc/sys/Device/Mup/evil/share/x",
    "../../../../../../proc/sys/Device/Mup/evil/share/x",
    "\\??/UNC/evil/share/x",
    "/??\\UNC\\evil\\share\\x",
    "/??/UNC\\evil\\share\\x",
  ]
  const surfaces = [
    (path: string) => `cat '${path}'`,
    (path: string) => `cat < '${path}'`,
    (path: string) => `diff --from-file='${path}' a`,
    (path: string) => `wc --files0-from='${path}'`,
    (path: string) => `du --files0-from='${path}'`,
  ]
  test.each(spellings.flatMap((path) => surfaces.map((surface) => surface(path))))("%s is not read-only on win32", (text) => {
    expect(bash(text, windows()).readOnly).toBe(false)
  })
  test("/proc/sys is an ordinary path on Linux", () => {
    expect(bash("cat /proc/sys/kernel/hostname", linux()).readOnly).toBe(true)
  })
})

describe("file magic lists (classes 4 and 6)", () => {
  test.each([
    ["win32", "file -m 'nothere.mgc://evil/share/m' x"],
    ["win32", "file -m 'nothere.mgc:/c/Users/u/.gitconfig' x"],
    ["win32", "file --magic-file='nothere.mgc://evil/share/m' x"],
    ["linux", "file -m 'a:/home/u/.ssh/id_rsa' x"],
    ["linux", "file --magic-file=a:/home/u/.ssh/id_rsa x"],
    ["linux", "file --magic-file a:/etc/x x"],
    ["win32", "file -m='nothere.mgc://evil/share/m' x"],
    ["linux", "file -m=a:/home/u/.ssh/id_rsa x"],
    ["linux", "file -k -m=x:y x"],
    ["linux", "file -mx:y x"],
    ["linux", "file -km x:y x"],
  ])("%s: %s is not read-only", (platform, text) => {
    expect(bash(text, platform === "win32" ? windows() : linux()).readOnly).toBe(false)
  })
  test("a magic file without a list stays read-only", () => {
    expect(bash("file -m magic.mgc x").readOnly).toBe(true)
  })
})

describe("the share and provider checks are no stricter than the reference", () => {
  test.each(["jq '.a // \"x\"' f", "echo 'a // b'"])("%s is read-only on win32", (text) => {
    expect(bash(text, windows()).readOnly).toBe(true)
  })
  test("a host after // is still a share", () => {
    expect(bash("cat //evil/share/x", windows()).readOnly).toBe(false)
  })
  test.each(["Get-Date -Format HH:mm", "Get-Date -Format:HH:mm"])("%s is read-only", (text) => {
    expect(powershell(text, pwsh()).readOnly).toBe(true)
  })
  test.each(["Get-Content ab:\\x", "Get-Content -Path:ab:\\x", "Get-Process -Name env:x", "Get-Date -Format:env:x", "Get-Date -Format \\\\evil\\share"])(
    "%s is not read-only",
    (text) => {
      expect(powershell(text, pwsh()).readOnly).toBe(false)
    },
  )
})

describe("a heredoc body is refused with its reason", () => {
  test.each(["echo \"$(cat <<'E'\n/proc/self//environ\nE\n)\"", "echo \"$(cat <<'E'\nsystem (1)\nE\n)\""])("%j", (text) => {
    expect(bash(text).opaque).toEqual({ class: "unsupported", reason: "heredoc:content" })
  })
})
