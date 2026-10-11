export * as ShellExit from "./exit.js"

import type { ShellAnalysis } from "./analysis.js"

// How a foreground bash command's exit code reads: some programs use a low non-zero code for an answer, not a failure.
// It judges the program the analysis found to decide the line's status, by its name as written. It is a heuristic for
// reporting only and decides no permission: a program that is not in the table, or a line the analysis cannot model,
// fails on any non-zero code.

// The lowest exit code that is a failure. `grep`, `rg`, `find`, `diff`, `test` and `[` answer 1 for "no match", "some
// folders unreadable", "differs" and "false".
const FAILS_AT = new Map([
  ["grep", 2],
  ["rg", 2],
  ["find", 2],
  ["diff", 2],
  ["test", 2],
  ["[", 2],
])

/** Whether `exit`, the code a completed foreground command returned, counts as a failure. */
export function failed(analysis: ShellAnalysis.Analysis | undefined, exit: number) {
  if (exit === 0) return false
  const decider = decide(analysis)
  return exit >= (decider ? (FAILS_AT.get(decider) ?? 1) : 1)
}

// The name of the program whose status is the line's, only when it is a plain word as written. An opaque analysis has no `last`.
function decide(analysis: ShellAnalysis.Analysis | undefined) {
  if (analysis?.dialect !== "bash" || analysis.last === undefined) return undefined
  const command = analysis.commands[analysis.last]
  if (command.env.length > 0) return undefined
  const word = command.argv[0]
  if (!word || !word.literal || word.quoted || word.glob || word.tilde) return undefined
  return word.value
}
