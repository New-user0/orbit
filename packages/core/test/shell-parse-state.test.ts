import { describe, expect, test } from "bun:test"
import path from "node:path"

// The shell readers share one tree-sitter parser per language (ShellParse.parsers). tree-sitter resumes a parse that
// its progress callback cancelled on the next call to parse unless the parser is reset, and a parse that runs past a
// deadline is exactly such a cancelled parse. So one input that took too long, which a loaded machine makes likely,
// changed how the next, unrelated command was read: the legacy PowerShell scan named `hello` and the whole line as
// statements (docs/known-failures.md, tool-shell.test.ts) and the bash analysis called an ordinary command a syntax
// error. A long input can also stop the WebAssembly module for good, after which every later read in the process
// fails. What a shell command is read as must not depend on what was read before it (classes 7 and 8).
//
// Each row runs in a child process with a deadline: the parser state is per process, and a parse can run long.
async function read(before: string, reader: string) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "shell-parse-state-child.ts"), before, reader],
    { stdout: "pipe", stderr: "pipe", cwd: path.join(import.meta.dir, "..") },
  )
  const timer = setTimeout(() => child.kill(), 60_000)
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  if (code !== 0) throw new Error(`the child exited with ${code}: ${error.slice(-2_000)}`)
  return JSON.parse(output.trim().split("\n").at(-1) ?? "null")
}

// The readers of each parser, each after something that leaves that parser in a bad state.
const rows = [
  ["aborted-analysis", "analysis"],
  ["aborted-analysis", "scan"],
  ["aborted-analysis", "bare"],
  ["aborted-analysis", "operands"],
  // The analysis reads the script a `bash -c` runs with the same parser.
  ["aborted-analysis", "nested"],
  ["cancelled-powershell", "powershell"],
  ["long-scan", "scan"],
  ["long-scan", "analysis"],
] as const

describe("a shell reader after an earlier input left the shared parser in a bad state", () => {
  test.concurrent.each(rows)(
    "after %s, %s reads the next command as it does in a fresh process",
    async (before, reader) => {
      const [control, after] = await Promise.all([read("none", reader), read(before, reader)])
      // The control read the command: a fresh process is the trusted baseline.
      expect(control.value).toBeDefined()
      expect(after).toEqual(control)
    },
    120_000,
  )
})
