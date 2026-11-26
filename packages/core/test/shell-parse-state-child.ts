// Reads one small command after an earlier input left the shared tree-sitter parsers in a bad state, and prints what
// each reader made of the small command as one JSON line. Started by shell-parse-state.test.ts in a child process with a
// deadline: a poisoned WebAssembly module stays poisoned for the whole process, and a parse can run long.
import path from "node:path"
import { Effect } from "effect"
import { ShellAnalysis } from "../src/shell/analysis"
import { ShellParse } from "../src/shell/parse"
import { PowerShellParse } from "../src/shell/powershell-parse"

const [before, reader] = process.argv.slice(2)

const linux: ShellAnalysis.Context = {
  shell: "/bin/bash",
  platform: "linux",
  path: path.posix,
  home: "/home/u",
  cwd: "/work",
  env: { PATH: "/usr/bin" },
  local: () => false,
}
const bash = "git push origin main && echo done"
const powershell = '$value = "hello"; Write-Output $value'
const run = <A, E>(effect: Effect.Effect<A, E, PowerShellParse.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(PowerShellParse.Service, { parse: () => Effect.die("PowerShell's own parser is not used") }),
      Effect.exit,
    ),
  )

// What runs first. "none" is the control: the same reader in a process where nothing ran before it.
if (before === "aborted-analysis") {
  // The bash analysis gives up on this input after its 50 ms deadline (analysis.test.ts pins that), in the middle of a
  // parse of the shared bash parser.
  const aborted = await run(ShellAnalysis.inspect("a | ".repeat(2450), linux))
  if (aborted._tag !== "Success" || aborted.value.opaque?.reason !== "parse:aborted")
    throw new Error("the long input was not given up on, so this row tests nothing")
}
if (before === "cancelled-powershell") {
  // A legacy PowerShell scan that runs past its budget stops the shared PowerShell parser the same way: its progress
  // callback answers true. Done here directly, because no input reliably takes longer than the 500 ms budget.
  const parsers = await ShellParse.parsers()
  let calls = 0
  const tree = parsers.ps.parse(
    Array.from({ length: 3000 }, (_, index) => `Remove-Item C:/f${index}`).join("; "),
    null,
    { progressCallback: () => ++calls > 1 },
  )
  if (tree !== null) throw new Error("the PowerShell parse was not cancelled, so this row tests nothing")
}
if (before === "long-scan") {
  // A long pipeline: the legacy scan reads it, and whatever it answers, the parsers must still read the next command.
  await run(ShellParse.scan("a | ".repeat(20_000), "/bin/bash", "/work"))
}

const result =
  reader === "analysis"
    ? await run(ShellAnalysis.inspect(bash, linux))
    : reader === "scan"
      ? await run(ShellParse.scan(bash, "/bin/bash", "/work"))
      : reader === "bare"
        ? await run(ShellParse.bare("git push origin main && > out.txt"))
        : reader === "operands"
          ? await run(ShellParse.operands(bash, "/bin/bash"))
          : reader === "nested"
            ? await run(ShellAnalysis.inspect(`bash -c '${bash}'`, linux, { nested: true }))
            : await run(ShellParse.scan(powershell, "pwsh", "/work"))
console.log(JSON.stringify(result._tag === "Success" ? { value: result.value } : { failure: String(result.cause) }))
