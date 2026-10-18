/**
 * Runs `ConfigInstructionFile.ruleMatches` over the worst shapes a cloned repository could write as patterns and file names,
 * and prints how long each took and whether it matched as JSON. It is a script of its own because the work is synchronous:
 * the test starts it with a deadline.
 */
import path from "path"
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"

const base = path.resolve("rule-stress-base")
const file = (...parts: string[]) => path.join(base, ...parts)
const deep = (n: number, name: string) => file(...Array.from({ length: n }, () => name))

// worstKept256, worstKeptStars256, twoStarRuns and twoGlobstarsAtLimit run patterns `cheapPattern` keeps, so their time is the
// matcher's own; the rest are patterns it drops, which must cost nothing, and a control.
const rows: Record<string, { patterns: string[]; target: string }> = {
  manyStars: { patterns: [`${"*a".repeat(20)}*ab`], target: file("a".repeat(60)) },
  crossSegment: { patterns: [`${"*a*a/".repeat(7)}x`], target: deep(8, "a".repeat(20)) },
  crossSegmentWide: { patterns: [`${"*a*a/".repeat(6)}x`], target: deep(7, "a".repeat(30)) },
  threeGlobstars: { patterns: ["**/a/**/a/**/b"], target: deep(1_000, "a") },
  twoGlobstarsDeep: { patterns: ["**/a/**/a/b"], target: deep(1_000, "a") },
  twoGlobstarsAtLimit: { patterns: ["**/a/**/a/b"], target: deep(31, "a") },
  worstKept256: { patterns: Array.from({ length: 256 }, () => "**/a/**/b"), target: deep(31, "a".repeat(30)) },
  worstKeptStars256: { patterns: Array.from({ length: 256 }, () => "*a*a*b"), target: file("a".repeat(255)) },
  twoStarRuns: { patterns: ["*a*a*b"], target: file("a".repeat(255)) },
  control: { patterns: ["*.ts"], target: file("src", "x.ts") },
}

console.log(
  JSON.stringify(
    Object.entries(rows).map(([name, row]) => {
      const started = performance.now()
      const matched = ConfigInstructionFile.ruleMatches(row.patterns, base, row.target)
      return { name, ms: performance.now() - started, matched }
    }),
  ),
)
