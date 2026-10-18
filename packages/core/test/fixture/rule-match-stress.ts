/**
 * Runs `ConfigInstructionFile.ruleMatches` over the worst shapes a cloned repository could write as patterns, against a path of
 * four 254-character folders and a file named `b` (1,021 characters, the most a read keeps), and prints how long each took and whether
 * it matched as JSON. It is a script of its own because the work is synchronous: the test starts it with a deadline.
 *
 * The matcher is Bun's, which does not backtrack, so each row costs time that grows with the path and the patterns and no more.
 */
import path from "path"
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"

const base = path.resolve("rule-stress-base")
const folder = "a".repeat(254)
const target = path.join(base, folder, folder, folder, folder, "b")

const repeated = (pattern: string) => Array.from({ length: 255 }, () => pattern)
const rows: Record<string, string[]> = {
  starThenNotStarAStar: ["*", ...repeated("!*a**")],
  starThenNotGlobstarAGlobstar: ["*", ...repeated("!**a**")],
  starThenNotStarAThreeStars: ["*", ...repeated("!*a***")],
  starThenNotStarAStarA: ["*", ...repeated("!*a*a")],
  twentyStarAThenB: repeated(`${"*a".repeat(20)}b`),
  anchoredStars: repeated(`${"*a".repeat(20)}b/**/${"*a".repeat(20)}b`),
  control: ["*"],
}

console.log(
  JSON.stringify(
    Object.entries(rows).map(([name, patterns]) => {
      const started = performance.now()
      const matched = ConfigInstructionFile.ruleMatches(patterns, base, target)
      return { name, ms: performance.now() - started, matched }
    }),
  ),
)
