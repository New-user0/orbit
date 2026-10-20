/**
 * Times the readers of front matter over two kinds of block that a cloned repository could ship, each against a control
 * of letters as long that takes the same path, and prints the times as JSON. It is a script of its own because the work
 * is synchronous: the test starts it with a deadline.
 *
 * - A line whose value starts after a long run of spaces or tabs and holds a character that the line split leaves in it:
 *   a lone CR, U+2028 and U+2029, which a plain `.` does not take, and U+0085, which it does. The YAML fails on the colon
 *   in the value, so the retry of `ConfigMarkdown.sanitize` reads the line, for the row and for its control.
 * - A block with a long run of lines that hold nothing but whitespace, ended by LF, CRLF, a lone CR or U+2028, between
 *   two keys. Each of those starts a line where a reader that looks for comment lines could start again.
 */
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"
import { ConfigMarkdown } from "@orbit/core/config/markdown"

const RUN = 32_000
const LINES = 50_000
const separators: Record<string, string> = { "lone CR": "\r", "U+2028": "\u2028", "U+2029": "\u2029", "U+0085": "\u0085" }
// The key, then the run, then a value with a colon in it, the separator and more text.
const values: Record<string, readonly [string, (run: string, separator: string) => string]> = {
  pathsSpaces: [" ", (run, separator) => `paths: ${run}b: x${separator}c`],
  pathsTabs: ["\t", (run, separator) => `paths:\t${run}b: x${separator}c`],
  descriptionSpaces: [" ", (run, separator) => `description: ${run}b: x${separator}c`],
}
const empty: Record<string, string> = { "LF lines": "\n", "spaced LF lines": " \n", "CRLF lines": "\r\n", "lone CR lines": "\r", "U+2028 lines": "\u2028" }

const files = [
  ...Object.entries(values).flatMap(([shape, [run, make]]) =>
    Object.entries(separators).map(([spelling, separator]) => ({
      name: `${shape} ${spelling}`,
      hostile: `---\n${make(run.repeat(RUN), separator)}\n---\nBody.\n`,
      control: `---\n${make("a".repeat(RUN), "a")}\n---\nBody.\n`,
    })),
  ),
  ...Object.entries(empty).map(([name, line]) => ({
    name,
    hostile: `---\na: b\n${line.repeat(LINES)}paths: c\n---\nBody.\n`,
    control: `---\na: b\nk: ${"x".repeat(line.length * LINES)}\npaths: c\n---\nBody.\n`,
  })),
]
const readers: Record<string, (file: string) => unknown> = {
  rulePatterns: (file) => ConfigInstructionFile.rulePatterns(ConfigMarkdown.split(file).frontmatter),
  parseOption: (file) => ConfigMarkdown.parseOption(file),
}

const timed = (read: () => unknown) => {
  const started = performance.now()
  read()
  return performance.now() - started
}

const report = files.flatMap((file) =>
  Object.entries(readers).map(([reader, read]) => ({
    name: `${reader} ${file.name}`,
    hostile: timed(() => read(file.hostile)),
    control: timed(() => read(file.control)),
  })),
)
console.log(JSON.stringify(report))
