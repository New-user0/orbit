/**
 * Runs `ConfigInstructionFile.parse` over inputs that a cloned repository could ship, and prints how long each took as
 * JSON; the line separator rows at the end also carry the time of each reader and of its control. It is a script of its
 * own because the work is synchronous: a loop that never ends cannot be cut short from the process that runs it, so the
 * test starts this one with a deadline. It exits with an error when `parse` throws.
 */
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"

const fixed = (k: number): Record<string, string> => ({
  stars: `${"*".repeat(200_000 * k)}<!-- c -->`,
  underscores: `${"_a ".repeat(70_000 * k)}\n\n<!-- c -->`,
  nestedQuotes: `${"> ".repeat(100_000 * k)}x\n\n<!-- c -->`,
  nestedList: `${"- ".repeat(100_000 * k)}x\n<!-- c -->`,
  nestedOrdered: `${"1. ".repeat(60_000 * k)}x\n<!-- c -->`,
  openers: "<!--\n".repeat(50_000 * k),
  openersAndOneClose: `${"<!--\n".repeat(50_000 * k)}-->`,
  closeThenOpeners: `-->\n${"<!--\n".repeat(50_000 * k)}`,
  manyComments: "<!-- x -->\n\n".repeat(50_000 * k),
  manyCommentsTight: "text\n<!-- x -->\n".repeat(50_000 * k),
  listThenParagraph: `- a\n${"text\n".repeat(100_000 * k)}<!-- c -->\n`,
  longItem: `- a\n${"  b\n".repeat(100_000 * k)}<!-- c -->\n`,
  longItemWithBlanks: `- a\n${"\n  b\n".repeat(50_000 * k)}<!-- c -->\n`,
  ticks: `${"`".repeat(200_000 * k)}\n<!-- c -->`,
  fences: `${"```\n".repeat(50_000 * k)}<!-- c -->`,
  unclosedFence: `\`\`\`\n${"x\n".repeat(100_000 * k)}<!-- c -->`,
  longLine: `${"a ".repeat(500_000 * k)}\n<!-- c -->`,
  longTag: `<a ${"x ".repeat(100_000 * k)}>\n<!-- c -->`,
  manyBlankLines: `${"\n".repeat(500_000 * k)}<!-- c -->`,
  tabs: `${"\t".repeat(200_000 * k)}<!-- c -->`,
  lazyQuote: `> a\n${"text\n".repeat(100_000 * k)}<!-- c -->`,
  quoteLadder: `${Array.from({ length: 3_000 * k }, (_, index) => `${"> ".repeat(index % 100)}x`).join("\n")}\n<!-- c -->`,
  dashes: `${"-".repeat(300_000 * k)}\n<!-- c -->`,
  breaks: `${"- - - - - - -\n".repeat(30_000 * k)}<!-- c -->`,
  items: `${"- a\n".repeat(100_000 * k)}<!-- c -->`,
  crlf: "text\r\n<!-- c -->\r\n".repeat(50_000 * k),
  frontMatterNeverCloses: `---\n${"a: b\n".repeat(100_000 * k)}`,
  frontMatterDelimiterLookalikes: `---\n${"--- x\n".repeat(100_000 * k)}`,
  atSigns: "@".repeat(100_000 * k),
  atSignsSpaced: "@ ".repeat(100_000 * k),
  atTokens: "@a ".repeat(100_000 * k),
  atTokensEscaped: "@a\\ b ".repeat(60_000 * k),
  unclosedSpans: Array.from({ length: 800 * k }, (_, index) => `${"`".repeat((index % 800) + 1)} @./a.md`).join("\n"),
  alternatingSpans: "` `` ``` ".repeat(30_000 * k),
  tagsOpen: "<a ".repeat(100_000 * k),
  tagsMany: "<b>@./a.md</b> ".repeat(30_000 * k),
  linkTargetsOpen: "[x](".repeat(60_000 * k),
  imagesOpen: "![x ".repeat(60_000 * k),
  commentsOpen: "text <!-- @./a.md ".repeat(30_000 * k),
  longListItem: `- ${"@./a.md ".repeat(60_000 * k)}`,
  deepListAt: `${"- ".repeat(100_000 * k)}@./a.md`,
  deepQuoteAt: `${">".repeat(100_000 * k)} @./a.md`,
  bracketsAt: "[@./a.md".repeat(50_000 * k),
  headings: "# Compaction instructions\nx\n".repeat(100_000 * k),
  backtickRun: "`".repeat(1_000_000 * k),
  alternatingFences: "```\n~~~\n".repeat(50_000 * k),
  oneMegabyteLine: `# ${"a ".repeat(500_000 * k)}`,
  headingLadder: Array.from({ length: 100_000 * k }, (_, index) => `${"#".repeat((index % 6) + 1)} Compaction instructions`).join("\n"),
  blankThenText: `# Compaction instructions\n${"\n ".repeat(200_000 * k)}x`,
  frontMatterAndComments:`---\n${"a: b\n".repeat(1_000 * k)}---\n${"<!-- x -->\n\n".repeat(20_000 * k)}`,
})

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
  "\u2029", "\u0085", "```` \u2028x", "~~~\u2029", "-   \u2028x", "1.\t\u2029x",
]

function garbage() {
  const lines = Array.from({ length: 1 + Math.floor(random() * 80) }, () => {
    const indent = pick(["", "", "", " ", "  ", "   ", "    ", "\t", "  \t"])
    return indent + pick(pieces) + (random() < 0.2 ? pick(pieces) : "")
  })
  return lines.join(pick(["\n", "\n", "\n", "\r\n", "\r"]))
}

const cases: [string, string][] = [
  ...Object.entries(fixed(1)),
  ...Array.from({ length: 3_000 }, (_, index): [string, string] => [`garbage ${index}`, garbage()]),
]

// Every time here is CPU time of this process, not wall-clock time. A loaded runner takes the CPU away from a process in
// slices: a read of 10 ms usually fits in one and a read of 100 ms does not, so the wall-clock time of the larger one grows
// by more than its size and a linear parser looks super-linear.
const cpuMs = () => {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}

type Row = {
  name: string
  ms: number
  // The same case at a quarter of its size, and whether the full read took more than a linear parser can.
  smallMs?: number
  superlinear?: boolean
  readers?: Record<string, { readonly hostile: number; readonly control: number }>
}

// Reads one document with every reader and returns how long that took.
function readAll(name: string, text: string) {
  const start = cpuMs()
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
  return cpuMs() - start
}

// Growth, not a time bound: a loaded runner makes every case slower, and only a parser whose cost grows faster than its
// input is wrong. Each fixed case is read at a quarter of its size first and then at its size. A linear parser takes about four times
// as long for the second read; a quadratic one takes sixteen times as long. A case is super-linear when the full read takes
// more than GROWTH_LIMIT times the small read, which a floor keeps from judging a case of a few milliseconds by timer
// noise: Windows counts process CPU time in ticks of about 16 ms, so a read of 30 ms can report 16. The small read goes first so that the full one is not the one that pays for warming up, and a pair that looks
// super-linear is measured again, up to twice, with the best time of each size counting, so one pause of a loaded runner
// does not decide.
const GROWTH_LIMIT = 8
const FLOOR_MS = 50
const quarter = fixed(0.25)

function growth(name: string, text: string, smaller: string) {
  let small = readAll(name, smaller)
  let large = readAll(name, text)
  for (let again = 0; again < 2 && large > GROWTH_LIMIT * Math.max(small, FLOOR_MS); again++) {
    small = Math.min(small, readAll(name, smaller))
    large = Math.min(large, readAll(name, text))
  }
  return { smallMs: Math.round(small), ms: Math.round(large), superlinear: large > GROWTH_LIMIT * Math.max(small, FLOOR_MS) }
}

const report: Row[] = []
let randomMs = 0
for (const [name, text] of cases) {
  if (name.startsWith("garbage")) {
    randomMs += readAll(name, text)
    continue
  }
  report.push({ name, ...growth(name, text, quarter[name]!) })
}
report.push({ name: "3,000 random documents", ms: Math.round(randomMs) })

// A line of 64 KB that starts the way a fence or a list item does, with a long run of markers or of spaces, and then holds
// a character that the scanners do not split lines at: U+2028 and U+2029, which a plain `.` stops at, and U+0085, which it
// takes. A lone CR is split at, so its rows are controls of the split. Each reader is timed over the row and over a
// control of the same length in letters, in files that also hold comments, so that `parse` walks the comment blocks.
const separators: Record<string, string> = { "U+2028": "\u2028", "U+2029": "\u2029", "lone CR": "\r", "U+0085": "\u0085" }
const lines: Record<string, (separator: string) => string> = {
  backtickFence: (separator) => `${"`".repeat(32_000)}${"a".repeat(32_000)}${separator}z`,
  tildeFence: (separator) => `${"~".repeat(32_000)}${"a".repeat(32_000)}${separator}z`,
  quotedFence: (separator) => `> ${"`".repeat(32_000)}${"a".repeat(32_000)}${separator}z`,
  bullet: (separator) => `- ${" ".repeat(64_000)}a${separator}z`,
  orderedTabs: (separator) => `1.${"\t".repeat(64_000)}a${separator}z`,
  fenceInItem: (separator) => `- ${"~".repeat(32_000)}${"a".repeat(32_000)}${separator}z`,
}
const readers: Record<string, (text: string) => unknown> = {
  parse: (text) => ConfigInstructionFile.parse(text, { frontmatter: true }),
  sections: (text) => ConfigInstructionFile.sections(text),
  imports: (text) => ConfigInstructionFile.imports(text),
}
const timed = (read: () => unknown) => {
  const start = cpuMs()
  read()
  return Math.round(cpuMs() - start)
}
const withComments = (line: string) => `# a\n<!-- c -->\n${line}\n<!-- d -->\n`
for (const [shape, make] of Object.entries(lines))
  for (const [spelling, separator] of Object.entries(separators)) {
    const line = make(separator)
    const times = Object.fromEntries(
      Object.entries(readers).map(([name, read]) => [
        name,
        { hostile: timed(() => read(withComments(line))), control: timed(() => read(withComments("a".repeat(line.length)))) },
      ]),
    )
    const ms = Object.values(times).reduce((sum, item) => sum + item.hostile, 0)
    report.push({ name: `${shape} ${spelling}`, ms, readers: times })
  }
console.log(JSON.stringify(report))
