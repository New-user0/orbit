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

export function parse(content: string) {
  try {
    return matter(content, options)
  } catch {
    return matter(sanitize(content), options)
  }
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
