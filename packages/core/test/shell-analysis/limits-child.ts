// Runs ShellAnalysis.inspect on an input that the parser takes far longer than 50 ms to read, and prints the opaque
// result. Started by analysis.test.ts in a child process with a deadline.
import path from "node:path"
import { Effect } from "effect"
import { ShellAnalysis } from "../../src/shell/analysis"
import { PowerShellParse } from "../../src/shell/powershell-parse"

const result = await Effect.runPromise(
  ShellAnalysis.inspect("a | ".repeat(2450), {
    shell: "/bin/bash",
    platform: "linux",
    path: path.posix,
    home: "/home/u",
    cwd: "/work",
    env: { PATH: "/usr/bin" },
    local: () => false,
  }).pipe(Effect.provideService(PowerShellParse.Service, { parse: () => Effect.die("not used") })),
)
console.log(JSON.stringify(result.opaque))
