export * as ConfigMarkdown from "./markdown.js"

import matter from "gray-matter"

// gray-matter evaluates front matter that opens with `---js` or `---javascript` as code, and every Markdown file Orbit
// reads comes through here: the commands, agents, skills and output styles that a cloned repository keeps in its
// `.orbit` directory would run themselves as soon as they were read, before anyone is asked about the folder. Only YAML
// and JSON front matter is read. Passing options also bypasses gray-matter's cache, which is keyed by content and keeps
// a parse that failed as if it had worked, so a file that needed `sanitize` read back empty the second time.
const options = {
  engines: {
    javascript: () => {
      throw new Error("JavaScript front matter is not supported")
    },
  },
}

// `indicators` adds a last retry that also reads a value holding a YAML indicator as text. It comes after the first, so a
// file that already parsed through `sanitize` parses as it did, and only a reader that asks for it (the `paths` of a rule)
// accepts what the others still refuse.
export function parse(content: string, indicators = false) {
  try {
    return matter(content, options)
  } catch {
    if (!indicators) return matter(sanitize(content), options)
    try {
      return matter(sanitize(content), options)
    } catch {
      return matter(sanitize(content, true), options)
    }
  }
}

export function parseOption(content: string, indicators = false) {
  try {
    return parse(content, indicators)
  } catch {
    return undefined
  }
}

/**
 * Where a file's front matter ends, found from its delimiter lines alone: nothing is parsed, so nothing can be evaluated,
 * whatever the block says. The first line must be exactly three dashes, with spaces or tabs allowed after them, and the
 * block ends at the next line that is exactly that too. An opener with a language after it (`---js`, `--- js`), four
 * dashes, a delimiter on any line but the first, and an opener that is never closed are not front matter, and the text
 * comes back whole as `body`. `frontmatter` holds the block with both delimiter lines, so that `parseOption` can read it.
 */
export function split(text: string): { readonly frontmatter?: string; readonly body: string } {
  // A delimiter line is three dashes and nothing else but spaces, tabs and the carriage return of a CRLF line. The lines
  // are walked with `indexOf` and a sticky match, so a file that never closes its block costs one pass and no backtracking.
  const opening = /^---[ \t]*\r?\n/.exec(text)
  if (!opening) return { body: text }
  const closing = /---[ \t]*\r?(?:\n|$)/y
  for (let line = opening[0].length; line < text.length; ) {
    closing.lastIndex = line
    const delimiter = closing.exec(text)
    if (delimiter) {
      const end = line + delimiter[0].length
      return { frontmatter: text.slice(0, end), body: text.slice(end) }
    }
    const newline = text.indexOf("\n", line)
    if (newline === -1) break
    line = newline + 1
  }
  return { body: text }
}

// The characters YAML 1.2 reserves to start a node (section 5.3), which a plain value may not open with: the flow
// brackets, the brace pair, `*`, `&`, `#`, `!`, `|`, `>`, `%`, `@` and the backtick.
const INDICATOR = /[[\]{}*&#!|>%@`]/

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working. With `indicators`, a value that holds one of
// the YAML indicator characters is read as text too, so `paths: **/*.ts` is a string and not an alias. List items are
// left as written.
export function sanitize(content: string, indicators = false) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":") && !(indicators && INDICATOR.test(value))) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
