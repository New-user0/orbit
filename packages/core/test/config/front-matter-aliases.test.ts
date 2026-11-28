import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigInstructionFile } from "@orbit/core/config/instruction-file"
import { ConfigMarkdown } from "@orbit/core/config/markdown"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { ParsedSize } from "@orbit/util/parsed-size"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Class 7: YAML keeps an alias as a second reference to what its anchor names, so a few hundred bytes of front matter can
// stand for billions of values, and every reader that copies or serializes them pays for each. `ConfigMarkdown.read`
// refuses a block whose value comes to more than its text, for every reader at once.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

// `a0` lists ten values and each later anchor lists the one before ten times, so `a<level>` stands for 10^(level+1).
const aliased = (level: number) =>
  [
    "description: aliased",
    `a0: &a0 [${Array(10).fill("x").join(", ")}]`,
    ...Array.from({ length: level }, (_, index) => `a${index + 1}: &a${index + 1} [${Array(10).fill(`*a${index}`).join(", ")}]`),
    `hooks: *a${level}`,
  ].join("\n")

const md = (front: string) => `---\n${front}\n---\nBody.\n`

describe("ParsedSize.within", () => {
  // Each value counts one, and a string or an object key its length as well; the indexes of a list count nothing.
  const nested = (depth: number) => Array.from({ length: depth }).reduce<unknown[]>((inner) => [inner], [])
  const shared = Array(3).fill("ab")
  const rows: ReadonlyArray<readonly [string, unknown, number]> = [
    ["a number", 7, 1],
    ["a string", "abc", 4],
    ["a list of two strings", ["a", "b"], 5],
    ["an object", { ab: "c" }, 5],
    // The object, its two keys of one character, and two lists of three strings of two characters, each counted where it
    // is named.
    ["one list named twice", { x: shared, y: shared }, 1 + 2 * 2 + 2 * 3 * 3],
  ]
  for (const [name, value, size] of rows)
    test(`counts ${name} as ${size}`, () => {
      expect(ParsedSize.within(value, size)).toBe(true)
      expect(ParsedSize.within(value, size - 1)).toBe(false)
    })

  test(`refuses a list ${ParsedSize.DEPTH} levels below the value and takes one a level higher`, () => {
    expect(ParsedSize.within(nested(ParsedSize.DEPTH - 1), Infinity)).toBe(true)
    expect(ParsedSize.within(nested(ParsedSize.DEPTH), Infinity)).toBe(false)
  })
})

describe("ConfigMarkdown refuses front matter that comes to more than its text", () => {
  const rows: ReadonlyArray<readonly [string, string, boolean]> = [
    ["aliases that stand for a thousand values in a file of a few hundred bytes", aliased(2), false],
    ["aliases that stand for ten thousand values", aliased(3), true],
    ["aliases that stand for a billion values", aliased(8), true],
    // 24 kilobytes that stand for 20 megabytes of text, though only a thousand and two values.
    ["one long string named a thousand times", `s: &s "${"y".repeat(20_000)}"\nhooks: [${Array(1_000).fill("*s").join(", ")}]`, true],
    ["a list that holds itself", "hooks: &a [x, *a]", true],
    ["a mapping that holds itself", "hooks: &a\n  next: *a", true],
    ["an anchor named twice", "base: &b {command: echo}\nhooks: [*b, *b]", false],
    // Larger than the margin on its own, and written out: the allowance grows with the text.
    ["twenty thousand values written out", `hooks: [${Array(20_000).fill("x").join(", ")}]`, false],
    [`lists nested ${ParsedSize.DEPTH - 1} deep`, `hooks: ${"[".repeat(ParsedSize.DEPTH - 1)}${"]".repeat(ParsedSize.DEPTH - 1)}`, false],
    [`lists nested ${ParsedSize.DEPTH} deep`, `hooks: ${"[".repeat(ParsedSize.DEPTH)}${"]".repeat(ParsedSize.DEPTH)}`, true],
  ]
  // Mutation: deleting the `ParsedSize.within` check in `read` parses every row.
  for (const [name, front, refused] of rows)
    test(`${refused ? "refuses" : "reads"} ${name}`, () => {
      expect(ConfigMarkdown.parseOption(md(front)) === undefined).toBe(refused)
      if (refused) expect(() => ConfigMarkdown.parse(md(front))).toThrow(ConfigMarkdown.Oversized)
    })

  // A block is refused as YAML reads it, and never read again with its aliases written as text, whichever retry of
  // `parse` would take it. The first row puts its aliases on a line that also holds a colon, which the retry of every
  // reader (`sanitize`) writes as text. The second opens with a line that YAML refuses as written, so the first retry
  // reads its aliases, and the last retry of a rule's `paths` (`indicators`) would write its anchor and aliases as text.
  // Mutations: deleting the first check in `parse` reads the first row in both modes; deleting the second reads the
  // second row's `paths` as the text `[*s, *s, ...]`.
  const named = `s: &s "${"y".repeat(20_000)}"`
  const aliases = Array(1_000).fill("*s").join(", ")
  const retried: ReadonlyArray<readonly [string, string]> = [
    ["aliases on a line that holds a colon", `${named}\nhooks: [${aliases}] # note: aliased`],
    ["aliases after a line that YAML refuses as written", `description: note: aliased\n${named}\npaths: [${aliases}]`],
  ]
  for (const [name, front] of retried)
    test(`refuses ${name} in every retry, and the rule that holds it waits`, () => {
      for (const indicators of [false, true])
        expect(() => ConfigMarkdown.parse(md(front), indicators)).toThrow(ConfigMarkdown.Oversized)
      expect(ConfigInstructionFile.rulePatterns(ConfigMarkdown.split(md(front)).frontmatter)).toEqual({
        patterns: [],
        malformed: false,
        dropped: 1,
      })
    })

  test("keeps the value of a file that names an anchor more than once", () => {
    expect(ConfigMarkdown.parseOption(md("base: &b {command: echo}\nhooks: [*b, *b]"))?.data.hooks).toEqual([
      { command: "echo" },
      { command: "echo" },
    ])
  })
})

// The readers of front matter over levels 6 to 8 and an alias-free control. The work is
// synchronous, so it runs in a child process with a deadline, which also stops at the first row over its bounds so that
// a reader without them never meets the larger levels.
test("every reader refuses aliased front matter at once, in little time and memory", async () => {
  await using dir = await tmpdir()
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "..", "fixture", "front-matter-alias-stress.ts"), dir.path],
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 60_000)
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  clearTimeout(timer)
  expect(code).toBe(0)
  const report = JSON.parse(out) as {
    readonly name: string
    readonly hostile: boolean
    readonly refused: boolean
    readonly ms: number
    readonly cpu: number
    readonly growthMB: number
  }[]
  const readers = ["agent", "skill", "command", "parseOption"]
  const level = (name: string) => readers.map((reader) => `${reader} ${name}`)
  // Mutation: deleting the check in `ConfigMarkdown.read` lets the agent reader take level 6, at 2.5 seconds and 1.8 GB,
  // which stops the child at that row.
  expect(report.map((row) => row.name)).toEqual([
    ...level("control"),
    ...level("level 6"),
    ...level("level 7"),
    ...level("level 8"),
  ])
  for (const row of report) {
    expect({ name: row.name, refused: row.refused }).toEqual({ name: row.name, refused: row.hostile })
    expect(row.ms).toBeLessThan(1_000)
    expect(row.growthMB).toBeLessThan(64)
  }
}, 90_000)
