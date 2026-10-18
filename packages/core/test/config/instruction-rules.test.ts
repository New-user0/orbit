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
      expect(ConfigInstructionFile.rulePatterns(front(written))).toEqual({ patterns, malformed: false })
    })

  test("says a file without front matter applies from the start", () => {
    expect(ConfigInstructionFile.rulePatterns(undefined)).toEqual({ patterns: undefined, malformed: false })
  })

  test("reports an unquoted list item that starts with an asterisk, which neither read nor the retry accepts", () => {
    expect(ConfigInstructionFile.rulePatterns(front("paths:\n  - **/*.ts"))).toEqual({ patterns: undefined, malformed: true })
  })

  test("reports front matter that does not parse", () => {
    expect(ConfigInstructionFile.rulePatterns(front('paths: "src/**'))).toEqual({ patterns: undefined, malformed: true })
  })

  test("keeps at most 256 patterns and drops one over 1,024 characters, however many braces a file writes", () => {
    const result = ConfigInstructionFile.rulePatterns(front(`paths: "${"{a,b}".repeat(30)}"`))
    expect(result.patterns).toHaveLength(ConfigInstructionFile.RULE_PATTERNS)
    expect(ConfigInstructionFile.rulePatterns(front(`paths: "${"x".repeat(1_025)}, ok"`)).patterns).toEqual(["ok"])
  })

  // The work stops once the cap is kept, so a value of a megabyte costs the parse and no more. It is synchronous, so it runs
  // in a child process with a deadline.
  test("stops expanding once 256 patterns are kept, for a value of a megabyte", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, "..", "fixture", "rule-patterns-stress.ts")],
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 60_000)
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(timer)
    expect(code).toBe(0)
    const report = JSON.parse(out) as { readonly name: string; readonly ms: number; readonly kept: number }[]
    expect(report.map((item) => item.name)).toEqual(["commaString", "commaList", "braceString", "oneHugePart"])
    for (const item of report) {
      expect(item.kept).toBe(item.name === "oneHugePart" ? 0 : ConfigInstructionFile.RULE_PATTERNS)
      expect(item.ms).toBeLessThan(1_500)
    }
  }, 90_000)

  // `ignore` backtracks, and the repository writes both the pattern and the file name: a read must cost a small fixed amount.
  test("matches a read in bounded time, whatever wildcards and depth a repository writes", async () => {
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
      "manyStars",
      "threeGlobstars",
      "twoGlobstarsDeep",
      "twoGlobstarsAtLimit",
      "worstAllowed",
      "twoStarRuns",
      "control",
    ])
    for (const item of report) expect(item.ms).toBeLessThan(1_000)
    expect(report.find((item) => item.name === "control")?.matched).toBe(true)
    expect(report.find((item) => item.name === "manyStars")?.matched).toBe(false)
  }, 90_000)

  test("drops a pattern with many wildcards and keeps the realistic ones", () => {
    const cheap = ConfigInstructionFile.cheapPattern
    expect(["*.ts", "src/**/*.test.ts", "**/*.{ts}", "/src/*.ts", "!a/*.md"].filter(cheap)).toHaveLength(5)
    expect(cheap(`${"*a".repeat(20)}*ab`)).toBe(false)
    expect(cheap("**/a/**/b/**/c")).toBe(false)
  })

  test("reads the block with plain delimiters, whatever spaces follow the dashes on its own lines", () => {
    const frontmatter = ConfigMarkdown.split("---  \npaths: a\n---\t\nBody.").frontmatter
    expect(ConfigInstructionFile.rulePatterns(frontmatter)).toEqual({ patterns: ["a"], malformed: false })
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
    expect(ConfigInstructionFile.rulePatterns(front("paths: src/**"))).toEqual({ patterns: ["src"], malformed: false })
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

  test("matches the path from the base under the rules of a .gitignore", () => {
    expect(ConfigInstructionFile.ruleMatches(["*.ts"], base, at("a", "b", "c.ts"))).toBe(true)
    expect(ConfigInstructionFile.ruleMatches(["/src/*.ts"], base, at("lib", "src", "a.ts"))).toBe(false)
    expect(ConfigInstructionFile.ruleMatches(["src", "!src/gen"], base, at("src", "gen", "x.ts"))).toBe(true)
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

  it.live("asks the gate of every folder and file, and skips what it refuses alone", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      for (const name of ["ok.md", "no.md", "closed/in.md", "open/in.md"]) yield* write(path.join(tmp.path, name))
      expect(yield* scan(tmp.path, (real) => !/no\.md$|closed$/.test(real))).toEqual(["ok.md", "open/in.md"])
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
