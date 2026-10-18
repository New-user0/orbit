/**
 * Runs `ConfigInstructionFile.ruleMatches` over the worst shapes a cloned repository could write as patterns and file names,
 * and prints how long each took and whether it matched as JSON. It is a script of its own because the work is synchronous:
 * the test starts it with a deadline.
 */
import path from "path"
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"

const base = path.resolve("rule-stress-base")
const file = (...parts: string[]) => path.join(base, ...parts)

const rows: Record<string, { patterns: string[]; target: string }> = {
  manyStars: { patterns: [`${"*a".repeat(20)}*ab`], target: file("a".repeat(60)) },
  threeGlobstars: { patterns: ["**/a/**/a/**/b"], target: file(...Array.from({ length: 1_000 }, () => "a")) },
  twoGlobstarsDeep: { patterns: ["**/a/**/a/b"], target: file(...Array.from({ length: 1_000 }, () => "a")) },
  twoGlobstarsAtLimit: { patterns: ["**/a/**/a/b"], target: file(...Array.from({ length: 31 }, () => "a")) },
  worstAllowed: {
    patterns: Array.from({ length: 256 }, () => "**/a/**/*a*a*b"),
    target: file(...Array.from({ length: 31 }, () => "a".repeat(30))),
  },
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
