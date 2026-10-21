/**
 * Runs the readers of `ConfigInstructionFile` that strip a run of one character from the end of what a repository writes
 * (the slashes of a rule pattern, the underscores after an import token) over text whose run is followed by something else,
 * and over a control of the same length in letters, and prints as JSON the wall time, the processor time and the size of
 * what each made. It is a script of its own because the work is synchronous: the test starts it with a deadline.
 */
import path from "path"
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"
import { ConfigMarkdown } from "@orbit/core/config/markdown"

const front = (frontmatter: string) => ConfigMarkdown.split(`---\n${frontmatter}\n---\nBody.`).frontmatter
const choices = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").join(",")

// Twenty rules of distinct spellings, each one part of under 1,024 characters that its braces spell out into as many
// patterns as the work allowance keeps, all ending in `tail` and then a letter. The size is the patterns kept.
const rules = (prefix: string, tail: string) => () =>
  Array.from({ length: 20 }, (_, index) =>
    ConfigInstructionFile.rulePatterns(front(`paths: "${prefix}${index}{${choices}}{0,1,2,3}${tail}x"`)),
  ).reduce((sum, rule) => sum + (rule.patterns?.length ?? 0), 0)
// Eight reads of one file against 256 distinct patterns each, every pattern ending in `tail` and then a letter. The size is
// the patterns the matcher took, asked once the reads have compiled them.
const base = path.resolve("trailing-run-base")
const matches = (prefix: string, tail: string) => () =>
  Array.from({ length: 8 }, (_, batch) => {
    const patterns = Array.from({ length: 256 }, (_, index) => `${prefix}${batch}-${index}${tail}x`)
    ConfigInstructionFile.ruleMatches(patterns, base, path.join(base, "a", "b.ts"))
    return patterns.filter((pattern) => ConfigInstructionFile.compileRulePattern(pattern) !== undefined).length
  }).reduce((sum, count) => sum + count, 0)
// An import token after an underscore that opens an emphasis, whose name is the run and then a letter. The size is the
// tokens found.
const imports = (run: string) => () => ConfigInstructionFile.imports(`_@${run}x`).length

const slashes = "/".repeat(860)
const letters = "a".repeat(860)
const rows: Record<string, readonly [() => number, () => number]> = {
  rulePatterns: [rules("s", slashes), rules("c", letters)],
  negatedRulePatterns: [rules("!n", slashes), rules("!d", letters)],
  ruleMatches: [matches("m", "/".repeat(1_000)), matches("k", "a".repeat(1_000))],
  imports: [imports("_".repeat(100_000)), imports("a".repeat(100_000))],
}

const measure = (run: () => number) => {
  const started = performance.now()
  const processor = process.cpuUsage()
  const size = run()
  const used = process.cpuUsage(processor)
  return { ms: performance.now() - started, cpu: (used.user + used.system) / 1_000, size }
}

console.log(
  JSON.stringify(
    Object.entries(rows).map(([name, [hostile, control]]) => ({ name, control: measure(control), hostile: measure(hostile) })),
  ),
)
