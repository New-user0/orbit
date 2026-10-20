import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"
import { ConfigInstructionRules } from "@orbit/core/config/instruction-rules"
import { ConfigMarkdown } from "@orbit/core/config/markdown"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { scriptedMarkdown } from "../fixture/front-matter"
import { canLinkFile } from "../fixture/symlink"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

const front = (frontmatter: string) => ConfigMarkdown.split(`---\n${frontmatter}\n---\nBody.`).frontmatter

describe("ConfigInstructionFile.rulePatterns", () => {
  // Each row is the front matter of a rule and the patterns it keeps. `undefined` applies from the start.
  const rows: ReadonlyArray<readonly [string, string, readonly string[] | undefined]> = [
    ["a list", "paths:\n  - a/*.ts\n  - b", ["a/*.ts", "b"]],
    ["a string with commas", 'paths: "a/*.ts, b ,, c"', ["a/*.ts", "b", "c"]],
    ["a flow list", "paths: [a, b]", ["a", "b"]],
    ["a comma inside braces is not a split", 'paths: "src/*.{ts,tsx}, lib"', ["src/*.ts", "src/*.tsx", "lib"]],
    ["nested braces", 'paths: "{a,{b,c}}/x"', ["a/x", "b/x", "c/x"]],
    ["a brace group that is never closed", 'paths: "a{b,c"', ["a{b,c"]],
    ["a closing brace with no opener stops the splitting after it", 'paths: "a},b,c"', ["a},b,c"]],
    ["a trailing double asterisk", 'paths: "src/**"', ["src"]],
    ["a double asterisk anywhere else", 'paths: "src/**/x"', ["src/**/x"]],
    ["only a double asterisk", 'paths: "**"', undefined],
    ["a double asterisk beside others", 'paths: "**, src"', ["**", "src"]],
    ["a double asterisk and a trailing one", 'paths: "**, /**"', undefined],
    ["an unquoted value that starts with an asterisk", "paths: **/*.ts", ["**/*.ts"]],
    ["an unquoted value with a hash and a colon", "paths: a: b", ["a: b"]],
    ["an empty list", "paths: []", undefined],
    ["a value that is empty", "paths:", undefined],
    ["a number", "paths: 7", undefined],
    ["a boolean", "paths: true", undefined],
    ["a mapping", "paths:\n  a: b", undefined],
    ["another key only", "description: x", undefined],
    ["a list with items that are not text", "paths:\n  - 1\n  - ok\n  - null", ["ok"]],
  ]
  for (const [name, written, patterns] of rows)
    test(`reads ${name}`, () => {
      expect(ConfigInstructionFile.rulePatterns(front(written))).toEqual({ patterns, malformed: false, dropped: 0 })
    })

  test("says a file without front matter applies from the start", () => {
    expect(ConfigInstructionFile.rulePatterns(undefined)).toEqual({ patterns: undefined, malformed: false, dropped: 0 })
  })

  test("reports an unquoted list item that starts with an asterisk, which neither read nor the retry accepts", () => {
    expect(ConfigInstructionFile.rulePatterns(front("paths:\n  - **/*.ts"))).toEqual({ patterns: undefined, malformed: true, dropped: 0 })
  })

  test("reports front matter that does not parse", () => {
    expect(ConfigInstructionFile.rulePatterns(front('paths: "src/**'))).toEqual({ patterns: undefined, malformed: true, dropped: 0 })
  })

  test("keeps at most 256 patterns and drops one over 1,024 characters, however many braces a file writes", () => {
    const result = ConfigInstructionFile.rulePatterns(front(`paths: "${"{a,b}".repeat(30)}"`))
    expect(result.patterns).toHaveLength(ConfigInstructionFile.RULE_PATTERNS)
    expect(ConfigInstructionFile.rulePatterns(front(`paths: "${"x".repeat(1_025)}, ok"`)).patterns).toEqual(["ok"])
  })

  // The work stops once the cap is kept or the work allowance is spent, so a value of a megabyte, or a few kilobytes that
  // aliases repeat thousands of times, costs the parse and a bounded amount more. It is synchronous, so it runs in a child
  // process with a deadline.
  test("stops once 256 patterns are kept or the work allowance is spent, whatever a file repeats or spells out", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "..", "fixture", "rule-patterns-stress.ts")],
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    expect(code).toBe(0)
    const report = JSON.parse(out) as {
      readonly name: string
      readonly ms: number
      readonly cpu: number
      readonly kept: number
      readonly dropped: number
    }[]
    // Each row is a value and whether it reaches the cap of kept patterns. The aliased rows come to more than their text,
    // so their block is refused before `paths` is read (`ConfigMarkdown.Oversized`) and they keep nothing whatever the
    // allowance does. The other rows that keep nothing are stopped by the allowance alone, and each costs a few
    // milliseconds of processor time with it. Mutation: counting only kept patterns, as before (no allowance in the split
    // or the expansion), takes 0.6 to 0.9 seconds of processor time for droppedList and emptyList, and emptyList drops
    // nothing. Deleting the refusal in `ConfigMarkdown.read` hands the aliased rows back to the allowance, which stops them.
    const rows: ReadonlyArray<readonly [string, boolean]> = [
      ["commaString", true],
      ["commaList", true],
      ["braceString", true],
      ["oneHugePart", false],
      ["aliasedEmpty", false],
      ["emptyList", false],
      ["droppedList", false],
      ["aliasedDropped", false],
      ["aliasedCommas", false],
      ["aliasedLongPart", false],
      ["aliasedShortParts", false],
    ]
    expect(report.map((item) => item.name)).toEqual(rows.map((row) => row[0]))
    for (const [name, capped] of rows) {
      const item = report.find((entry) => entry.name === name)
      expect(item?.kept).toBe(capped ? ConfigInstructionFile.RULE_PATTERNS : 0)
      expect(item?.ms).toBeLessThan(1_500)
      if (capped) continue
      // A row that keeps nothing still waits: what it left unread counts as dropped.
      expect(item?.dropped).toBeGreaterThan(0)
      expect(item?.cpu).toBeLessThan(500)
    }
  }, 90_000)

  test("keeps what it had kept when the work allowance runs out, and waits when that is nothing", () => {
    const anchor = `s: &s "${"{,}".repeat(340)}"\n`
    // Two aliases come to less than the text allows, and each spends most of the allowance on its empty spellings.
    // Mutation: without the allowance every alias is expanded, `c` is reached, and the rule keeps `a`, `b` and `c`.
    expect(ConfigInstructionFile.rulePatterns(front(`${anchor}paths: [a, b, *s, *s, c]`))).toEqual({
      patterns: ["a", "b"],
      malformed: false,
      dropped: 1,
    })
    // Two thousand aliases come to two megabytes of text from three kilobytes, so the block is refused before `paths` is
    // read (`ConfigMarkdown.Oversized`) and the rule waits, whatever it would have kept first. Mutations: deleting the
    // check in `ConfigMarkdown.read` keeps `a` and `b` in the first row; reading the refusal as a block that does not
    // parse makes both rows apply from the start; letting `parse` retry it reads `paths` as the text `[a, b, *s, ...]`.
    const aliases = Array(2_000).fill("*s").join(", ")
    for (const written of [`${anchor}paths: [a, b, ${aliases}, c]`, `${anchor}paths: [${aliases}, c]`])
      expect(ConfigInstructionFile.rulePatterns(front(written))).toEqual({ patterns: [], malformed: false, dropped: 1 })
  })

  // A part of 340 empty brace groups costs about a thousand in its comma split and most of the allowance in its expansion,
  // so a second such part spends the rest before `c` is read.
  test("charges each step of brace expansion to the allowance that the comma split draws on", () => {
    const empty = `"${"{,}".repeat(340)}"`
    // Mutation: deleting `work.left -= pattern.length + RULE_STEP` from `expandBraces` leaves the split alone to pay, `c`
    // is read after two such parts as after one, and the second row keeps `a` and `c` with nothing dropped.
    const rows: ReadonlyArray<readonly [string, readonly string[], number]> = [
      [`paths: [a, ${empty}, c]`, ["a", "c"], 0],
      [`paths: [a, ${empty}, ${empty}, c]`, ["a"], 1],
    ]
    for (const [written, patterns, dropped] of rows)
      expect(ConfigInstructionFile.rulePatterns(front(written))).toEqual({ patterns, malformed: false, dropped })
  })

  // An expression such as `/\/+$/` is tried again at each character of a run that something else follows, which costs the
  // square of the run's length. Each row is a reader that strips such a run from what a repository writes, over a run of
  // slashes or underscores and then a letter, and over a control of letters as long. The work is synchronous, so it runs
  // in a child process with a deadline.
  test("strips the run that ends a pattern or an import token in time that grows with its length", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "..", "fixture", "trailing-run-stress.ts")],
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    expect(code).toBe(0)
    const report = JSON.parse(out) as {
      readonly name: string
      readonly control: { readonly ms: number; readonly size: number }
      readonly hostile: { readonly ms: number; readonly size: number }
    }[]
    // Each reader made as much from the run as from its control: the patterns that 20 rules kept, the patterns the matcher
    // took, the tokens found.
    expect(report.map((item) => [item.name, item.hostile.size, item.control.size])).toEqual([
      ["rulePatterns", 4_620, 4_620],
      ["negatedRulePatterns", 4_610, 4_610],
      ["ruleMatches", 2_048, 2_048],
      ["imports", 1, 1],
    ])
    // Wall time, because processor time counts the collector's threads as well. Mutation: putting back
    // `body.replace(/\/+$/, "")` in `compile` takes the three rule rows, and `raw.replace(/_+$/, "")` in `tokens` the
    // import row, from a few milliseconds to between 1.8 and 6.6 seconds each, while their controls stay at a few.
    expect(report.filter((item) => item.hostile.ms >= item.control.ms * 4 + 250).map((item) => item.name)).toEqual([])
  }, 90_000)

  // A front matter line whose value starts after a long run of spaces or tabs and holds a lone CR, U+2028, U+2029 or
  // U+0085, and a block with a long run of empty lines, each against a control of letters as long that takes the same
  // path. The work is synchronous, so it runs in a child process with a deadline.
  test("reads a front matter line or block in time that grows with its length, whatever separator it holds", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "..", "fixture", "front-matter-line-stress.ts")],
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    expect(code).toBe(0)
    const report = JSON.parse(out) as { readonly name: string; readonly hostile: number; readonly control: number }[]
    // Mutation: dropping the `s` flag of the line match in `ConfigMarkdown.sanitize`, which a rule's `paths` runs twice
    // when its YAML does not parse, takes the lone CR, U+2028 and U+2029 line rows from a few milliseconds to seconds
    // each, and the child's deadline kills the run. Reading through gray-matter's own reader again takes the rows of
    // empty lines from a few milliseconds to seconds each.
    const rows = report.filter((item) => item.name.startsWith("rulePatterns"))
    expect(rows).toHaveLength(17)
    expect(rows.filter((item) => item.hostile >= item.control * 4 + 250)).toEqual([])
  }, 90_000)

  test("reads the paths of a line that ends in U+2028 or U+2029", () => {
    // Mutation: dropping the `s` flag of the line match in `ConfigMarkdown.sanitize` leaves the line as it was written,
    // the YAML does not parse, and the rule applies from the start.
    for (const separator of ["\u2028", "\u2029"])
      expect(ConfigInstructionFile.rulePatterns(front(`paths: **/*.ts${separator}`))).toEqual({
        patterns: ["**/*.ts"],
        malformed: false,
        dropped: 0,
      })
  })

  test("keeps a list of 256 patterns of 480 characters whole, within the work allowance", () => {
    const list = Array.from({ length: 256 }, (_, index) => `src/${String(index).padStart(3, "0")}${"a".repeat(473)}`)
    const result = ConfigInstructionFile.rulePatterns(front(`paths:\n${list.map((item) => `  - ${item}`).join("\n")}`))
    // Mutation: halving the allowance keeps about 130 of them.
    expect(result).toEqual({ patterns: list, malformed: false, dropped: 0 })
  })

  // Bun's matcher does not backtrack, and the repository writes both the pattern and the file name: a read must stay cheap.
  test("matches a read in bounded time, whatever wildcards a repository writes", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "..", "fixture", "rule-match-stress.ts")],
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    expect(code).toBe(0)
    const report = JSON.parse(out) as { readonly name: string; readonly ms: number; readonly matched: boolean }[]
    expect(report.map((item) => item.name)).toEqual([
      "starThenNotStarAStar",
      "starThenNotGlobstarAGlobstar",
      "starThenNotStarAThreeStars",
      "starThenNotStarAStarA",
      "twentyStarAThenB",
      "anchoredStars",
      "control",
    ])
    // Mutation: putting the old `ignore` matcher back (behind its star-run filter) fails these rows at seconds each, because the target file is `b`, which no hostile pattern matches early; Bun.Glob passes.
    for (const item of report) expect(item.ms).toBeLessThan(100)
    expect(report.find((item) => item.name === "control")?.matched).toBe(true)
    expect(report.find((item) => item.name === "twentyStarAThenB")?.matched).toBe(false)
  }, 90_000)

  test("keeps a rule whose patterns were all dropped as a rule that waits, and counts what it dropped", () => {
    const dropped = ConfigInstructionFile.rulePatterns(front(`paths: "${"x".repeat(1_025)}"`))
    // Mutation: returning `undefined` patterns for an empty list makes the rule apply from the start.
    expect(dropped).toEqual({ patterns: [], malformed: false, dropped: 1 })
    const capped = ConfigInstructionFile.rulePatterns(front(`paths: "${"{a,b}".repeat(30)}, tail"`))
    expect(capped.dropped).toBeGreaterThan(0)
    expect(ConfigInstructionFile.ruleMatches([], path.resolve("/repo"), path.resolve("/repo/a.ts"))).toBe(false)
  })

  test("matches nothing for a path over 32 segments or 1,024 characters", () => {
    const base = path.resolve("rule-depth-base")
    const at = (...parts: string[]) => path.join(base, ...parts)
    expect(ConfigInstructionFile.ruleMatches(["a"], base, at(...Array.from({ length: 32 }, () => "a")))).toBe(true)
    expect(ConfigInstructionFile.ruleMatches(["a"], base, at(...Array.from({ length: 33 }, () => "a")))).toBe(false)
    expect(ConfigInstructionFile.ruleMatches(["a*"], base, at("a".repeat(1_030), "x"))).toBe(false)
  })

  test("reads the block with plain delimiters, whatever spaces follow the dashes on its own lines", () => {
    const frontmatter = ConfigMarkdown.split("---  \npaths: a\n---\t\nBody.").frontmatter
    expect(ConfigInstructionFile.rulePatterns(frontmatter)).toEqual({ patterns: ["a"], malformed: false, dropped: 0 })
  })

  // Only `split` finds front matter, and only YAML reads it: a block that names a language is not front matter at all, and
  // a YAML tag that names code is refused. A marker file proves that nothing ran.
  for (const language of ["js", "javascript", " js", "JS", "JavaScript", "coffee"])
    test(`runs nothing for a block that opens with ---${language}`, async () => {
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "ran")
      const text = scriptedMarkdown(marker, language)
      expect(ConfigMarkdown.split(text).frontmatter).toBeUndefined()
      expect(ConfigInstructionFile.rulePatterns(ConfigMarkdown.split(text).frontmatter)).toEqual({
        patterns: undefined,
        malformed: false,
        dropped: 0,
      })
      expect(await Bun.file(marker).exists()).toBe(false)
    })

  test("runs nothing for a YAML tag that names code, and keeps the patterns of a plain block", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "ran")
    const tag = `!!js/function "function () { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran') }"`
    ConfigInstructionFile.rulePatterns(front(`paths: ${tag}`))
    ConfigInstructionFile.rulePatterns(front(`other: ${tag}\npaths: src/**`))
    expect(await Bun.file(marker).exists()).toBe(false)
    expect(ConfigInstructionFile.rulePatterns(front("paths: src/**"))).toEqual({ patterns: ["src"], malformed: false, dropped: 0 })
  })
})

describe("ConfigMarkdown.parseOption, indicators", () => {
  test("reads a value that starts with an asterisk as text only when asked", () => {
    const content = "---\npaths: **/*.ts\n---\nBody."
    expect(ConfigMarkdown.parseOption(content)).toBeUndefined()
    expect(ConfigMarkdown.parseOption(content, true)?.data).toEqual({ paths: "**/*.ts" })
  })

  test("parses what parsed before the same way", () => {
    const content = "---\ndescription: Use when: it fits\nmetadata: [a, b]\n---\nBody."
    expect(ConfigMarkdown.parseOption(content)).toMatchObject({ data: { description: "Use when: it fits" } })
    expect(ConfigMarkdown.parseOption(content, true)).toMatchObject(ConfigMarkdown.parseOption(content)!)
    expect(ConfigMarkdown.parseOption("---\nmetadata: [\n---\nBody.")).toBeUndefined()
  })
})

describe("ConfigInstructionFile.ruleMatches and isRuleName", () => {
  const base = path.resolve("/repo")
  const at = (...parts: string[]) => path.join(base, ...parts)

  // Each row is a meaning of the .gitignore rules, the patterns, the path from the base, the answer, and the mutation of
  // `ruleMatches` or `compileRulePattern` that makes the row fail.
  const meanings: ReadonlyArray<readonly [string, string[], string[], boolean, string]> = [
    ["no slash matches at depth", ["*.ts"], ["a", "b", "c.ts"], true, "anchor every pattern (drop the `**/` prefix)"],
    ["no slash matches at the base", ["*.ts"], ["c.ts"], true, "require a slash before the name"],
    ["a slash anchors", ["src/*.ts"], ["lib", "src", "a.ts"], false, "prefix `**/` to every pattern"],
    ["a slash anchors, and matches at the base", ["src/*.ts"], ["src", "a.ts"], true, "never match an anchored pattern"],
    ["a leading slash is the base", ["/src/*.ts"], ["lib", "src", "a.ts"], false, "keep the leading slash in the glob"],
    ["a leading slash, matched", ["/a.ts"], ["a.ts"], true, "treat a leading slash as no slash and add `**/`"],
    ["a leading slash is the only slash", ["/a.ts"], ["lib", "a.ts"], false, "count the leading slash as part of a no-slash name"],
    ["a trailing slash is not an anchor", ["gen/"], ["x", "gen", "a.ts"], true, "count the trailing slash as a slash"],
    ["a trailing slash is for folders", ["gen/"], ["x", "gen"], false, "ignore folderOnly"],
    ["a folder covers what is below it", ["src"], ["src", "a", "b.ts"], true, "test the path alone"],
    ["a folder with a slash covers below", ["src/"], ["src", "a", "b.ts"], true, "test only the file against folderOnly patterns"],
    ["an anchored folder covers below", ["src/lib"], ["src", "lib", "a", "b.ts"], true, "test the path alone"],
    ["a wildcard takes a dot name", ["*.ts"], ["src", ".hidden.ts"], true, "pass dot: false semantics (skip dot names)"],
    ["a wildcard takes a dot folder", ["*"], [".git", "config"], true, "skip dot folders"],
    ["a later negation takes a match back", ["*.ts", "!a.ts"], ["a.ts"], false, "ignore `!`"],
    ["a negation before the match is overridden", ["!a.ts", "*.ts"], ["a.ts"], true, "let a `!` win whatever its order"],
    ["the last match wins, again", ["*.ts", "!a.ts", "a.ts"], ["a.ts"], true, "stop at the first match"],
    ["a negation cannot rescue under a matched folder", ["src", "!src/gen"], ["src", "gen", "x.ts"], true, "do not test ancestors first"],
    ["a negation of a folder pattern takes the folder back", ["src", "!src"], ["src", "x.ts"], false, "never let a folder be unmatched"],
    ["a negation alone matches nothing", ["!a.ts"], ["a.ts"], false, "treat `!` as a positive pattern"],
    ["case is ignored in the pattern", ["SRC/*.TS"], ["src", "a.ts"], true, "do not lower-case the pattern"],
    ["case is ignored in the path", ["src/*.ts"], ["SRC", "A.TS"], true, "do not lower-case the path"],
    ["a double asterisk alone matches every file", ["**"], ["a", "b.ts"], true, "refuse a pattern of only stars"],
    ["a double asterisk in the middle", ["src/**/x.ts"], ["src", "a", "b", "x.ts"], true, "treat `**` as one segment"],
    ["a double asterisk in the middle, no depth", ["src/**/x.ts"], ["src", "x.ts"], true, "require a segment between"],
  ]
  for (const [name, patterns, parts, expected] of meanings)
    test(`matches by the .gitignore meaning: ${name}`, () => {
      expect(ConfigInstructionFile.ruleMatches(patterns, base, at(...parts))).toBe(expected)
    })

  test("matches a spelling of braces that rulePatterns expanded", () => {
    const kept = ConfigInstructionFile.rulePatterns(ConfigMarkdown.split('---\npaths: "src/*.{ts,tsx}"\n---\nB').frontmatter)
    expect(ConfigInstructionFile.ruleMatches(kept.patterns ?? [], base, at("src", "a.tsx"))).toBe(true)
    expect(ConfigInstructionFile.ruleMatches(kept.patterns ?? [], base, at("src", "a.js"))).toBe(false)
  })

  test("matches nothing for the base itself, a file outside it, a sibling whose name starts with the base's, or another drive", () => {
    expect(ConfigInstructionFile.ruleMatches(["*"], base, base)).toBe(false)
    expect(ConfigInstructionFile.ruleMatches(["*"], base, path.resolve("/other/a.ts"))).toBe(false)
    expect(ConfigInstructionFile.ruleMatches(["*"], base, path.resolve("/repository/a.ts"))).toBe(false)
    expect(ConfigInstructionFile.ruleMatches(["*"], base, path.resolve("/repo/../a.ts"))).toBe(false)
    if (process.platform === "win32") expect(ConfigInstructionFile.ruleMatches(["*"], "C:\\repo", "D:\\repo\\a.ts")).toBe(false)
  })

  test("an absolute-looking pattern is anchored to the base and cannot leave it", () => {
    expect(ConfigInstructionFile.ruleMatches(["/etc/**"], base, at("etc", "passwd"))).toBe(true)
    expect(ConfigInstructionFile.ruleMatches(["/etc/**"], base, path.resolve("/etc/passwd"))).toBe(false)
  })

  test("a rule name ends in .md in lower case", () => {
    expect(["a.md", ".b.md"].every(ConfigInstructionFile.isRuleName)).toBe(true)
    expect(["a.MD", "a.txt", "md"].some(ConfigInstructionFile.isRuleName)).toBe(false)
  })
})

describe("ConfigInstructionRules.scan", () => {
  const scan = (directory: string, allow: (real: string) => boolean = () => true) =>
    Effect.gen(function* () {
      const fsUtil = yield* FSUtil.Service
      const found = yield* ConfigInstructionRules.scan({
        directory,
        fs: fsUtil,
        leads: fsUtil.resolve,
        allow: (real) => Effect.succeed(allow(real)),
      })
      return found.map((item) => path.relative(directory, item.file).replaceAll("\\", "/"))
    })
  const write = (file: string, text = "x") =>
    Effect.promise(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text)
    })

  it.live("lists at most MAX_FILES rule files, the first by name, whether they sit in one folder or are spread over subfolders", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const total = ConfigInstructionRules.MAX_FILES + 40
      const name = (index: number) => String(index).padStart(4, "0")
      for (let index = 0; index < total; index++)
        yield* write(path.join(tmp.path, index % 2 === 0 ? `${name(index)}.md` : `sub${index % 7}/${name(index)}.md`))
      const listed = yield* scan(tmp.path)
      expect(listed).toHaveLength(ConfigInstructionRules.MAX_FILES)
      expect(listed[0]).toBe("0000.md")
    }),
  )

  // A repository chooses how many folders it holds, empty ones too, and each one costs a walk of its path and the gate's
  // questions. The cost is counted in the calls made, which does not depend on how fast the host is.
  it.live("enters at most MAX_FOLDERS folders, however many empty ones a rules folder holds", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fsUtil = yield* FSUtil.Service
      const total = 8 * ConfigInstructionRules.MAX_FOLDERS
      yield* Effect.promise(() =>
        Promise.all(Array.from({ length: total }, (_, index) => fs.mkdir(path.join(tmp.path, `r${String(index).padStart(5, "0")}`), { recursive: true }))),
      )
      yield* write(path.join(tmp.path, "zz", "late.md"))
      const asked = { leads: 0, isDir: 0, allow: 0 }
      const found = yield* ConfigInstructionRules.scan({
        directory: tmp.path,
        fs: { ...fsUtil, isDir: (target) => (asked.isDir++, fsUtil.isDir(target)) },
        leads: (spelling) => (asked.leads++, fsUtil.resolve(spelling)),
        allow: () => Effect.sync(() => (asked.allow++, true)),
      })
      expect(asked.leads).toBeLessThanOrEqual(ConfigInstructionRules.MAX_FOLDERS)
      expect(asked.isDir).toBeLessThanOrEqual(ConfigInstructionRules.MAX_FOLDERS)
      expect(asked.allow).toBeLessThanOrEqual(ConfigInstructionRules.MAX_FOLDERS)
      // The folders past the cap are not entered, so the rule file in the last one is not listed.
      expect(found).toHaveLength(0)
    }),
  )

  test("compiles a pattern once, and a pattern that is refused stays refused", () => {
    expect(ConfigInstructionFile.compileRulePattern("src/*.ts")).toBe(ConfigInstructionFile.compileRulePattern("src/*.ts"))
    expect(ConfigInstructionFile.compileRulePattern("/")).toBeUndefined()
    expect(ConfigInstructionFile.ruleMatches(["src/*.ts"], path.resolve("/x"), path.resolve("/x/src/a.ts"))).toBe(true)
  })

  it.live("lists rule files by name in code-unit order, depth first, and takes dot names", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      for (const name of ["c.md", "B.md", "a/z.md", "a/b.md", ".d.md", "n.txt", "u.MD", "e/f/g.md"])
        yield* write(path.join(tmp.path, name))
      expect(yield* scan(tmp.path)).toEqual([".d.md", "B.md", "a/b.md", "a/z.md", "c.md", "e/f/g.md"])
    }),
  )

  it.live("adds nothing for a folder that is missing, or a file where the folder should be", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp.path, "file"))
      expect(yield* scan(path.join(tmp.path, "missing"))).toEqual([])
      expect(yield* scan(path.join(tmp.path, "file"))).toEqual([])
    }),
  )

  it.live("ends a loop of folder links and lists a file reached under two names once", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp.path, "a", "x.md"))
      yield* Effect.promise(() => fs.symlink(tmp.path, path.join(tmp.path, "a", "loop"), "junction"))
      yield* Effect.promise(() => fs.symlink(path.join(tmp.path, "a"), path.join(tmp.path, "twin"), "junction"))
      expect(yield* scan(tmp.path)).toEqual(["a/x.md"])
    }),
  )

  it.live("asks the gate of every folder, skips a folder it refuses, and does not ask it of a plain file", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      for (const name of ["ok.md", "no.md", "closed/in.md", "open/in.md"]) yield* write(path.join(tmp.path, name))
      const asked: string[] = []
      const found = yield* scan(tmp.path, (real) => (asked.push(real), !/closed$/.test(real)))
      expect(found).toEqual(["no.md", "ok.md", "open/in.md"])
      // Only folders: a plain file lies in a folder the gate accepted, and no link is in its path.
      expect(asked.every((real) => !real.endsWith(".md"))).toBe(true)
      expect(asked.length).toBeGreaterThan(0)
    }),
  )

  const gated = canLinkFile ? it.live : it.live.skip
  gated("asks the gate of a file reached through a link, and skips it when refused", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      yield* write(path.join(outside.path, "no.md"))
      yield* write(path.join(tmp.path, "ok.md"))
      yield* Effect.promise(() => fs.symlink(path.join(outside.path, "no.md"), path.join(tmp.path, "link.md"), "file"))
      expect(yield* scan(tmp.path, (real) => !/no\.md$/.test(real))).toEqual(["ok.md"])
    }),
  )

  const links = canLinkFile ? it.live : it.live.skip
  links("skips a dangling link and a link to a folder where a file was named, and costs only itself", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* write(path.join(tmp.path, "kept.md"))
      yield* Effect.promise(async () => {
        await fs.symlink(path.join(tmp.path, "gone.md"), path.join(tmp.path, "dangling.md"))
        await fs.mkdir(path.join(tmp.path, "dir"))
        await fs.symlink(path.join(tmp.path, "dir"), path.join(tmp.path, "folder.md"), "junction")
      })
      expect(yield* scan(tmp.path)).toEqual(["kept.md"])
    }),
  )

  it.live("never opens a network path", () =>
    Effect.gen(function* () {
      const fsUtil = yield* FSUtil.Service
      const touched: string[] = []
      const found = yield* ConfigInstructionRules.scan({
        directory: process.platform === "win32" ? "\\\\decoy-host.invalid\\share\\rules" : "//decoy-host.invalid/share/rules",
        fs: {
          ...fsUtil,
          isDir: (target) => (touched.push(target), fsUtil.isDir(target)),
          readDirectoryEntries: (target) => (touched.push(target), fsUtil.readDirectoryEntries(target)),
        },
        leads: (spelling) => Effect.succeed(spelling),
        allow: () => Effect.succeed(true),
      })
      expect(found).toEqual([])
      expect(touched).toEqual([])
    }),
  )

  // Class 6: the folder itself is a link to a share. Its spelling is a local path, so only the answer of `leads` says so, and
  // nothing is stat'ed or listed before that answer is read.
  it.live("never stats or lists a rules folder whose real path is a network share", () =>
    Effect.gen(function* () {
      const root = path.resolve("/rules")
      const touched: string[] = []
      const found = yield* ConfigInstructionRules.scan({
        directory: root,
        fs: {
          isDir: (target) => Effect.succeed(touched.push(target) > 0),
          isFile: (target) => Effect.succeed(touched.push(target) > 0),
          readDirectoryEntries: (target) =>
            Effect.succeed((touched.push(target), [{ name: "x.md", type: "file" }])) as ReturnType<
              FSUtil.Interface["readDirectoryEntries"]
            >,
        },
        leads: (spelling) =>
          Effect.succeed(
            spelling === root
              ? process.platform === "win32"
                ? "\\\\decoy-host.invalid\\share\\rules"
                : "//decoy-host.invalid/share/rules"
              : spelling,
          ),
        allow: () => Effect.succeed(true),
      })
      expect(found).toEqual([])
      expect(touched).toEqual([])
    }),
  )

  // Class 6: a link in the folder that leads to a share is named as the share by `leads`, and nothing then stats or lists it.
  const share = process.platform === "win32" ? "\\\\decoy-host.invalid\\share\\x.md" : "//decoy-host.invalid/share/x.md"
  for (const [name, entry] of [
    ["a rule file", "x.md"],
    ["a subfolder", "sub"],
  ] as const)
    it.live(`never stats, lists or reads a link to a network share that is ${name}`, () =>
      Effect.gen(function* () {
        const root = path.resolve("/rules")
        const touched: string[] = []
        const found = yield* ConfigInstructionRules.scan({
          directory: root,
          fs: {
            isDir: (target) => Effect.succeed(touched.push(target) > 0 && target === root),
            isFile: (target) => Effect.succeed(touched.push(target) < 0),
            readDirectoryEntries: (target) =>
              Effect.succeed(
                target === root ? [{ name: entry, type: "symlink" }, { name: "kept.md", type: "file" }] : (touched.push(target), []),
              ) as ReturnType<FSUtil.Interface["readDirectoryEntries"]>,
          },
          leads: (spelling) => Effect.succeed(spelling === path.join(root, entry) ? share : spelling),
          allow: () => Effect.succeed(true),
        })
        expect(found.map((item) => path.basename(item.file))).toEqual(["kept.md"])
        expect(touched.filter((target) => /decoy-host/.test(target))).toEqual([])
      }),
    )
})
