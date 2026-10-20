/**
 * Runs `ConfigInstructionFile.rulePatterns` over `paths` values that a cloned repository could ship, and prints how many
 * patterns each kept, how many it left out and how long it took, as JSON. The first rows reach the cap of kept patterns
 * from about a megabyte. The others keep nothing. A YAML alias lets a file of a few kilobytes repeat one value thousands of
 * times, and `ConfigMarkdown` refuses such a block before `paths` is read (`ConfigMarkdown.Oversized`); the work
 * allowance alone stops the rows that write their values out. It is a script of its own because the work is synchronous:
 * the test starts it with a deadline.
 */
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"
import { ConfigMarkdown } from "@orbit/core/config/markdown"

const front = (frontmatter: string) => ConfigMarkdown.split(`---\n${frontmatter}\n---\nBody.`).frontmatter

// One anchored value, then a list that names it `count` times at about four bytes each.
const aliased = (value: string, count: number) => `s: &s "${value}"\npaths: [${Array(count).fill("*s").join(", ")}]`

const inputs: Record<string, string> = {
  commaString: `paths: "${"a,".repeat(485_000)}"`,
  commaList: `paths:\n${"  - a,b,c,d\n".repeat(80_000)}`,
  braceString: `paths: "${"{a,b},".repeat(160_000)}"`,
  // One part of 190,000 brace groups would recurse 190,000 levels, so it is dropped before it is expanded.
  oneHugePart: `paths: "${"{a,b}".repeat(190_000)}"`,
  // Every spelling of this part is empty, and the file is 33 kilobytes.
  aliasedEmpty: aliased("{,}".repeat(340), 8_000),
  // The same part written out 1,000 times.
  emptyList: `paths:\n${`  - "${"{,}".repeat(340)}"\n`.repeat(1_000)}`,
  // Every spelling of this part is a pattern the matcher refuses, written out and then through aliases.
  droppedList: `paths:\n${`  - "${"{/,/}".repeat(200)}"\n`.repeat(1_000)}`,
  aliasedDropped: aliased("{/,/}".repeat(200), 8_000),
  // Commas alone make no part, and a part over the length limit is never expanded, but both are read to their end.
  aliasedCommas: aliased(",".repeat(100_000), 8_000),
  aliasedLongPart: aliased("x".repeat(100_000), 8_000),
  // Many parts of a few steps each, all of them empty.
  aliasedShortParts: aliased("{,},".repeat(1_000), 8_000),
}

// Wall time grows when other processes share the machine; processor time much less, so a tighter deadline can use it.
const report = Object.entries(inputs).map(([name, text]) => {
  const frontmatter = front(text)
  const started = performance.now()
  const processor = process.cpuUsage()
  const result = ConfigInstructionFile.rulePatterns(frontmatter)
  const used = process.cpuUsage(processor)
  return {
    name,
    ms: performance.now() - started,
    cpu: (used.user + used.system) / 1_000,
    kept: result.patterns?.length ?? 0,
    dropped: result.dropped,
  }
})
console.log(JSON.stringify(report))
