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

function escaped(text: string) {
  return text.replace(/\r?\n|\p{C}/gu, (match) => {
    if (match.endsWith("\n")) return "\\n"
    const code = match.codePointAt(0) ?? 0
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`
  })
}
