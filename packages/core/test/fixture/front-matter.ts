/**
 * A Markdown file whose front matter is written in JavaScript. It reads as a valid `description` if something
 * evaluates it, and leaves a file at `marker` when that happens. gray-matter evaluates it unless it is told not to,
 * so a test that finds no marker has shown that the reader ran nothing it read.
 */
export const scriptedMarkdown = (marker: string, language = "js") =>
  `---${language}\n{ description: (require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), "from a script") }\n---\nBody.`
