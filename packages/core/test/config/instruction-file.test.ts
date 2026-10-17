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
