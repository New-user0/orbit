import path from "path"
import matter from "gray-matter"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigMarkdown } from "@orbit/core/config/markdown"
import { AgentFile } from "@orbit/core/config/plugin/agent-file"
import { CommandFile } from "@orbit/core/config/plugin/command-file"
import { SkillFile } from "@orbit/core/config/plugin/skill-file"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { scriptedMarkdown } from "../fixture/front-matter"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

// gray-matter reads all of these as JavaScript, with or without a space after the delimiter.
const languages = ["js", "javascript", "JS", "JavaScript", " js"]

const ran = (marker: string) => Bun.file(marker).exists()

describe("ConfigMarkdown", () => {
  test("reads YAML front matter", () => {
    expect(ConfigMarkdown.parseOption("---\nname: demo\nmetadata:\n  tags: [a, b]\n---\nBody.")).toMatchObject({
      data: { name: "demo", metadata: { tags: ["a", "b"] } },
      content: "Body.",
    })
  })

  for (const language of languages) {
    test(`refuses front matter that opens with ---${language}, and runs nothing`, async () => {
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "ran")
      const content = scriptedMarkdown(marker, language)
      expect(ConfigMarkdown.parseOption(content)).toBeUndefined()
      expect(() => ConfigMarkdown.parse(content)).toThrow("JavaScript front matter is not supported")
      expect(await ran(marker)).toBe(false)
    })
  }

  // gray-matter's YAML engine is js-yaml's safe schema, which has no `!!js/` types. js-yaml's full schema builds a function
  // with `new Function` from `!!js/function` (js-yaml 3 brings esprima, which it needs for that), a RegExp from
  // `!!js/regexp` and `undefined` from `!!js/undefined`, out of a file that a clone ships.
  const tagged: ReadonlyArray<readonly [string, string]> = [
    ["!!js/function, quoted", "key: !!js/function 'function () { return 1 }'"],
    ["!!js/function, folded", "key: !!js/function >\n  function () { return 1 }"],
    ["!!js/regexp", "key: !!js/regexp /a/"],
    ["!!js/undefined", "key: !!js/undefined ''"],
  ]
  for (const [tag, line] of tagged)
    test(`refuses the JavaScript type ${tag} of YAML, and reads it as text only when asked`, () => {
      // Mutation: reading the block with js-yaml's `load` (its full schema) in place of gray-matter's YAML engine reads
      // every row, the two `!!js/function` rows as functions.
      const content = `---\n${line}\n---\nBody.`
      expect(ConfigMarkdown.parseOption(content)).toBeUndefined()
      // The control: the indicator retry quotes the value, so the same block reads as text.
      const values = Object.values(ConfigMarkdown.parseOption(content, true)?.data ?? {})
      expect(values.map((value) => typeof value)).toEqual(["string"])
    })

  // gray-matter keeps what it parsed by content, and keeps a parse that failed as if it had worked.
  test("reads a file that needs its colons quoted the same way every time", () => {
    const content = "---\ndescription: Use when: it fits\n---\nBody."
    const reads = Array.from({ length: 3 }, () => ConfigMarkdown.parseOption(content))
    for (const read of reads) {
      expect(read).toMatchObject({ data: { description: "Use when: it fits" }, content: "Body." })
    }
  })

  test("skips a file whose front matter cannot be read, every time", () => {
    const content = "---\nmetadata: [\n---\nBody."
    expect(Array.from({ length: 2 }, () => ConfigMarkdown.parseOption(content))).toEqual([undefined, undefined])
  })

  // The lines of the block are split at LF and CRLF, so a line can hold a lone CR, U+2028 or U+2029, and its value is read
  // to the end of the line like any other. The U+0085 row is a control: a plain `.` always took that character. Mutation:
  // dropping the `s` flag of the line match in `sanitize` leaves those lines as they were written, and the first three
  // rows read nothing.
  const separated: ReadonlyArray<readonly [string, string, string]> = [
    ["U+2028", "---\ndescription: Use when: a\u2028b\n---\nBody.", "Use when: a\u2028b"],
    ["U+2029", "---\ndescription: Use when: a\u2029b\n---\nBody.", "Use when: a\u2029b"],
    ["a CR before the CRLF", "---\r\ndescription: Use when: it fits\r\r\n---\r\nBody.", "Use when: it fits"],
    ["U+0085", "---\ndescription: Use when: a\u0085b\n---\nBody.", "Use when: a\u0085b"],
  ]
  for (const [spelling, content, description] of separated)
    test(`quotes the colons of a value that holds ${spelling}`, () => {
      expect(ConfigMarkdown.parseOption(content)?.data).toEqual({ description })
    })

  // A run of spaces or tabs before a value that holds a separator, and a block with a long run of empty lines, each
  // against a control of letters as long. The work is synchronous, so it runs in a child process with a deadline.
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
    // Mutation: dropping the `s` flag of the line match in `sanitize` takes the lone CR, U+2028 and U+2029 line rows from
    // about a millisecond to seconds each, and the child's deadline kills the run. Reading through gray-matter's own
    // reader again (`matter(content, options)` in `read`) takes the rows of empty lines from a few milliseconds to
    // seconds each.
    const rows = report.filter((item) => item.name.startsWith("parseOption"))
    expect(rows).toHaveLength(17)
    expect(rows.filter((item) => item.hostile >= item.control * 4 + 250)).toEqual([])
  }, 90_000)

  // `read` finds and reads the block as gray-matter 4 did with the JavaScript engine refused, so every reader keeps the
  // data and the text it had. Each generated file is read both ways, with and without the indicator retry.
  test("reads every file as gray-matter does, data, text and refusals", () => {
    const options = {
      engines: {
        javascript: () => {
          throw new Error("JavaScript front matter is not supported")
        },
      },
    }
    // The reader that `parse` had before, with the same retries.
    const before = (content: string, indicators: boolean) => {
      const attempt = (text: string) => {
        const file = matter(text, options)
        return { data: file.data, content: file.content }
      }
      try {
        return attempt(content)
      } catch {
        try {
          return attempt(ConfigMarkdown.sanitize(content))
        } catch {
          if (!indicators) return undefined
          try {
            return attempt(ConfigMarkdown.sanitize(content, true))
          } catch {
            return undefined
          }
        }
      }
    }
    let seed = 7
    const pick = <T>(items: readonly T[]) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return items[Math.floor((seed / 4294967296) * items.length)]!
    }
    const openers = ["---", "---\n", "---\r\n", "---yaml\n", "--- yaml \n", "---YML\n", "---json\n", "---JSON\n", "---js\n",
      "--- js\n", "---coffee\n", "----\n", "\uFEFF---\n", "", "x\n---\n", "---  \n", "---yaml", "---json", "--- \n",
      "---\u00A0\n", "---\u2028\n", "---\u000b\n"]
    const lines = ["a: b", "a: b: c", "# c", "#", "  # c", "\t# c", "#c", "", " ", "-", "- a", "[", "{", '{"a": 1}', "'a'",
      "|", "  x", "key: |", "  line", "!!js/function >", "&a 1", "*a", "paths: **/*.ts", "description: Use when: x",
      "\u2028", "\u00a0# c", "\u2028# c", "\r", "---", "--- x", "x: 1\r", "\u0085", "@a", "? a", "1", "null", "[1, 2]"]
    const breaks = ["\n", "\n", "\r\n", "\r", "\u2028"]
    const closers = ["\n---\n", "\n---", "\r\n---\r\n", "\n--- x\n", "\n----\n", "", "\n---\nbody\n", "\n---\n\n\nbody"]
    const differences = Array.from({ length: 4_000 }, () => {
      const block = Array.from({ length: pick([0, 1, 2, 3, 4, 5, 6, 7]) }, () => pick(lines)).join(pick(breaks))
      return pick(openers) + block + pick(closers) + pick(["", "Body.", "\r\nBody", "x\n---\ny"])
    }).flatMap((content) =>
      [false, true].flatMap((indicators) => {
        const after = ConfigMarkdown.parseOption(content, indicators)
        const found = after && { data: after.data, content: after.content }
        return Bun.deepEquals(found, before(content, indicators)) ? [] : [{ content, indicators }]
      }),
    )
    // Mutation: `read` taking a `#` with nothing after it on its line for a comment, a CR or U+2028 for the end of a
    // comment, an unknown language for YAML, or a JSON block with only comments for JSON, gives rows here. So does
    // cutting from the block an opener line of whitespace that YAML does not skip (NBSP, U+2028, VT), which gray-matter
    // keeps in the block because its language is empty.
    expect(differences).toEqual([])
  })
})

// The readers of every kind of file that a config directory holds in Markdown, which a cloned repository can fill.
describe("Markdown files with front matter written in JavaScript", () => {
  it.live("define no command, and run nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      const marker = path.join(tmp.path, "ran")
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "commands", "scripted.md"), scriptedMarkdown(marker)),
          Bun.write(path.join(tmp.path, "commands", "plain.md"), "---\ndescription: Plain\n---\nBody."),
        ]),
      )
      expect((yield* CommandFile.load(fs, tmp.path)).map((command) => command.name)).toEqual(["plain"])
      expect(yield* Effect.promise(() => ran(marker))).toBe(false)
    }),
  )

  it.live("define no agent, and run nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      const marker = path.join(tmp.path, "ran")
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "agents", "scripted.md"), scriptedMarkdown(marker)),
          Bun.write(path.join(tmp.path, "agents", "plain.md"), "---\ndescription: Plain\n---\nBody."),
        ]),
      )
      const documents = yield* AgentFile.load(fs, tmp.path)
      expect(documents.flatMap((document) => Object.keys(document.info.agents ?? {}))).toEqual(["plain"])
      expect(yield* Effect.promise(() => ran(marker))).toBe(false)
    }),
  )

  test("define no skill, and run nothing", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "ran")
    expect(SkillFile.parse("/repo/skills", "/repo/skills/scripted/SKILL.md", scriptedMarkdown(marker))).toEqual({
      _tag: "Skipped",
      reason: "markdown",
    })
    expect(await ran(marker)).toBe(false)
  })
})

// The splitter that instruction files go through (`ConfigInstructionFile`) finds a block of front matter from its delimiter
// lines alone, so no spelling of one is read as code, and the stripper and any later reader agree on what front matter is.
describe("ConfigMarkdown.split", () => {
  test("gives the block, with its delimiter lines, and the text after it", () => {
    expect(ConfigMarkdown.split("---\nname: demo\n---\nBody.")).toEqual({
      frontmatter: "---\nname: demo\n---\n",
      body: "Body.",
    })
    expect(ConfigMarkdown.split("---\r\nname: demo\r\n---  \r\n\r\nBody.\r\n")).toEqual({
      frontmatter: "---\r\nname: demo\r\n---  \r\n",
      body: "\r\nBody.\r\n",
    })
    expect(ConfigMarkdown.split("---\n---")).toEqual({ frontmatter: "---\n---", body: "" })
    expect(ConfigMarkdown.split("---\n---\n")).toEqual({ frontmatter: "---\n---\n", body: "" })
  })

  test("gives a block that `parseOption` reads, so that a later reader parses only what the splitter found", () => {
    const text = "---\nname: demo\nmetadata:\n  tags: [a, b]\n---\nBody."
    const split = ConfigMarkdown.split(text)
    expect(ConfigMarkdown.parseOption(split.frontmatter!)).toMatchObject({
      data: { name: "demo", metadata: { tags: ["a", "b"] } },
      content: "",
    })
    expect(split.frontmatter! + split.body).toBe(text)
  })

  test("returns the text whole for everything that is not front matter", () => {
    for (const text of [
      "",
      "Body.",
      "---",
      "---\n",
      "---\nname: demo\nBody.",
      "---\nname: demo---\nBody.",
      "---\nname: demo\n----\nBody.",
      "---\nname: demo\n--- x\nBody.",
      "\n---\nname: demo\n---\nBody.",
      " ---\nname: demo\n---\nBody.",
      "----\nname: demo\n---\nBody.",
      "---x\nname: demo\n---\nBody.",
      "--\nname: demo\n--\nBody.",
      ...languages.map((language) => `---${language}\nname: demo\n---\nBody.`),
      "---coffee\nname: demo\n---\nBody.",
    ])
      expect(ConfigMarkdown.split(text)).toEqual({ body: text })
  })

  // Whatever follows the dashes, the text of a block is never given to a parser here: a script that would run is the
  // text of a file whose first line is not a delimiter, and of a bare block, which only `parseOption` ever reads.
  for (const language of languages) {
    test(`does not take ---${language} for a delimiter, and runs nothing`, async () => {
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "ran")
      const text = scriptedMarkdown(marker, language)
      expect(ConfigMarkdown.split(text)).toEqual({ body: text })
      expect(await ran(marker)).toBe(false)
    })
  }
})
