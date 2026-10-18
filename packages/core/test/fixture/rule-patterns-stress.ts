/**
 * Runs `ConfigInstructionFile.rulePatterns` over a `paths` value of about a megabyte that a cloned repository could ship, as
 * a string and as a list, and prints how many patterns were kept and how long each took as JSON. It is a script of its own
 * because the work is synchronous: the test starts it with a deadline.
 */
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"
import { ConfigMarkdown } from "@orbit/core/config/markdown"

const front = (frontmatter: string) => ConfigMarkdown.split(`---\n${frontmatter}\n---\nBody.`).frontmatter

const inputs: Record<string, string> = {
  commaString: `paths: "${"a,".repeat(485_000)}"`,
  commaList: `paths:\n${"  - a,b,c,d\n".repeat(80_000)}`,
  braceString: `paths: "${"{a,b},".repeat(160_000)}"`,
  // One part of 190,000 brace groups would recurse 190,000 levels, so it is dropped before it is expanded.
  oneHugePart: `paths: "${"{a,b}".repeat(190_000)}"`,
}

const report = Object.entries(inputs).map(([name, text]) => {
  const started = performance.now()
  const result = ConfigInstructionFile.rulePatterns(front(text))
  return { name, ms: performance.now() - started, kept: result.patterns?.length ?? 0 }
})
console.log(JSON.stringify(report))
