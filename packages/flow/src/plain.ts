// What a workflow, a suite or a run store says is text from a file, and a clone brings its own. It reaches a person
// through the command line, the terminal UI and the titles of the sessions a run opens, so the escaping lives here, where
// the CLI, the TUI and the runner all reach it.

/**
 * Text from a file that is not trusted yet, such as a workflow a clone brings or the run store in its `.orbit`, on one
 * line and without the characters that act on a terminal or on the text around them: control characters, as a carriage
 * return or an escape sequence could overwrite what was printed before it or set the title of the window, and format
 * characters, as a right-to-left override or a zero-width space reorder or hide text. Either could hide a command from
 * the person who is asked to look the file over, and so could a file name that holds one, as a clone can name its files
 * as it likes.
 */
export const plain = (text: string) => escaped(text.trim())

/**
 * A line of what a run says as it goes, which names the nodes, tasks and models that a workflow, a suite or a run store
 * chose, escaped as `plain` does. A line keeps its indentation, which the lines of a team's conversation start with,
 * and takes anything that a workflow passes to `ctx.log`, which is not always text.
 */
export const progress = (line: unknown) => escaped(String(line))

/**
 * `value` as the JSON that a command prints for programs, indented by two spaces. `JSON.stringify` escapes only U+0000 to
 * U+001F, so a string that a file or a run store holds could still carry DEL, a C1 control (U+009B and U+009D start the
 * escape sequences that ESC [ and ESC ] do, on a terminal that takes 8-bit controls) or a format character such as a
 * right-to-left override. Each of those is written as `\uXXXX`, one for every UTF-16 unit, which `JSON.parse` reads
 * back as the character it was, so a program sees the same value.
 */
export function json(value: unknown) {
  // A value with no JSON form, such as a function, has no result from `JSON.stringify` and prints as `undefined`. The
  // line breaks that remain are the indentation, because `JSON.stringify` escapes the ones inside a string.
  return `${JSON.stringify(value, null, 2)}`.replace(/\p{C}/gu, (match) => (match === "\n" ? match : units(match)))
}

/**
 * `value` as one line of JSON, for a program that reads its input line by line, as it reads `orb run --format
 * stream-json`. It writes out what `json` does, and U+2028 and U+2029 as well: `JSON.stringify` leaves those two raw,
 * and a reader written in JavaScript splits a line at either. `JSON.parse` reads the line back as the value it was
 * given.
 */
export function jsonLine(value: unknown) {
  return `${JSON.stringify(value)}`.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, (match) => units(match))
}

function units(text: string) {
  return Array.from(
    { length: text.length },
    (_, index) => `\\u${text.charCodeAt(index).toString(16).padStart(4, "0")}`,
  ).join("")
}

function escaped(text: string) {
  return text.replace(/\r?\n|\p{C}/gu, (match) => {
    if (match.endsWith("\n")) return "\\n"
    const code = match.codePointAt(0) ?? 0
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`
  })
}
