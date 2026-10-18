/**
 * Runs `ConfigInstructionFile.parse` over inputs that a cloned repository could ship, and prints how long each took as
 * JSON. It is a script of its own because the work is synchronous: a loop that never ends cannot be cut short from the
 * process that runs it, so the test starts this one with a deadline. It exits with an error when `parse` throws.
 */
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"

const fixed: Record<string, string> = {
  stars: `${"*".repeat(200_000)}<!-- c -->`,
  underscores: `${"_a ".repeat(70_000)}\n\n<!-- c -->`,
  nestedQuotes: `${"> ".repeat(100_000)}x\n\n<!-- c -->`,
  nestedList: `${"- ".repeat(100_000)}x\n<!-- c -->`,
  nestedOrdered: `${"1. ".repeat(60_000)}x\n<!-- c -->`,
  openers: "<!--\n".repeat(50_000),
  openersAndOneClose: `${"<!--\n".repeat(50_000)}-->`,
  closeThenOpeners: `-->\n${"<!--\n".repeat(50_000)}`,
  manyComments: "<!-- x -->\n\n".repeat(50_000),
  manyCommentsTight: "text\n<!-- x -->\n".repeat(50_000),
  listThenParagraph: `- a\n${"text\n".repeat(100_000)}<!-- c -->\n`,
  longItem: `- a\n${"  b\n".repeat(100_000)}<!-- c -->\n`,
  longItemWithBlanks: `- a\n${"\n  b\n".repeat(50_000)}<!-- c -->\n`,
  ticks: `${"`".repeat(200_000)}\n<!-- c -->`,
  fences: `${"```\n".repeat(50_000)}<!-- c -->`,
  unclosedFence: `\`\`\`\n${"x\n".repeat(100_000)}<!-- c -->`,
  longLine: `${"a ".repeat(500_000)}\n<!-- c -->`,
  longTag: `<a ${"x ".repeat(100_000)}>\n<!-- c -->`,
  manyBlankLines: `${"\n".repeat(500_000)}<!-- c -->`,
  tabs: `${"\t".repeat(200_000)}<!-- c -->`,
  lazyQuote: `> a\n${"text\n".repeat(100_000)}<!-- c -->`,
  quoteLadder: `${Array.from({ length: 3_000 }, (_, index) => `${"> ".repeat(index % 100)}x`).join("\n")}\n<!-- c -->`,
  dashes: `${"-".repeat(300_000)}\n<!-- c -->`,
  breaks: `${"- - - - - - -\n".repeat(30_000)}<!-- c -->`,
  items: `${"- a\n".repeat(100_000)}<!-- c -->`,
  crlf: "text\r\n<!-- c -->\r\n".repeat(50_000),
  frontMatterNeverCloses: `---\n${"a: b\n".repeat(100_000)}`,
  frontMatterDelimiterLookalikes: `---\n${"--- x\n".repeat(100_000)}`,
  atSigns: "@".repeat(100_000),
  atSignsSpaced: "@ ".repeat(100_000),
  atTokens: "@a ".repeat(100_000),
  atTokensEscaped: "@a\\ b ".repeat(60_000),
  unclosedSpans: Array.from({ length: 800 }, (_, index) => `${"`".repeat(index + 1)} @./a.md`).join("\n"),
  alternatingSpans: "` `` ``` ".repeat(30_000),
  tagsOpen: "<a ".repeat(100_000),
  tagsMany: "<b>@./a.md</b> ".repeat(30_000),
  linkTargetsOpen: "[x](".repeat(60_000),
  imagesOpen: "![x ".repeat(60_000),
  commentsOpen: "text <!-- @./a.md ".repeat(30_000),
  longListItem: `- ${"@./a.md ".repeat(60_000)}`,
  deepListAt: `${"- ".repeat(100_000)}@./a.md`,
  deepQuoteAt: `${">".repeat(100_000)} @./a.md`,
  bracketsAt: "[@./a.md".repeat(50_000),
  headings: "# Compaction instructions\nx\n".repeat(100_000),
  backtickRun: "`".repeat(1_000_000),
  alternatingFences: "```\n~~~\n".repeat(50_000),
  oneMegabyteLine: `# ${"a ".repeat(500_000)}`,
  headingLadder: Array.from({ length: 100_000 }, (_, index) => `${"#".repeat((index % 6) + 1)} Compaction instructions`).join("\n"),
  blankThenText: `# Compaction instructions\n${"\n ".repeat(200_000)}x`,
  frontMatterAndComments:`---\n${"a: b\n".repeat(1_000)}---\n${"<!-- x -->\n\n".repeat(20_000)}`,
}

// A generator that a failure can be replayed from: the same seed gives the same documents.
let seed = 20_251
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!

const pieces = [
  "", "", " ", "\t", "text", "# heading", "====", "----", "---", "***", "- - -", "```", "~~~", "````", "    code", "- item",
  "-", "1. item", "2) item", "> quote", ">", ">> x", "<div>", "</div>", "<pre>", "</pre>", "<script>", "<?php", "<!DOCTYPE html>",
  "<![CDATA[", "<custom-tag>", "<br>", "<!-- comment -->", "<!--", "-->", "<!-- a --> tail", "text <!-- c --> text", "`<!-- c -->`",
  "<!-->", "<!--->", "\u0000", "\ud800", " ", "\r", "é", "\u{1F600}", "<", "<!", "<!-", "--", "[a]: b", "|a|b|", "\\",
]

function garbage() {
  const lines = Array.from({ length: 1 + Math.floor(random() * 80) }, () => {
    const indent = pick(["", "", "", " ", "  ", "   ", "    ", "\t", "  \t"])
    return indent + pick(pieces) + (random() < 0.2 ? pick(pieces) : "")
  })
  return lines.join(pick(["\n", "\n", "\n", "\r\n", "\r"]))
}

const cases: [string, string][] = [
  ...Object.entries(fixed),
  ...Array.from({ length: 3_000 }, (_, index): [string, string] => [`garbage ${index}`, garbage()]),
]

const report: { name: string; ms: number }[] = []
let randomMs = 0
for (const [name, text] of cases) {
  const start = performance.now()
  for (const frontmatter of [true, false]) {
    const found = ConfigInstructionFile.imports(text)
    if (!Array.isArray(found)) throw new Error(`${name}: imports is not a list`)
    if (!Array.isArray(ConfigInstructionFile.sections(text))) throw new Error(`${name}: sections is not a list`)
    if (!Array.isArray(ConfigInstructionFile.section(text, ["Compaction instructions", "x"]))) throw new Error(`${name}: section is not a list`)
    const result = ConfigInstructionFile.parse(text, { frontmatter })
    // Whatever it was given, the text that comes back is a string, and a file that no comment went from is untouched.
    if (typeof result.content !== "string") throw new Error(`${name}: content is not a string`)
    if (!result.stripped && result.content !== text) throw new Error(`${name}: changed text that it reports as unchanged`)
  }
  const ms = performance.now() - start
  if (name.startsWith("garbage")) randomMs += ms
  else report.push({ name, ms: Math.round(ms) })
}
report.push({ name: "3,000 random documents", ms: Math.round(randomMs) })
console.log(JSON.stringify(report))
