// Runs ShellAnalysis.inspect on an input that the parser takes far longer than 50 ms to read, and prints the opaque
// result. Started by analysis.test.ts in a child process with a deadline. With "nested", the slow input is the script of
// a `bash -c`, followed by a second `bash -c` with an ordinary script, and it prints what each nested script was read as.
import path from "node:path"
import { Effect } from "effect"
import { ShellAnalysis } from "../../src/shell/analysis"
import { PowerShellParse } from "../../src/shell/powershell-parse"

const nested = process.argv[2] === "nested"
const result = await Effect.runPromise(
  ShellAnalysis.inspect(
    nested ? `bash -c '${"a | ".repeat(2450)}'; bash -c 'git push origin main && echo done'` : "a | ".repeat(2450),
    {
      shell: "/bin/bash",
      platform: "linux",
      path: path.posix,
      home: "/home/u",
      cwd: "/work",
      env: { PATH: "/usr/bin" },
      local: () => false,
    },
    { nested },
  ).pipe(Effect.provideService(PowerShellParse.Service, { parse: () => Effect.die("not used") })),
)
console.log(
  JSON.stringify(
    nested
      ? result.nested?.map((item) => ({
          opaque: item.analysis.opaque ?? null,
          commands: item.analysis.commands.map((command) => command.text),
        }))
      : result.opaque,
  ),
)
