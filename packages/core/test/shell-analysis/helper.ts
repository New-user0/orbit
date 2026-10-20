import path from "node:path"
import { ShellAnalysis } from "../../src/shell/analysis"
import { ShellParse } from "../../src/shell/parse"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import rows from "./powershell.json"
import rows7 from "./powershell-7.json"

// The parsers load once per test file. Bash cases use real tree-sitter trees; PowerShell cases use PowerShell's own
// recorded answers (see record-powershell.ts), so no host is needed and the same rows run on every platform.
const parsers = await ShellParse.parsers()

export function linux(over: Partial<ShellAnalysis.Context> = {}): ShellAnalysis.Context {
  return {
    shell: "/bin/bash",
    platform: "linux",
    path: path.posix,
    home: "/home/u",
    cwd: "/work",
    env: { PATH: "/usr/bin:/bin" },
    ...over,
  }
}

export function windows(over: Partial<ShellAnalysis.Context> = {}): ShellAnalysis.Context {
  return {
    shell: "C:\\Program Files\\Git\\bin\\bash.exe",
    platform: "win32",
    path: path.win32,
    home: "C:\\Users\\u",
    cwd: "C:\\work",
    env: { Path: "C:\\Windows\\System32;C:\\Windows" },
    ...over,
  }
}

export function bash(command: string, ctx: ShellAnalysis.Context = linux()) {
  // The same 50 ms deadline `inspect` uses: a parse that loops fails the test instead of hanging it.
  const deadline = performance.now() + 50
  const tree = parsers.bash.parse(command, null, { progressCallback: () => performance.now() > deadline })
  if (!tree) throw new Error("the parser returned no tree before its deadline")
  const result = ShellAnalysis.analyze(command, ctx, tree.rootNode)
  tree.delete()
  return result
}

export function powershell(text: string, ctx: ShellAnalysis.Context) {
  const row = ({ ...rows, ...rows7 } as Record<string, { code: number; output: string }>)[text]
  if (!row) throw new Error(`not recorded: ${JSON.stringify(text)}`)
  return ShellAnalysis.analyze(text, ctx, PowerShellParse.interpret(row.code, row.output))
}

/**
 * The time limit of a test that starts a real shell (powershell, pwsh, cmd or bash). Windows PowerShell 5.1 alone has
 * taken more than five seconds to start on a cold GitHub runner, which is longer than the default limit.
 */
export const SHELL_START = 60_000

export function pwsh(over: Partial<ShellAnalysis.Context> = {}): ShellAnalysis.Context {
  return windows({ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", ...over })
}

export function pwshLinux(over: Partial<ShellAnalysis.Context> = {}): ShellAnalysis.Context {
  return linux({ shell: "/opt/microsoft/powershell/7/pwsh", ...over })
}

/**
 * Reads the literal scripts of `result` the way `inspect` does with `nested: true`: tree-sitter for bash, the recorded rows
 * for PowerShell. A script with no recorded row cannot be parsed, which makes it opaque.
 */
export function nest(result: ShellAnalysis.Analysis, ctx: ShellAnalysis.Context) {
  const trees: { delete(): void }[] = []
  try {
    return ShellAnalysis.nest(result, ctx, (script) => {
      if (script.dialect === "powershell") {
        const row = ({ ...rows, ...rows7 } as Record<string, { code: number; output: string }>)[script.text]
        return row ? PowerShellParse.interpret(row.code, row.output) : undefined
      }
      const tree = parsers.bash.parse(script.text, null)
      if (!tree) return "aborted"
      trees.push(tree)
      return tree.rootNode
    })
  } finally {
    trees.forEach((tree) => tree.delete())
  }
}

/** The argv of every command, as plain strings. */
export function argv(result: ShellAnalysis.Analysis) {
  return result.commands.map((command) => command.argv.map((word) => word.value))
}
