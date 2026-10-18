// The text rules for Orbit's own reminder envelope, shared by the core that lowers messages and by the clients that
// send editor context. A client may not import core, so the rules that decide what can spell an envelope live here.

export const TAG = /<(?=\s*\/?\s*system\s*-\s*(?:reminder|update))/gi

/**
 * Rewrites every look-alike of an Orbit envelope tag (`system-reminder`, `system-update`; opening or closing, any
 * letter case, whitespace inside the brackets, attributes) by escaping its opening bracket. Every other byte is left
 * alone, and the same input always gives the same output, so lowering stays byte-stable.
 */
export const neutralize = (text: string) => text.replace(TAG, "&lt;")

/** Neutralizes a name or path that becomes a heading: line breaks and control characters go too. */
export const heading = (value: string) => neutralize(value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim())

/**
 * A labelled block of outside text (a file, a tool, an editor). The fence is longer than any run of backticks inside,
 * so the content cannot close it, and look-alike tags in it are escaped.
 */
export const block = (label: string, content: string) => {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${heading(label)}:\n${fence}\n${neutralize(content)}\n${fence}`
}

/** The envelope around harness-written text. Outside text never goes in `text`; it follows as `block`s. */
export const envelope = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`
