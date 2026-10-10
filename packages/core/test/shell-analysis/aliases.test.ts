import { describe, expect, test } from "bun:test"
import { ShellAnalysis } from "../../src/shell/analysis"
import { which } from "../../src/util/which"
import win51 from "./aliases-win51.json"
import linux7 from "./aliases-linux7.json"

// The alias table is checked against what real hosts say (record-aliases.ts). Windows pwsh 7 has no recorded host:
// its rows are the 5.1 ones minus the 5.1-only names, and are not pinned here.
type Fixture = { version: string; aliases: { name: string; target: string }[] }
const hosts: [string, Fixture, ShellAnalysis.Dialect, NodeJS.Platform][] = [
  ["Windows PowerShell 5.1", win51, "powershell-5.1", "win32"],
  ["pwsh 7 on Linux", linux7, "pwsh", "linux"],
]
// An alias of 5.1 that points at a function, which wraps the cmdlet the table names.
const WRAPPED: Record<string, string> = { mkdir: "new-item", help: "get-help" }

function define(fixture: Fixture, name: string) {
  const found = fixture.aliases.find((item) => item.name.toLowerCase() === name)?.target.toLowerCase()
  return found === undefined ? undefined : (WRAPPED[found] ?? found)
}

describe("alias table against recorded hosts", () => {
  describe.each(hosts)("%s", (_label, fixture, kind, platform) => {
    test("every name the table maps is an alias of that host for the same cmdlet", () => {
      const wrong = ShellAnalysis.aliasNames()
        .flatMap((name) => {
          const target = ShellAnalysis.aliasTarget(name, kind, platform)
          if (target === undefined) return []
          return define(fixture, name) === target ? [] : [`${name}: table ${target}, host ${define(fixture, name)}`]
        })
      expect(wrong).toEqual([])
    })
  })

  test("sort is never mapped, and Linux maps no Windows-only name", () => {
    for (const [kind, platform] of [["pwsh", "linux"], ["pwsh", "win32"], ["powershell-5.1", "win32"]] as const)
      expect(ShellAnalysis.aliasTarget("sort", kind, platform)).toBeUndefined()
    for (const name of ["ls", "cat", "ps", "sleep", "man", "mv", "cp", "rm", "kill", "gtz"])
      expect(ShellAnalysis.aliasTarget(name, "pwsh", "linux")).toBeUndefined()
  })

  test("names the old table got wrong", () => {
    expect(ShellAnalysis.aliasTarget("gtz", "powershell-5.1", "win32")).toBeUndefined()
    expect(ShellAnalysis.aliasTarget("spsv", "powershell-5.1", "win32")).toBe("stop-service")
    expect(ShellAnalysis.aliasTarget("ndr", "pwsh", "linux")).toBe("new-psdrive")
  })

  // Re-reads Get-Alias on this machine when it is Windows with Windows PowerShell, so a stale fixture shows up.
  test.skipIf(process.platform !== "win32" || !which("powershell"))("the local Windows PowerShell still agrees", async () => {
    const names = ShellAnalysis.aliasNames().filter((name) => ShellAnalysis.aliasTarget(name, "powershell-5.1", "win32") !== undefined)
    const script = `$ErrorActionPreference='SilentlyContinue'; Get-Alias | ForEach-Object { $_.Name + '=' + $_.Definition }`
    const child = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const live = new Map(
      (await new Response(child.stdout).text())
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")).toLowerCase(), line.slice(line.indexOf("=") + 1).toLowerCase()] as const),
    )
    const wrong = names.filter((name) => {
      const found = live.get(name)
      return (found === undefined ? undefined : (WRAPPED[found] ?? found)) !== ShellAnalysis.aliasTarget(name, "powershell-5.1", "win32")
    })
    expect(wrong).toEqual([])
  })
})
