import { describe, expect, test } from "bun:test"
import { ShellAnalysis } from "../../src/shell/analysis"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { which } from "@orbit/util/which"
import win51 from "./aliases-win51.json"
import win7 from "./aliases-win7.json"
import linux7 from "./aliases-linux7.json"
import rows from "./powershell.json"
import { pwsh, pwshLinux, SHELL_START, windows } from "./helper"

// The alias table is checked against what real hosts say: the recorded ones (record-aliases.ts) on every platform, and
// each PowerShell installed on this machine. Two rules hold for every host:
// - a name the table maps is an alias of that host for the same cmdlet. A name the host does not define runs a program
//   found on PATH instead, so mapping it would judge a command the host never runs.
// - a host alias the table leaves out stays a native name, which must not read as more permissive than the host's
//   cmdlet. Leaving an alias out only makes the analysis ask.
type Fixture = { version: string; aliases: { name: string; target: string }[] }
const recorded: [string, Fixture, ShellAnalysis.Dialect, NodeJS.Platform][] = [
  ["Windows PowerShell 5.1", win51, "powershell-5.1", "win32"],
  ["pwsh 7 on Windows", win7, "pwsh", "win32"],
  ["pwsh 7 on Linux", linux7, "pwsh", "linux"],
]
// Names that some host of the edition does not define, seen on a host that has no recording. GitHub's Windows Server
// 2025 image has no `fhx`, which the 5.1 build recorded here defines.
const MISSING: [ShellAnalysis.Dialect, NodeJS.Platform, string][] = [["powershell-5.1", "win32", "fhx"]]
// An alias that points at a function, which wraps the cmdlet the table names.
const WRAPPED: Record<string, string> = { mkdir: "new-item", help: "get-help" }

function defined(pairs: { name: string; target: string }[]) {
  return new Map(pairs.map((pair) => [pair.name.toLowerCase(), WRAPPED[pair.target.toLowerCase()] ?? pair.target.toLowerCase()]))
}

function context(kind: ShellAnalysis.Dialect, platform: NodeJS.Platform) {
  if (kind === "powershell-5.1") return windows({ shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" })
  return platform === "win32" ? pwsh() : pwshLinux()
}

// Whether `name` alone is read-only, through PowerShell's recorded answer for a lone `gci` with the name put in its place.
function bareReadOnly(name: string, ctx: ShellAnalysis.Context) {
  const summary: { statements: { text: string; elements: { text: string }[] }[]; commands: Record<string, unknown>[] } =
    JSON.parse(rows.gci.output)
  summary.statements[0].text = name
  summary.statements[0].elements[0].text = name
  summary.commands[0] = { ...summary.commands[0], name, written: name, text: name }
  return ShellAnalysis.analyze(name, ctx, PowerShellParse.interpret(0, JSON.stringify(summary))).readOnly
}

function disagreements(host: Map<string, string>, kind: ShellAnalysis.Dialect, platform: NodeJS.Platform) {
  const ctx = context(kind, platform)
  const mapped = ShellAnalysis.aliasNames().flatMap((name) => {
    const target = ShellAnalysis.aliasTarget(name, kind, platform)
    if (target === undefined || host.get(name) === target) return []
    return [`${name}: table ${target}, host ${host.get(name)}`]
  })
  const left = [...host].flatMap(([name, target]) => {
    if (ShellAnalysis.aliasTarget(name, kind, platform) !== undefined) return []
    return bareReadOnly(name, ctx) && !bareReadOnly(target, ctx) ? [`${name}: read-only as a native name, host ${target}`] : []
  })
  return [...mapped, ...left]
}

describe("alias table against recorded hosts", () => {
  test.each(recorded)("%s", (_label, fixture, kind, platform) => {
    expect(disagreements(defined(fixture.aliases), kind, platform)).toEqual([])
  })

  test.each(MISSING)("%s on %s maps no %s, which some of its hosts lack", (kind, platform, name) => {
    expect(ShellAnalysis.aliasTarget(name, kind, platform)).toBeUndefined()
    expect(bareReadOnly(name, context(kind, platform))).toBe(false)
  })

  // Controls, so that neither rule passes vacuously: a host that lacks a mapped name or points it elsewhere, and a host
  // alias that the table leaves out over a read-only native name.
  test("a host that disagrees is reported", () => {
    const host = defined(win51.aliases)
    host.delete("gci")
    host.set("ri", "get-item")
    host.set("tree", "remove-item")
    expect(disagreements(host, "powershell-5.1", "win32")).toEqual([
      "gci: table get-childitem, host undefined",
      "ri: table remove-item, host get-item",
      "tree: read-only as a native name, host remove-item",
    ])
  })

  test("fhx is Format-Hex on pwsh 7, and Format-Hex written in full is read-only on 5.1", () => {
    expect(ShellAnalysis.aliasTarget("fhx", "pwsh", "win32")).toBe("format-hex")
    expect(ShellAnalysis.aliasTarget("fhx", "pwsh", "linux")).toBe("format-hex")
    expect(bareReadOnly("fhx", pwsh())).toBe(true)
    expect(bareReadOnly("fhx", pwshLinux())).toBe(true)
    expect(bareReadOnly("Format-Hex", context("powershell-5.1", "win32"))).toBe(true)
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
})

// Each PowerShell on this machine, read live with one start per host, so a host that differs from the recorded ones
// fails here. The result names the host and its version.
const local: [string, ShellAnalysis.Dialect][] = [
  ["powershell", "powershell-5.1"],
  ["pwsh", "pwsh"],
]
describe("alias table against the PowerShell on this machine", () => {
  for (const [program, kind] of local) {
    const found = kind === "powershell-5.1" && process.platform !== "win32" ? undefined : which(program)
    test.skipIf(!found)(
      `${program} agrees`,
      async () => {
        const script = `$ErrorActionPreference='SilentlyContinue'; $PSVersionTable.PSVersion.ToString(); Get-Alias | ForEach-Object { $_.Name + '=' + $_.Definition }`
        const child = Bun.spawn([found!, "-NoProfile", "-NonInteractive", "-Command", script], {
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
        })
        const [version, ...lines] = (await new Response(child.stdout).text()).split(/\r?\n/).filter(Boolean)
        const host = defined(lines.map((line) => ({ name: line.slice(0, line.indexOf("=")), target: line.slice(line.indexOf("=") + 1) })))
        const label = `${program} ${version}`
        expect({ label, wrong: disagreements(host, kind, process.platform) }).toEqual({ label, wrong: [] })
      },
      SHELL_START,
    )
  }
})
