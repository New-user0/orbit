export * as ConfigMarkdown from "./markdown.js"

import matter from "gray-matter"
import { ParsedSize } from "@orbit/util/parsed-size"

// gray-matter evaluates front matter that opens with `---js` or `---javascript` as code, and every Markdown file Orbit
// reads comes through here: the commands, agents, skills and output styles that a cloned repository keeps in its
// `.orbit` directory would run themselves as soon as they were read, before anyone is asked about the folder. Only YAML
// and JSON front matter is read.
//
// `read` finds the block where gray-matter 4 finds it and hands it to gray-matter's YAML engine (js-yaml with its safe
// schema) or to `JSON.parse`, and to nothing else. It does not call gray-matter's own reader, which first asks whether
// the block is only comments with an expression that reads from each line start in a run of blank lines to the end of
// the run, so that a block of 100 KB of empty lines held each read for seconds. gray-matter also keeps a parse by content
// when it is given no options, a parse that failed included; `read` keeps nothing.
const yaml = (matter as unknown as { readonly engines: { readonly yaml: { readonly parse: (text: string) => unknown } } })
  .engines.yaml.parse

// `indicators` adds a last retry that also reads a value holding a YAML indicator as text. It comes after the first, so a
// file that already parsed through `sanitize` parses as it did, and only a reader that asks for it (the `paths` of a rule)
// accepts what the others still refuse. The retries are for a block that YAML refuses: one that YAML reads and that comes
// to more than its text (`Oversized`) is refused as it stands, because read again as text its aliases would become
// values that nobody wrote.
export function parse(content: string, indicators = false) {
  try {
    return read(content)
  } catch (error) {
    if (error instanceof Oversized) throw error
  }
  if (!indicators) return read(sanitize(content))
  try {
    return read(sanitize(content))
  } catch (error) {
    if (error instanceof Oversized) throw error
    return read(sanitize(content, true))
  }
}

// The front matter of a file and the text after it, as gray-matter 4 reads them: an opening line of three dashes and
// then a language or nothing (a fourth dash makes it no opener), and a block that runs to the first LF followed by three
// dashes, or to the end. A block that a YAML scalar or list fills comes back as that value, as it did through gray-matter.
function read(input: string): { readonly data: Readonly<Record<string, unknown>>; readonly content: string } {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input
  if (!text.startsWith("---") || text[3] === "-") return { data: {}, content: text }
  const after = text.slice(3)
  // gray-matter cuts the opening line one character short when the file has no line break.
  const opening = after.slice(0, after.search(/\r?\n/))
  const language = opening.trim()
  const rest = language === "" ? after : after.slice(opening.length)
  const close = rest.indexOf("\n---")
  const block = close === -1 ? rest : rest.slice(0, close)
  const data = onlyComments(block) ? undefined : engine(language)(block)
  // The readers copy, check and serialize what they are handed, and an alias makes them pay again for what its anchor
  // names, so a block whose value comes to more than its text spells is refused here, once, for all of them.
  if (!ParsedSize.within(data, block.length + ParsedSize.MARGIN)) throw new Oversized()
  return {
    data: (data ?? {}) as Readonly<Record<string, unknown>>,
    content: close === -1 ? "" : rest.slice(close + 4).replace(/^\r?\n?/, ""),
  }
}

/** What `parse` throws for a block whose value comes to more than its text once its aliases are followed (`ParsedSize`). */
export class Oversized extends Error {
  constructor() {
    super(
      `Front matter that comes to more than its text once its aliases are followed, or that nests more than ${ParsedSize.DEPTH} levels deep, is not read`,
    )
  }
}

function engine(language: string): (block: string) => unknown {
  const name = language.toLowerCase()
  if (language === "" || name === "yaml" || name === "yml") return yaml
  if (language === "json") return (block) => JSON.parse(block)
  if (name === "js" || name === "javascript") throw new Error("JavaScript front matter is not supported")
  throw new Error(`Front matter in ${language} is not supported`)
}

// Whether gray-matter would take the block for empty: nothing but whitespace once each comment is gone. A comment is a
// `#` that only whitespace and earlier comments come before, with a character after it that is not LF, and it runs to
// the next LF, over a CR, U+2028 or U+2029. The block is read once.
function onlyComments(block: string) {
  let comment = false
  for (let at = 0; at < block.length; at++) {
    const char = block[at]!
    if (char === "\n") comment = false
    else if (comment || /\s/.test(char)) continue
    else if (char === "#" && at + 1 < block.length && block[at + 1] !== "\n") comment = true
    else return false
  }
  return true
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
    // The block is split at LF and CRLF, so a line can still hold a lone CR, U+2028 or U+2029, which a plain `.` does not
    // take. With the `s` flag the value runs to the end of the line, whatever it holds. Without it `$` fails at such a
    // character, and the engine starts the value again after each shorter run of the spaces that follow the colon, which
    // costs the square of the run's length (`front-matter-line-stress.ts`).
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/s)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":") && !(indicators && INDICATOR.test(value))) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
