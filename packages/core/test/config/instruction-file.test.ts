import fs from "fs/promises"
import path from "path"
import matter from "gray-matter"
import { describe, expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { AbsolutePath } from "@orbit/core/schema"
import { Directory, Document, Info, type Entry } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { scriptedMarkdown } from "../fixture/front-matter"
import { canLinkFile } from "../fixture/symlink"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

const parse = (text: string, frontmatter = false) => ConfigInstructionFile.parse(text, { frontmatter })

// Each row is an instruction file and what the model reads of it. A row that keeps its input says that nothing was taken
// off, and `stripped` is false for it.
describe("ConfigInstructionFile.parse, HTML comments", () => {
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    // A comment that stands alone at the top level of the document goes, and the text around it closes up.
    ["on its own line between headings", "# Title\n\n<!-- c -->\n\nBody\n", "# Title\n\nBody\n"],
    ["on its own line between paragraphs", "para one\n\n<!-- c -->\n\npara two\n", "para one\n\npara two\n"],
    ["directly under a paragraph line, which a comment may interrupt", "para line\n<!-- c -->\nnext line\n", "para line\nnext line\n"],
    ["directly under a paragraph with a blank line after it", "para line\n<!-- c -->\n\nnext\n", "para line\n\nnext\n"],
    ["indented by one to three spaces", "text\n\n   <!-- c -->\n\nmore\n", "text\n\nmore\n"],
    ["directly under a heading", "# Title\n<!-- c -->\nBody\n", "# Title\nBody\n"],
    ["spread over several lines", "a\n\n<!--\nmulti\nline\n-->\n\nb\n", "a\n\nb\n"],
    ["two comments on one line and nothing else", "<!-- a --><!-- b -->\n\nb\n", "b\n"],
    ["at the start of the file", "<!-- c -->\n\n# Title\n", "# Title\n"],
    ["at the end, with no final newline", "a\n\n<!-- c -->", "a"],
    ["at the end, with a final newline", "a\n\n<!-- c -->\n", "a\n"],
    ["after blank lines at the end", "A\n\n\n<!-- c -->\n\n\n", "A\n"],
    ["one after another", "a\n\n<!-- 1 -->\n\n<!-- 2 -->\n\nb\n", "a\n\nb\n"],
    ["one after another with no blank lines", "a\n<!-- 1 -->\n<!-- 2 -->\nb\n", "a\nb\n"],
    ["ending a list, where it starts in the first column", "- item\n<!-- c -->\n\nafter\n", "- item\n\nafter\n"],
    ["ending a list after a blank line", "- item\n\n<!-- c -->\n\nafter\n", "- item\n\nafter\n"],
    ["after a list item and a line that goes on with it", "- item\ntext\n<!-- c -->\nafter\n", "- item\ntext\nafter\n"],
    ["after a tag in a paragraph, which does not start a block there", "text\n<br>\n<!-- c -->\n", "text\n<br>\n"],
    ["after an indented block tag in a paragraph, which goes on with it", "text\n  <div>\n<!-- c -->\n", "text\n  <div>\n"],
    ["indented less than the text of a numbered item", "1. item\n\n  <!-- c -->\n", "1. item\n"],
    ["after an empty item and a blank line, which end the item", "-\n\n   <!-- c -->\n", "-\n"],
    ["after a quote, once a blank line ends it", "> note\n\n<!-- c -->\n", "> note\n"],
    ["after a quote, in the first column, which cannot go on with it", "> note\n<!-- c -->\nafter\n", "> note\nafter\n"],
    ["after an HTML block that a blank line closed", "<div>\ntext\n</div>\n\n<!-- c -->\n\nafter\n", "<div>\ntext\n</div>\n\nafter\n"],
    ["after the blank line of a details block", "<details>\n<summary>x</summary>\n\n<!-- c -->\n\ntext\n</details>\n", "<details>\n<summary>x</summary>\n\ntext\n</details>\n"],
    ["after the fence that closed a list item's code", "- item\n  ```\n  <!-- c -->\n  ```\n\n<!-- d -->\n\nafter\n", "- item\n  ```\n  <!-- c -->\n  ```\n\nafter\n"],
    ["under a line of a heading with its underline above", "Title\n=====\n<!-- c -->\n\nBody\n", "Title\n=====\n\nBody\n"],
    ["with spaces after it and nothing else", "<!-- c -->   \n\nText\n", "Text\n"],
    ["empty", "<!---->\ntext\n", "text\n"],
    // Text on the line of the closing marker is the comment's block, and stays, with the space before it.
    ["with text after the closing marker", "<!-- c --> trailing text\n\nb\n", " trailing text\n\nb\n"],
    ["spread over lines, with text after the closing marker", "<!--\nx\n--> tail\n\nz\n", " tail\n\nz\n"],

    // Anything that is not a block of its own at the top level stays. Where the lexer that the reference uses reads a line
    // otherwise than CommonMark does, the rows follow the lexer: a comment indented under a paragraph line is more of the
    // paragraph, and so is one that a quote's next line goes on with.
    ["in a fenced block of backticks", "```\n<!-- c -->\n```\n", "```\n<!-- c -->\n```\n"],
    ["in a fenced block of tildes", "~~~\n<!-- c -->\n~~~\n", "~~~\n<!-- c -->\n~~~\n"],
    ["in a fence that a shorter line of the same character does not close", "````\n```\n<!-- c -->\n````\n", "````\n```\n<!-- c -->\n````\n"],
    ["in a fence with no end", "```\n<!-- c -->\n", "```\n<!-- c -->\n"],
    ["in a fence inside a list item", "- item\n  ```\n  <!-- c -->\n  ```\n", "- item\n  ```\n  <!-- c -->\n  ```\n"],
    ["in an inline code span", "text `<!-- c -->` text\n", "text `<!-- c -->` text\n"],
    ["in the middle of a sentence", "text <!-- x --> text\n", "text <!-- x --> text\n"],
    ["in a line that starts with a bullet", "- <!-- c -->\n", "- <!-- c -->\n"],
    ["indented by four spaces after a blank line, which is code", "text\n\n    <!-- c -->\n\nmore\n", "text\n\n    <!-- c -->\n\nmore\n"],
    ["indented by a tab after a blank line, which is code", "text\n\n\t<!-- c -->\n", "text\n\n\t<!-- c -->\n"],
    ["indented by four spaces at the start of the file, which is code", "    <!-- c -->\n\ntext\n", "    <!-- c -->\n\ntext\n"],
    ["indented by four spaces under a paragraph line, which goes on with it", "text\n    <!-- c -->\nmore\n", "text\n    <!-- c -->\nmore\n"],
    ["indented by one to three spaces under a paragraph line, which goes on with it", "text\n  <!-- c -->\nmore\n", "text\n  <!-- c -->\nmore\n"],
    ["in the text of a list item, indented under it", "- item\n\n  <!-- c -->\n\n- two\n", "- item\n\n  <!-- c -->\n\n- two\n"],
    ["in the text of a nested list item", "- a\n  - b\n    <!-- c -->\n", "- a\n  - b\n    <!-- c -->\n"],
    ["in the text of a numbered item", "1. item\n\n   <!-- c -->\n", "1. item\n\n   <!-- c -->\n"],
    ["in a quote", "> <!-- c -->\n\nafter\n", "> <!-- c -->\n\nafter\n"],
    ["in a quote that the next line goes on with", "> note\n  <!-- c -->\nafter\n", "> note\n  <!-- c -->\nafter\n"],
    ["in another HTML block", "<div>\n<!-- c -->\n</div>\n\nafter\n", "<div>\n<!-- c -->\n</div>\n\nafter\n"],
    ["in a pre block", "<pre>\n<!-- c -->\n</pre>\n\nafter <!-- x -->\n", "<pre>\n<!-- c -->\n</pre>\n\nafter <!-- x -->\n"],
    ["in a pre block that only a pre end tag closes", "<pre>\n</style>\n<!-- c -->\n", "<pre>\n</style>\n<!-- c -->\n"],
    ["in a script block", "<script>\n<!-- c -->\n</script>\n", "<script>\n<!-- c -->\n</script>\n"],
    ["in a block of a tag that stands alone", "<custom-tag>\n<!-- c -->\n", "<custom-tag>\n<!-- c -->\n"],
    ["in the block of a block tag that interrupts a paragraph from the first column", "text\n<div>\n<!-- c -->\n", "text\n<div>\n<!-- c -->\n"],
    // The lexer that the reference uses ends a list item at any line that opens with a tag, and a tag that stands alone then
    // starts an HTML block of its own, which holds the comment after it. CommonMark reads the tag as more of the item.
    ["in the block of a tag that ended a list item", "- item\n<br>\n<!-- c -->\n", "- item\n<br>\n<!-- c -->\n"],
    ["with an opening marker and no closing one anywhere", "a\n\n<!-- never closed\n\nb\n", "a\n\n<!-- never closed\n\nb\n"],
    ["whose closing marker is part of its opening one", "<!-->\ntext\n", "<!-->\ntext\n"],
  ]

  test.each(rows)("%s", (_name, input, output) => {
    const result = parse(input)
    expect(result.content).toBe(output)
    expect(result.stripped).toBe(output !== input)
  })

  test("returns a body with no comment marker as it is, line endings included", () => {
    const text = "# Title\r\n\r\n- item\r\n  text\r\n\r\n```\r\ncode\r\n```\r\n"
    expect(parse(text)).toEqual({ content: text, stripped: false })
    expect(parse("a\r\n\r\nb")).toEqual({ content: "a\r\n\r\nb", stripped: false })
  })

  test("returns a file whose comments all stay as it is, line endings included", () => {
    const text = "```\r\n<!-- c -->\r\n```\r\n"
    expect(parse(text)).toEqual({ content: text, stripped: false })
  })

  // A comment that goes leaves LF line endings, which is what the lexer that the reference uses gives.
  test("writes LF line endings when a comment goes", () => {
    expect(parse("a\r\n\r\n<!-- c -->\r\n\r\nb\r\n")).toEqual({ content: "a\n\nb\n", stripped: true })
  })

  test("leaves nothing of a file that holds only comments", () => {
    for (const text of ["<!-- c -->", "<!-- a -->\n\n<!-- b -->\n", "\n<!--\nx\n-->\n\n\n", "<!-- a --><!-- b -->  \n"])
      expect(parse(text).content.trim()).toBe("")
  })

  test("does not touch a document that has no comment block of its own, however many markers it has", () => {
    const text = "text `<!--` and `-->` and <!-- x --> y\n\n```\n<!--\n```\n"
    expect(parse(text)).toEqual({ content: text, stripped: false })
  })
})

describe("ConfigInstructionFile.parse, front matter", () => {
  test("removes a block of front matter from any file, with the blank lines after it", () => {
    expect(parse("---\ntitle: x\n---\n# Body\n", true)).toEqual({ content: "# Body\n", stripped: true })
    expect(parse("---\ntitle: x\n---\n\n\n# Body\n", true)).toEqual({ content: "# Body\n", stripped: true })
    expect(parse("---\n---\nBody", true)).toEqual({ content: "Body", stripped: true })
    expect(parse("---\ntitle: x\n---", true)).toEqual({ content: "", stripped: true })
  })

  test("removes a block with CRLF line endings and spaces after the dashes, and keeps the line endings of the rest", () => {
    expect(parse("---\r\ntitle: x\r\n---\r\n\r\n# Body\r\n", true)).toEqual({ content: "# Body\r\n", stripped: true })
    expect(parse("--- \t\ntitle: x\n---  \n# Body\n", true)).toEqual({ content: "# Body\n", stripped: true })
  })

  test("removes a block whether or not its contents could be read", () => {
    for (const block of ["key: [unclosed", "a: b: c: d", ": : :", "- - -\n\t\tx", "\u0000\u0001", "metadata: [\n"])
      expect(parse(`---\n${block}\n---\n# Body\n`, true)).toEqual({ content: "# Body\n", stripped: true })
  })

  test("keeps the text whole when the opening line has more than three dashes, or anything after them", () => {
    for (const opener of ["---js", "--- js", "---yaml", "---coffee", "---javascript", "----", "-----", "---x", "-- -"]) {
      const text = `${opener}\ntitle: x\n---\n# Body\n`
      expect(parse(text, true)).toEqual({ content: text, stripped: false })
    }
  })

  test("keeps the text whole when the block never closes, or closes in the middle of a line", () => {
    for (const text of [
      "---\ntitle: x\n# Body\n",
      "---\ntitle: x---\nBody\n",
      "---\nkey: a --- b\nBody\n",
      "---\ntitle: x\n----\nBody\n",
      "---\ntitle: x\n--- done\nBody\n",
      "---\n",
      "---",
    ])
      expect(parse(text, true)).toEqual({ content: text, stripped: false })
  })

  test("keeps the text whole when the delimiter is not on the first line", () => {
    for (const text of ["\n---\ntitle: x\n---\nBody\n", " ---\ntitle: x\n---\nBody\n", "# Title\n---\ntitle: x\n---\nBody\n"])
      expect(parse(text, true)).toEqual({ content: text, stripped: false })
  })

  test("ends the block at the first closing line, and leaves a later delimiter in the text", () => {
    expect(parse("---\na: b\n---\nBody\n---\nmore\n", true).content).toBe("Body\n---\nmore\n")
  })

  // The reference does the same: a document that opens with a horizontal rule and has another one loses what is between.
  test("removes the text between two horizontal rules at the top of a file", () => {
    expect(parse("---\nSome prose.\n---\nBody\n", true).content).toBe("Body\n")
  })

  test("takes a comment inside the front matter away with the block, and one after the block off the text", () => {
    expect(parse("---\n# <!-- not a comment of the body\ntitle: x\n---\n<!-- c -->\n\nBody\n", true).content).toBe("Body\n")
    expect(parse("---\ntitle: x\n---\nBody\n<!-- c -->\nmore\n", true)).toEqual({ content: "Body\nmore\n", stripped: true })
  })

  test("leaves front matter in the text unless it is asked to remove it", () => {
    const text = "---\ntitle: x\n---\nBody\n"
    expect(parse(text)).toEqual({ content: text, stripped: false })
    expect(ConfigInstructionFile.parse(text, { frontmatter: false })).toEqual({ content: text, stripped: false })
    expect(ConfigInstructionFile.parse(text)).toEqual({ content: text, stripped: false })
  })

  test("leaves nothing of a file that holds only front matter", () => {
    expect(parse("---\ntitle: x\n---\n", true).content).toBe("")
  })
})

// An instruction file meets front matter handling, which is a reader of the kind that gray-matter evaluates. The block is
// found by its delimiter lines alone and is never parsed, so nothing it says can run. A language after the opening dashes
// makes the line something else than a delimiter, and the text is kept as it was written, as the reference keeps it.
describe("ConfigInstructionFile.parse runs nothing it reads", () => {
  const spellings = ["js", "javascript", "JS", "JavaScript", " js", "coffee"]
  const ran = (marker: string) => Bun.file(marker).exists()

  for (const language of spellings) {
    test(`keeps front matter that opens with ---${language} as text, and writes no marker`, async () => {
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "ran")
      const text = scriptedMarkdown(marker, language)
      expect(ConfigInstructionFile.parse(text, { frontmatter: true })).toEqual({ content: text, stripped: false })
      expect(await ran(marker)).toBe(false)
    })
  }

  // The control: a parser that evaluates it, which Orbit does not use for these files, does run the file.
  for (const language of ["js", "javascript", "JS", "JavaScript", " js"]) {
    test(`the unprotected parser runs ---${language}, so the file is live`, async () => {
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "ran")
      matter(scriptedMarkdown(marker, language))
      expect(await ran(marker)).toBe(true)
    })
  }

  test("removes a block with CRLF line endings that holds a script, and writes no marker", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "ran")
    const script = `{ description: (require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), "x") }`
    const result = ConfigInstructionFile.parse(`---\r\n${script}\r\n---\r\nBody.\r\n`, { frontmatter: true })
    expect(result).toEqual({ content: "Body.\r\n", stripped: true })
    expect(await ran(marker)).toBe(false)
  })

  test("removes a bare block that holds a function tag, and writes no marker", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "ran")
    const block = `fn: !!js/function >\n  function () { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran") }`
    expect(ConfigInstructionFile.parse(`---\n${block}\n---\nBody.\n`, { frontmatter: true })).toEqual({
      content: "Body.\n",
      stripped: true,
    })
    expect(await ran(marker)).toBe(false)
  })
})

describe("ConfigInstructionFile.names", () => {
  test("lists the names that both loaders look for, and the other product's only while compatibility is on", () => {
    expect(ConfigInstructionFile.names(false)).toEqual(["ORBIT.md", "AGENTS.md"])
    expect(ConfigInstructionFile.names(true)).toEqual(["ORBIT.md", "AGENTS.md", CompatNames.vendor.instructions])
  })
})

describe("ConfigInstructionFile size", () => {
  test("flags a file over 40,000 characters and no file up to it", () => {
    expect(ConfigInstructionFile.LIMIT).toBe(40_000)
    expect(ConfigInstructionFile.oversized("x".repeat(40_000))).toBe(false)
    expect(ConfigInstructionFile.oversized("x".repeat(40_001))).toBe(true)
    expect(ConfigInstructionFile.oversized("")).toBe(false)
  })

  test("counts the characters that the string counts", () => {
    // Each of these is two UTF-16 code units, as a string counts them.
    expect(ConfigInstructionFile.oversized("\u{1F600}".repeat(20_000))).toBe(false)
    expect(ConfigInstructionFile.oversized("\u{1F600}".repeat(20_001))).toBe(true)
  })

  test("measures the text that is left, so that comments and front matter do not count", () => {
    const raw = `---\n${"k: v\n".repeat(2_000)}---\n<!--\n${"c".repeat(20_000)}\n-->\n\n${"x".repeat(30_000)}\n`
    expect(raw.length).toBeGreaterThan(40_000)
    const result = ConfigInstructionFile.parse(raw, { frontmatter: true })
    expect(result.content).toBe(`${"x".repeat(30_000)}\n`)
    expect(ConfigInstructionFile.oversized(result.content)).toBe(false)
  })

  test("never cuts a large file", () => {
    const text = `# Rules\n${"line of text\n".repeat(5_000)}`
    expect(text.length).toBeGreaterThan(40_000)
    expect(ConfigInstructionFile.parse(text, { frontmatter: true })).toEqual({ content: text, stripped: false })
  })
})

const document = (info: ConstructorParameters<typeof Info>[0], scope: Document["scope"] = "user") =>
  new Document({ type: "document", scope, info: new Info(info) })

describe("ConfigInstructionFile.excludes", () => {
  test("adds up the lists of every document, in order and without repeats", () => {
    const entries: Entry[] = [
      document({ instructions_exclude: ["**/a/**", "/b/AGENTS.md"] }, "user"),
      document({ shell: "sh" }, "project"),
      new Directory({ type: "directory", path: AbsolutePath.make(path.resolve("/x/.orbit")), scope: "project" }),
      document({ instructions_exclude: ["/b/AGENTS.md", "**/c/**"] }, "project"),
      document({ instructions_exclude: [] }, "local"),
      document({ instructions_exclude: ["**/a/**"] }, "flag"),
      document({ instructions_exclude: ["**/d/**"] }, "managed"),
    ]
    expect(ConfigInstructionFile.excludes(entries)).toEqual(["**/a/**", "/b/AGENTS.md", "**/c/**", "**/d/**"])
  })

  test("is empty when no document sets it", () => {
    expect(ConfigInstructionFile.excludes([])).toEqual([])
    expect(ConfigInstructionFile.excludes([document({ shell: "sh" })])).toEqual([])
  })
})

describe("ConfigInstructionFile.excluded", () => {
  const matching: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ["a nested file by a pattern that works wherever the project is", "**/third_party/**/AGENTS.md", "/repo/third_party/x/AGENTS.md", true],
    ["a file straight under the folder that the pattern names", "**/third_party/**/AGENTS.md", "/repo/third_party/AGENTS.md", true],
    ["not the root file of the project", "**/third_party/**/AGENTS.md", "/repo/AGENTS.md", false],
    ["a file by its absolute path", "/repo/pkg/AGENTS.md", "/repo/pkg/AGENTS.md", true],
    ["not another file by an absolute path", "/repo/pkg/AGENTS.md", "/repo/other/AGENTS.md", false],
    ["a path through a folder that starts with a dot", "**/.orbit/**", "/repo/.orbit/AGENTS.md", true],
    ["a name that starts with a dot, by a wildcard", "/repo/*.md", "/repo/.hidden.md", true],
    ["a brace set", "{/a,/b}/AGENTS.md", "/b/AGENTS.md", true],
    ["nothing by a bare name", "AGENTS.md", "/repo/AGENTS.md", false],
    ["nothing by a relative path", "docs/AGENTS.md", "/repo/docs/AGENTS.md", false],
    ["nothing when the case differs", "/Repo/AGENTS.md", "/repo/AGENTS.md", false],
    ["nothing by `~`, which is not expanded", "~/AGENTS.md", "/home/me/AGENTS.md", false],
    ["a name anywhere, by a pattern that starts with two asterisks", "**/AGENTS.md", "/a/b/c/AGENTS.md", true],
    ["a network path, by a pattern that starts with two asterisks", "**/repo/AGENTS.md", "//server/share/repo/AGENTS.md", true],
    ["a network path, by its own pattern", "//server/share/**", "//server/share/repo/AGENTS.md", true],
    ["nothing by an empty pattern", "", "/repo/AGENTS.md", false],
    ["nothing by a comment-like pattern", "#AGENTS.md", "/repo/#AGENTS.md", false],
  ]

  test.each(matching)("%s", (_name, pattern, file, expected) => {
    expect(ConfigInstructionFile.excluded([pattern], [file])).toBe(expected)
  })

  // The Windows spellings are written with backslashes, which are turned into slashes on every side, and the result is the
  // same on every host: the drive letter is in the same case on both sides.
  test("matches a Windows path and pattern written with backslashes, on any host", () => {
    const file = path.win32.join("C:\\repo", "pkg", "AGENTS.md")
    expect(file).toBe("C:\\repo\\pkg\\AGENTS.md")
    expect(ConfigInstructionFile.excluded(["C:\\repo\\pkg\\AGENTS.md"], [file])).toBe(true)
    expect(ConfigInstructionFile.excluded(["**/pkg/AGENTS.md"], [file])).toBe(true)
    expect(ConfigInstructionFile.excluded(["**\\pkg\\AGENTS.md"], [file])).toBe(true)
    expect(ConfigInstructionFile.excluded(["C:/repo/**"], [file])).toBe(true)
    expect(ConfigInstructionFile.excluded(["C:\\repo\\other\\**"], [file])).toBe(false)
    // A backslash cannot escape a glob character, so this is a path separator and a wildcard.
    expect(ConfigInstructionFile.excluded(["C:\\repo\\pkg\\*.md"], [file])).toBe(true)
  })

  test("does not tell the drive letter's case apart on any host", () => {
    expect(ConfigInstructionFile.excluded(["c:/repo/pkg/AGENTS.md"], ["C:\\repo\\pkg\\AGENTS.md"])).toBe(true)
    expect(ConfigInstructionFile.excluded(["C:/repo/pkg/AGENTS.md"], ["c:\\repo\\pkg\\AGENTS.md"])).toBe(true)
    expect(ConfigInstructionFile.excluded(["C:/Repo/pkg/AGENTS.md"], ["C:\\repo\\pkg\\AGENTS.md"])).toBe(false)
  })

  test("matches a network path written with backslashes by a pattern that starts with two asterisks", () => {
    expect(ConfigInstructionFile.excluded(["**/repo/AGENTS.md"], ["\\\\server\\share\\repo\\AGENTS.md"])).toBe(true)
    expect(ConfigInstructionFile.excluded(["\\\\server\\share\\**"], ["\\\\server\\share\\repo\\AGENTS.md"])).toBe(true)
  })

  test("matches when any spelling of the file does", () => {
    expect(ConfigInstructionFile.excluded(["/real/AGENTS.md"], ["/link/AGENTS.md", "/real/AGENTS.md"])).toBe(true)
    expect(ConfigInstructionFile.excluded(["/link/AGENTS.md"], ["/link/AGENTS.md", "/real/AGENTS.md"])).toBe(true)
    expect(ConfigInstructionFile.excluded(["/other/AGENTS.md"], ["/link/AGENTS.md", "/real/AGENTS.md"])).toBe(false)
  })

  test("skips a pattern that the matcher refuses, and the others still apply", () => {
    const tooLong = `/repo/${"x".repeat(70_000)}`
    expect(() => ConfigInstructionFile.excluded([tooLong, "**/AGENTS.md"], ["/repo/AGENTS.md"])).not.toThrow()
    expect(ConfigInstructionFile.excluded([tooLong, "**/AGENTS.md"], ["/repo/AGENTS.md"])).toBe(true)
    expect(ConfigInstructionFile.excluded([tooLong], ["/repo/AGENTS.md"])).toBe(false)
  })

  test("excludes nothing when there are no patterns", () => {
    expect(ConfigInstructionFile.excluded([], ["/repo/AGENTS.md"])).toBe(false)
  })
})

describe("ConfigInstructionFile.prepare", () => {
  const identity = (directory: string) => Effect.succeed(directory)
  const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

  // The resolver that a test hands over, and the folders it was asked about.
  const recording = (answers: Readonly<Record<string, string>> = {}) => {
    const asked: string[] = []
    return {
      asked,
      resolve: (directory: string) => Effect.sync(() => (asked.push(directory), answers[directory] ?? directory)),
    }
  }

  test("writes every pattern with forward slashes, drops empty ones and repeats", async () => {
    expect(
      await run(ConfigInstructionFile.prepare(["**\\a\\AGENTS.md", "", "**/a/AGENTS.md", "c:\\repo\\**"], identity, "linux")),
    ).toEqual(["**/a/AGENTS.md", "C:/repo/**"])
  })

  test("adds the form that an absolute pattern has through the real path of its fixed part", async () => {
    const resolver = recording({ "/tmp/x": "/private/tmp/x", "/tmp": "/private/tmp" })
    expect(await run(ConfigInstructionFile.prepare(["/tmp/x/**/AGENTS.md", "/tmp/x/AGENTS.md"], resolver.resolve, "linux"))).toEqual([
      "/tmp/x/**/AGENTS.md",
      "/tmp/x/AGENTS.md",
      "/private/tmp/x/**/AGENTS.md",
      "/private/tmp/x/AGENTS.md",
    ])
    expect(resolver.asked).toEqual(["/tmp/x", "/tmp/x"])
  })

  test("asks about the folder that the fixed part names, or the one a name is in", async () => {
    const resolver = recording()
    await run(
      ConfigInstructionFile.prepare(["/a/b/*.md", "/a/b/c*", "/a/{x,y}/z", "/a/[ab]/z", "/a/b?/z", "/AGENTS.md", "/**/x"], resolver.resolve, "linux"),
    )
    expect(resolver.asked).toEqual(["/a/b", "/a/b", "/a", "/a", "/a", "/", "/"])
  })

  test("adds nothing when the real path is the path, or the folder is not there", async () => {
    const resolver = recording()
    expect(await run(ConfigInstructionFile.prepare(["/repo/**", "/missing/dir/**"], resolver.resolve, "linux"))).toEqual([
      "/repo/**",
      "/missing/dir/**",
    ])
  })

  test("never resolves a pattern that is not absolute, or names a network path", async () => {
    const resolver = recording()
    const patterns = [
      "**/AGENTS.md",
      "AGENTS.md",
      "docs/**",
      "~/AGENTS.md",
      "//host/share/repo/**",
      "\\\\host\\share\\repo\\**",
      "\\\\?\\C:\\repo\\**",
      "//./C:/repo/**",
      "//localhost/C$/repo/**",
    ]
    const written = [...new Set(patterns.map((pattern) => pattern.replaceAll("\\", "/")))]
    for (const platform of ["linux", "win32"] as const)
      expect(await run(ConfigInstructionFile.prepare(patterns, resolver.resolve, platform))).toEqual(written)
    expect(resolver.asked).toEqual([])
  })

  test("resolves a drive-letter pattern on Windows and a slash-rooted one elsewhere", async () => {
    const windows = recording({ "C:/repo": "D:/real/repo", "/repo": "E:/other/repo" })
    expect(await run(ConfigInstructionFile.prepare(["C:/repo/**", "/repo/**"], windows.resolve, "win32"))).toEqual([
      "C:/repo/**",
      "/repo/**",
      "D:/real/repo/**",
      "E:/other/repo/**",
    ])
    expect(windows.asked).toEqual(["C:/repo", "/repo"])

    const linux = recording({ "/repo": "/real/repo" })
    expect(await run(ConfigInstructionFile.prepare(["C:/repo/**", "/repo/**"], linux.resolve, "linux"))).toEqual([
      "C:/repo/**",
      "/repo/**",
      "/real/repo/**",
    ])
    expect(linux.asked).toEqual(["/repo"])
  })

  test("treats the root of a drive as a folder, not as the current folder of the drive", async () => {
    const resolver = recording({ "C:/": "C:/" })
    await run(ConfigInstructionFile.prepare(["c:/**/AGENTS.md"], resolver.resolve, "win32"))
    expect(resolver.asked).toEqual(["C:/"])
  })

  test("keeps a pattern as written when its folder cannot be resolved", async () => {
    const failing = (_: string) => Effect.die(new Error("EACCES"))
    expect(await run(ConfigInstructionFile.prepare(["/locked/**", "**/AGENTS.md"], failing, "linux"))).toEqual([
      "/locked/**",
      "**/AGENTS.md",
    ])
  })

  test("drops a pattern that the matcher refuses with one line in the log, and keeps the others", async () => {
    const logged: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (Array.isArray(entry.message) && entry.message[0] === "instructions_exclude pattern ignored")
        logged.push(entry.message[1])
    })
    const prepared = await run(
      ConfigInstructionFile.prepare([`/repo/${"x".repeat(70_000)}`, "**/AGENTS.md"], identity, "linux").pipe(
        Effect.provide(Logger.layer([logger])),
      ),
    )
    expect(prepared).toEqual(["**/AGENTS.md"])
    expect(logged).toEqual([{ characters: 70_006 }])
  })

  it.live("makes a pattern written through a link match the file under the folder the link leads to", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs_ = yield* FSUtil.Service
      const real = path.join(tmp.path, "real")
      const link = path.join(tmp.path, "link")
      const file = path.join(real, "pkg", "AGENTS.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, "rules")
        // A junction reads as a link to a folder, and needs no privilege on Windows.
        await fs.symlink(real, link, "junction")
      })
      const slashed = (value: string) => value.replaceAll("\\", "/")
      for (const pattern of [`${slashed(link)}/pkg/AGENTS.md`, `${slashed(link)}/**/AGENTS.md`, `${slashed(link)}/pkg/*`]) {
        // The control: the pattern as it was written does not match the real file.
        expect(ConfigInstructionFile.excluded([pattern], [file])).toBe(false)
        const prepared = yield* ConfigInstructionFile.prepare([pattern], fs_.resolve)
        expect(prepared).toHaveLength(2)
        expect(ConfigInstructionFile.excluded(prepared, [file])).toBe(true)
        // The file is still found by the pattern as written, through the link.
        expect(ConfigInstructionFile.excluded(prepared, [path.join(link, "pkg", "AGENTS.md")])).toBe(true)
      }
    }),
  )

  it.live("adds nothing for a folder that is not there", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs_ = yield* FSUtil.Service
      const pattern = `${tmp.path.replaceAll("\\", "/")}/missing/**/AGENTS.md`
      expect(yield* ConfigInstructionFile.prepare([pattern], fs_.resolve)).toEqual([pattern])
    }),
  )
})

describe("ConfigInstructionFile.included", () => {
  it.live("drops a file that a pattern matches by either spelling, and gives the real path of the others", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs_ = yield* FSUtil.Service
      const real = path.join(tmp.path, "real")
      const link = path.join(tmp.path, "link")
      yield* Effect.promise(async () => {
        await fs.mkdir(real, { recursive: true })
        await fs.writeFile(path.join(real, "AGENTS.md"), "rules")
        await fs.writeFile(path.join(real, "ORBIT.md"), "rules")
        await fs.symlink(real, link, "junction")
      })
      const found = [path.join(link, "ORBIT.md"), path.join(link, "AGENTS.md")]
      const slashed = (value: string) => value.replaceAll("\\", "/")
      const everything = yield* ConfigInstructionFile.included([], found, fs_.resolve)
      expect(everything.map((item) => item.file)).toEqual(found)
      expect(everything.map((item) => item.real)).toEqual([path.join(real, "ORBIT.md"), path.join(real, "AGENTS.md")])
      // By the spelling the walk built, and by the real path.
      expect((yield* ConfigInstructionFile.included([`${slashed(link)}/ORBIT.md`], found, fs_.resolve)).map((item) => item.file)).toEqual([
        path.join(link, "AGENTS.md"),
      ])
      expect((yield* ConfigInstructionFile.included([`${slashed(real)}/AGENTS.md`], found, fs_.resolve)).map((item) => item.file)).toEqual([
        path.join(link, "ORBIT.md"),
      ])
    }),
  )
})

// A synchronous loop cannot be interrupted, so the work runs in a child process with a deadline. Every input here is one
// that a repository could ship, and made the block lexer of a Markdown library take seconds to minutes.
describe("ConfigInstructionFile.parse on hostile input", () => {
  test("finishes every case in linear time, and never throws", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "..", "fixture", "instruction-file-stress.ts")],
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    expect(code).toBe(0)
    const report = JSON.parse(out) as { readonly name: string; readonly ms: number }[]
    expect(report.length).toBeGreaterThan(20)
    // A case that takes seconds is one that is not linear: the slowest that ran was a few tens of milliseconds.
    expect(report.filter((item) => item.ms > 5_000)).toEqual([])
  }, 90_000)
})

describe("ConfigInstructionFile.imports", () => {
  const found = (text: string) => ConfigInstructionFile.imports(text)

  test("finds a token at the start of a line, after a space and after a tab, and not in the middle of a word", () => {
    expect(found("@./a.md")).toEqual(["./a.md"])
    expect(found("see @./a.md now")).toEqual(["./a.md"])
    expect(found("see\t@./a.md")).toEqual(["./a.md"])
    expect(found("mail me at name@example.com or a@b.md")).toEqual([])
  })

  const shapes: ReadonlyArray<readonly [string, boolean]> = [
    ["./x.md", true],
    ["../x.md", true],
    ["~/x.md", true],
    ["/abs/x.md", true],
    ["x.md", true],
    ["docs/x.md", true],
    [".hidden", true],
    ["-x.md", true],
    ["_x.md", true],
    ["C:/x.md", true],
    ["@x", false],
    ["(x)", false],
    ["#x", false],
    ["%x", false],
    ['"x"', false],
    ["[x]", false],
    ["<x>", false],
    [":x", false],
    ["/", false],
    ["~", false],
    ["~user/x", false],
  ]
  for (const [token, kept] of shapes)
    test(`${kept ? "keeps" : "drops"} the token @${token}`, () => {
      expect(found(`@${token}`)).toEqual(kept ? [token] : [])
    })

  test("cuts a token at a heading anchor, reads a backslash and space as a space and stops at another backslash", () => {
    expect(found("@./guide.md#setup")).toEqual(["./guide.md"])
    expect(found("@#only")).toEqual([])
    expect(found("@./my\\ notes.md")).toEqual(["./my notes.md"])
    expect(found("@C:\\x\\y.md")).toEqual(["C:"])
  })

  test("returns the tokens in order, each once", () => {
    expect(found("@./b.md @./a.md\n@./b.md\n- @./c.md @./a.md")).toEqual(["./b.md", "./a.md", "./c.md"])
  })

  const notText: ReadonlyArray<readonly [string, string]> = [
    ["a backtick fence", "```\n@./a.md\n```"],
    ["a tilde fence", "~~~\n@./a.md\n~~~"],
    ["a fence closed by a longer one", "```\n@./a.md\n`````\n"],
    ["a fence that is never closed", "```\n@./a.md\n"],
    ["indented code", "para\n\n    @./a.md\n"],
    ["a code span", "run `@./a.md` now"],
    ["a code span of two backticks", "run ``a ` @./a.md`` now"],
    ["a code span over two lines", "run `a\n@./a.md` now"],
    ["a comment block", "<!--\n@./a.md\n-->"],
    ["a comment inside a sentence", "see <!-- @./a.md --> there"],
    ["a comment inside a list item", "- <!-- @./a.md -->"],
    ["an HTML block", "<div>\n@./a.md\n</div>\n\nafter"],
    ["an inline tag", '<a href="@./a.md">link</a>'],
    ["the target of a link", "[text](@./a.md)"],
    ["the alt text of an image", "![@./a.md](u)"],
    ["an escaped at sign", "\\@./a.md"],
    ["a fence in a quote that goes on", "> ```\n> @./a.md\n> more"],
    ["a fence in a list item that goes on, across a blank line", "- ```\n  code\n\n  @./a.md"],
    ["a comment block that spans lines and leaves nothing", "<!--\n@./a.md\n-->\n"],
    ["an escaped at sign after a hard break", "text\\\n\\@./a.md"],
  ]
  for (const [name, text] of notText)
    test(`finds nothing in ${name}`, () => {
      expect(found(text)).toEqual([])
    })

  test("finds nothing in front matter, which the file is parsed without", () => {
    const processed = ConfigInstructionFile.parse("---\nnote: '@./a.md'\n---\n\nbody", { frontmatter: true })
    expect(found(processed.content)).toEqual([])
  })

  const text: ReadonlyArray<readonly [string, string]> = [
    ["after a comment block on the same line", "<!-- x --> @./a.md"],
    ["in a list item", "- @./a.md"],
    ["in a nested list item", "- a\n  - b\n    - @./a.md"],
    ["in an ordered list item", "1. @./a.md"],
    ["in a quote", "> @./a.md"],
    ["in a heading", "# See @./a.md"],
    ["in the text of a link", "[@./a.md](u)"],
    ["inside emphasis", "**@./a.md**"],
    ["after an unclosed run of backticks", "` @./a.md"],
    ["after a code span", "`code` @./a.md"],
    ["after a closed fence", "```\ncode\n```\n@./a.md"],
    ["after an inline tag", "<b>@./a.md</b>"],
    ["in a paragraph after a blank line", "para\n\n@./a.md"],
    ["after the end of a comment block that spans lines", "<!--\nnote\n--> @./a.md"],
    ["after a comment block that spans lines and a second comment", "<!--\nnote\n--> <!-- x --> @./a.md"],
    ["after a hard line break", "text\\\n@./a.md"],
    ["after a backslash that escapes nothing", "path\\ @./a.md"],
    ["after a backslash before a letter", "C:\\x @./a.md"],
    ["after a quote that ends and closed the fence it held", "> ```\n> code\n\n@./a.md"],
    ["after a quote that ends without a blank line and closed the fence it held", "> ```\n> code\n@./a.md"],
    ["after a list item that ends and closed the fence it held", "- ```\n  code\n@./a.md"],
  ]
  for (const [name, source] of text)
    test(`finds a token ${name}`, () => {
      expect(found(source)).toEqual(["./a.md"])
    })

  test("drops a token with a control character and keeps the others", () => {
    expect(found("@./a\u0000b.md @./c.md @./d\u0007.md")).toEqual(["./c.md"])
  })
})

describe("ConfigInstructionFile.load", () => {
  const pass = () => Effect.succeed(true)
  const refuse = () => Effect.succeed(false)
  // A fake that records what it is asked about answers for a network spelling by itself and never passes it on, so that a
  // regression fails at once and does not contact a host.
  const network = (file: string) => /^[\\/]{2}/.test(file)

  // A tree of files under a fresh folder.
  const tree = Effect.fnUntraced(function* (files: Readonly<Record<string, string>>) {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(async () => {
      for (const [name, body] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(tmp.path, name)), { recursive: true })
        await fs.writeFile(path.join(tmp.path, name), body)
      }
    })
    return tmp.path
  })

  const run = Effect.fnUntraced(function* (
    root: string,
    file: string,
    options: {
      scope?: "user" | "project"
      visited?: Set<string>
      patterns?: readonly string[]
      allow?: (real: string, spelling: string) => Effect.Effect<boolean>
      platform?: NodeJS.Platform
      home?: string
    } = {},
  ) {
    const fs_ = yield* FSUtil.Service
    return yield* ConfigInstructionFile.load({
      path: path.join(root, file),
      scope: options.scope ?? "user",
      visited: options.visited ?? new Set(),
      patterns: options.patterns ?? [],
      home: options.home ?? path.join(root, "home"),
      fs: fs_,
      leads: fs_.resolve,
      allow: options.allow ?? pass,
      platform: options.platform,
    })
  })

  const names = (root: string, loaded: Effect.Success<ReturnType<typeof run>>) =>
    loaded?.files.map((item) => path.relative(root, item.path).replaceAll("\\", "/"))

  it.live("loads the importer first, then each import followed by its own imports", () =>
    Effect.gen(function* () {
      const root = yield* tree({
        "a.md": "A @./b.md and @./c.md",
        "b.md": "B @./d.md",
        "c.md": "C",
        "d.md": "D",
      })
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "b.md", "d.md", "c.md"])
    }),
  )

  it.live("loads a file reached twice once, where it comes first", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@./b.md @./c.md", "b.md": "B @./d.md", "c.md": "C @./d.md", "d.md": "D" })
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "b.md", "d.md", "c.md"])
    }),
  )

  it.live("leaves the token in the importer's text and records the importer on the import", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "see @./b.md", "b.md": "B" })
      const loaded = yield* run(root, "a.md")
      expect(loaded?.files[0]?.content).toBe("see @./b.md")
      expect(loaded?.files[1]).toMatchObject({ content: "B", importedBy: path.join(root, "a.md") })
    }),
  )

  it.live("resolves a token next to the importer, from the home folder, or as the absolute path it is", () =>
    Effect.gen(function* () {
      const root = yield* tree({
        "a.md": "@./sub/b.md @~/h.md",
        "sub/b.md": "B @./c.md @../up.md",
        "sub/c.md": "C",
        "up.md": "UP",
        "home/h.md": "H",
      })
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "sub/b.md", "sub/c.md", "up.md", "home/h.md"])
      const written = `@${path.join(root, "up.md").replaceAll("\\", "/")}`
      const absolute = yield* tree({ "x.md": written })
      expect((yield* run(absolute, "x.md"))?.files.map((item) => item.content)).toEqual([written, "UP"])
    }),
  )

  const linked = canLinkFile ? it.live : it.live.skip
  linked("resolves a token next to the target of the link that the importer was reached through", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "real/b.md": "B @./x.md", "real/x.md": "X", "other/x.md": "WRONG" })
      yield* Effect.promise(() => fs.symlink(path.join(root, "real", "b.md"), path.join(root, "other", "b.md")))
      const fs_ = yield* FSUtil.Service
      const loaded = yield* ConfigInstructionFile.load({
        path: yield* fs_.resolve(path.join(root, "other", "b.md")),
        scope: "user",
        visited: new Set(),
        patterns: [],
        home: root,
        fs: fs_,
        leads: fs_.resolve,
        allow: pass,
      })
      expect(loaded?.files.map((item) => item.content)).toEqual(["B @./x.md", "X"])
    }),
  )

  it.live("loads a chain of five files whole, and leaves the sixth out without a word", () =>
    Effect.gen(function* () {
      const root = yield* tree({
        "1.md": "@./2.md",
        "2.md": "@./3.md",
        "3.md": "@./4.md",
        "4.md": "@./5.md",
        "5.md": "@./6.md",
        "6.md": "six",
      })
      const loaded = yield* run(root, "1.md")
      expect(names(root, loaded)).toEqual(["1.md", "2.md", "3.md", "4.md", "5.md"])
      expect(loaded?.skipped).toEqual([])
    }),
  )

  it.live("lets the first visit win when a file is reached at the depth limit before a shorter way", () =>
    Effect.gen(function* () {
      // The long chain reaches e.md at level four first, where its import of f.md is cut off. The short way finds it handled.
      const root = yield* tree({
        "a.md": "@./b.md @./e.md",
        "b.md": "@./c.md",
        "c.md": "@./d.md",
        "d.md": "@./e.md",
        "e.md": "E @./f.md",
        "f.md": "F",
      })
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"])
    }),
  )

  it.live("ends a cycle, adds nothing for a self-import and loads two spellings of a file once", () =>
    Effect.gen(function* () {
      const root = yield* tree({
        "a.md": "@./b.md @./a.md @b.md @./sub/../b.md",
        "b.md": "B @./a.md",
      })
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "b.md"])
    }),
  )

  linked("loads a file reached through a link and directly once", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@./l.md @./b.md", "b.md": "B" })
      yield* Effect.promise(() => fs.symlink(path.join(root, "b.md"), path.join(root, "l.md")))
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "b.md"])
    }),
  )

  it.live("folds case and slash direction when it keeps the files it has handled on Windows only", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@./B.md", "b.md": "B" })
      const windows = new Set<string>()
      yield* run(root, "a.md", { visited: windows, platform: "win32" })
      expect([...windows].every((key) => key === key.toLowerCase() && !key.includes("/"))).toBe(true)
      const elsewhere = new Set<string>()
      yield* run(root, "a.md", { visited: elsewhere, platform: "linux" })
      expect([...elsewhere].some((key) => key !== key.toLowerCase())).toBe(true)
    }),
  )

  it.live("skips a missing target and a folder without a word, and still loads the importer", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@someone @./nothing.md @./dir @./b.md", "dir/x.md": "X", "b.md": "B" })
      const loaded = yield* run(root, "a.md")
      expect(names(root, loaded)).toEqual(["a.md", "b.md"])
      expect(loaded?.skipped).toEqual([])
    }),
  )

  it.live("adds nothing for an importer with only whitespace left, and does not follow its imports", () =>
    Effect.gen(function* () {
      const root = yield* tree({
        "a.md": "@./empty.md @./only.md",
        "empty.md": "<!-- @./hidden.md -->\n",
        "hidden.md": "H",
        "only.md": "@./b.md",
        "b.md": "B",
      })
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "only.md", "b.md"])
    }),
  )

  it.live("skips a target that is not text by its name, takes one with no extension, and refuses a NUL", () =>
    Effect.gen(function* () {
      const root = yield* tree({
        "a.md": "@./pic.png @./doc.pdf @./LICENSE @./.env @./bin.md",
        "pic.png": "fake image",
        "doc.pdf": "fake pdf",
        LICENSE: "license",
        ".env": "KEY=1",
        "bin.md": "text\u0000binary",
      })
      expect(names(root, yield* run(root, "a.md"))).toEqual(["a.md", "LICENSE", ".env"])
    }),
  )

  it.live("reads an import whatever its extension, with its front matter and comments off", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@./b.txt", "b.txt": "---\nk: v\n---\n\n<!-- c -->\n\ntext @./c.md\n", "c.md": "C" })
      const loaded = yield* run(root, "a.md")
      expect(loaded?.files.map((item) => item.content)).toEqual(["@./b.txt", "text @./c.md\n", "C"])
    }),
  )

  it.live("never opens a file that instructions_exclude names, and does not follow its imports", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@./skip.md @./b.md", "skip.md": "S @./deep.md", "deep.md": "D", "b.md": "B" })
      const fs_ = yield* FSUtil.Service
      const opened: string[] = []
      const patterns = yield* ConfigInstructionFile.prepare([`${root.replaceAll("\\", "/")}/skip.md`], fs_.resolve)
      const loaded = yield* ConfigInstructionFile.load({
        path: path.join(root, "a.md"),
        scope: "user",
        visited: new Set(),
        patterns,
        home: root,
        fs: { ...fs_, readFileStringSafe: (target) => (opened.push(path.basename(target)), fs_.readFileStringSafe(target)) },
        leads: fs_.resolve,
        allow: pass,
      })
      expect(names(root, loaded)).toEqual(["a.md", "b.md"])
      expect(opened).toEqual(["a.md", "b.md"])
    }),
  )

  it.live("treats an address as a name that is not there, asked about only as a local spelling", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@https://example.invalid/x.md" })
      const fs_ = yield* FSUtil.Service
      const asked: string[] = []
      const loaded = yield* ConfigInstructionFile.load({
        path: path.join(root, "a.md"),
        scope: "user",
        visited: new Set(),
        patterns: [],
        home: path.join(root, "home"),
        fs: fs_,
        leads: (spelling) => (asked.push(spelling), fs_.resolve(spelling)),
        allow: pass,
      })
      expect(names(root, loaded)).toEqual(["a.md"])
      expect(asked.map((spelling) => path.relative(root, spelling).replaceAll("\\", "/"))).toEqual(["https:/example.invalid/x.md"])
    }),
  )

  it.live("asks the gate about the real path of a project file's import, and reports each one it refuses", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "p/a.md": "@./b.md @../out.md", "p/b.md": "B", "out.md": "OUT" })
      const loaded = yield* run(path.join(root, "p"), "a.md", {
        scope: "project",
        allow: (real) => Effect.succeed(real.startsWith(path.join(root, "p"))),
      })
      expect(loaded?.files.map((item) => item.content)).toEqual(["@./b.md @../out.md", "B"])
      expect(loaded?.skipped).toEqual([{ importer: path.join(root, "p", "a.md"), target: path.join(root, "out.md") }])
    }),
  )

  it.live("does not ask the gate about a user-level file's import, so that it can leave every project", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "p/a.md": "@../out.md", "out.md": "OUT" })
      const loaded = yield* run(path.join(root, "p"), "a.md", { scope: "user", allow: refuse })
      expect(loaded?.files.map((item) => item.content)).toEqual(["@../out.md", "OUT"])
    }),
  )

  for (const scope of ["user", "project"] as const)
    it.live(`refuses a network path in a ${scope} file before any file is touched or followed`, () =>
      Effect.gen(function* () {
        const root = yield* tree({ "a.md": "@//server/share/x.md\n\n@/server/share/y.md" })
        const fs_ = yield* FSUtil.Service
        const touched: string[] = []
        const asked: string[] = []
        const loaded = yield* ConfigInstructionFile.load({
          path: path.join(root, "a.md"),
          scope,
          visited: new Set(),
          patterns: [],
          home: root,
          fs: {
            ...fs_,
            isFile: (file) => (touched.push(file), network(file) ? Effect.succeed(false) : fs_.isFile(file)),
            readFileStringSafe: (file) => (touched.push(file), network(file) ? Effect.succeed(undefined) : fs_.readFileStringSafe(file)),
          },
          leads: (spelling) => (asked.push(spelling), Effect.succeed(spelling)),
          allow: pass,
        })
        expect(loaded?.files).toHaveLength(1)
        // The second token is an ordinary absolute path, which is asked about as any other. The first never is.
        expect(asked.map((spelling) => spelling.replaceAll("\\", "/")).filter((spelling) => spelling.startsWith("//"))).toEqual([])
        expect(touched.some((file) => file.replaceAll("\\", "/").startsWith("//"))).toBe(false)
      }),
    )

  it.live("refuses a link that leads to a network path, without opening it", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "a.md": "@./l.md" })
      const fs_ = yield* FSUtil.Service
      const touched: string[] = []
      const loaded = yield* ConfigInstructionFile.load({
        path: path.join(root, "a.md"),
        scope: "user",
        visited: new Set(),
        patterns: [],
        home: root,
        // The trust decision names a link to a share as the share, and does not open it.
        fs: {
          ...fs_,
          isFile: (file) => (touched.push(file), network(file) ? Effect.succeed(false) : fs_.isFile(file)),
          readFileStringSafe: (file) => (touched.push(file), network(file) ? Effect.succeed(undefined) : fs_.readFileStringSafe(file)),
        },
        leads: () => Effect.succeed("\\\\server\\share\\x.md"),
        allow: pass,
      })
      expect(loaded?.files).toHaveLength(1)
      expect(touched.filter((file) => file.includes("server"))).toEqual([])
    }),
  )
})
