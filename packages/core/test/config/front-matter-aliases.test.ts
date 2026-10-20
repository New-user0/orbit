import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import type { Info } from "@orbit/schema/config"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Fingerprint } from "@orbit/core/config/fingerprint"
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
// refuses a block whose value comes to more than its text, for every reader at once, and `Fingerprint.canonical` has an
// allowance of its own for a value that reaches it another way.

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

  test("keeps the value of a file that names an anchor more than once", () => {
    expect(ConfigMarkdown.parseOption(md("base: &b {command: echo}\nhooks: [*b, *b]"))?.data.hooks).toEqual([
      { command: "echo" },
      { command: "echo" },
    ])
  })
})

// The readers of front matter and `Fingerprint.canonical` over levels 6 to 8 and an alias-free control. The work is
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
  const readers = ["agent", "skill", "command", "parseOption", "Fingerprint.directory"]
  const level = (name: string) => readers.map((reader) => `${reader} ${name}`)
  // Mutations: deleting the check in `ConfigMarkdown.read` lets the agent reader take level 6, at 2.5 seconds and 1.8 GB;
  // deleting the `ParsedSize.within` check in `Fingerprint.canonical` writes level 6 out, at 0.2 seconds and 180 MB;
  // deleting the depth check in `ParsedSize.within` overflows the stack at the nested row and the child fails. Each
  // stops the child at that row.
  expect(report.map((row) => row.name)).toEqual([
    ...level("control"),
    "Fingerprint.canonical control",
    ...level("level 6"),
    "Fingerprint.canonical level 6",
    "Fingerprint.canonical nested 100,000 deep",
    "Fingerprint.canonical holds itself",
    ...level("level 7"),
    "Fingerprint.canonical level 7",
    ...level("level 8"),
    "Fingerprint.canonical level 8",
  ])
  for (const row of report) {
    expect({ name: row.name, refused: row.refused }).toEqual({ name: row.name, refused: row.hostile })
    expect(row.ms).toBeLessThan(1_000)
    expect(row.growthMB).toBeLessThan(64)
  }
}, 90_000)

describe("Fingerprint answers unreadable for a value too large to write out", () => {
  const holdsItself = () => {
    const value: unknown[] = ["x"]
    value.push(value)
    return value
  }
  it.live("for a document kind, once in the log, and digests the kinds beside it", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const files = yield* FSUtil.Service
      // A config file's JSON cannot hold itself, so the value is built here.
      const info = { mcp: holdsItself(), shell: "bash" } as unknown as Info
      // Mutation: deleting the `ParsedSize.within` check in `canonical` overflows the stack and the load fails.
      const digests = yield* Fingerprint.document(files, "orbit.json", info, [], []).pipe(Effect.provide(logged(logs)))
      expect(digests.mcp).toBe(WorkspaceTrust.unreadable)
      expect(digests.shell).toMatch(/^[0-9a-f]{64}$/)
      expect(logs.filter((line) => line.includes("config fingerprint unreadable") && line.includes('"mcp"'))).toHaveLength(1)
    }),
  )
})

describe("an untrusted project whose agent and skill files are aliased", () => {
  // The agent's level 7 stands for a hundred million values in 492 bytes: before the fix, the load wrote them out and grew
  // by about two gigabytes. The skill's level 6 stands for ten million.
  const agent = path.join(".orbit", "agents", "x.md")
  const skill = path.join(".orbit", "skills", "x", "SKILL.md")
  const project = (fronts: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "repo")
      yield* Effect.promise(async () => {
        for (const [file, front] of Object.entries(fronts)) {
          await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true })
          await fs.writeFile(path.join(repo, file), md(front))
        }
      })
      return { root, repo }
    })
  const load = (made: { readonly root: string; readonly repo: string }, logs: string[]) =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      yield* config.entries()
      return (yield* config.fingerprints()).filter((item) => item.path.endsWith(".orbit")).map((item) => item.digests)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]), [
          Config.node.replace(Config.configured({ content: "{}" })),
          WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(made.repo) }))),
          ),
          Global.node.replace(
            Global.layerWith({
              config: path.join(made.root, "home", ".config", "orbit"),
              home: path.join(made.root, "home"),
            }),
          ),
          Credential.node.replace(emptyCredentialNode),
          WellKnown.node.replace(emptyWellknownNode),
          Watcher.node.replace(Watcher.testLayer),
        ]),
      ),
      Effect.provide(logged(logs)),
    )

  it.live("loads in little time, with each file refused in one log line and no hooks digested", () =>
    Effect.gen(function* () {
      const made = yield* project({ [agent]: aliased(7), [skill]: aliased(6) })
      const logs: string[] = []
      const started = performance.now()
      const digests = yield* load(made, logs)
      // Mutation: deleting the check in `ConfigMarkdown.read` leaves the files to the fingerprint's own allowance, which
      // answers `unreadable` for their hooks and logs no refusal of either file.
      expect(performance.now() - started).toBeLessThan(5_000)
      expect(digests).toEqual([{}])
      // The log writes its fields as JSON, where a backslash of a Windows path is doubled.
      const skipped = logs.filter((line) => line.includes("config file skipped"))
      expect(skipped).toHaveLength(2)
      for (const file of [agent, skill])
        expect(skipped.filter((line) => line.includes(JSON.stringify(file).slice(1, -1)))).toHaveLength(1)
    }),
  )

  it.live("control: the same files written out without aliases are digested and log nothing", () =>
    Effect.gen(function* () {
      const made = yield* project({ [agent]: "description: plain\nhooks: [x, x]", [skill]: "name: x\nhooks: [x, x]" })
      const logs: string[] = []
      const digests = yield* load(made, logs)
      expect(digests).toHaveLength(1)
      expect(digests[0]?.hooks).toMatch(/^[0-9a-f]{64}$/)
      expect(logs.filter((line) => line.includes("config file skipped"))).toEqual([])
    }),
  )
})

// Each line as the configured logger would write it: the message and then its fields, as JSON.
const logged = (logs: string[]) =>
  Logger.layer([
    Logger.make(({ message }) => {
      logs.push(JSON.stringify(message))
    }),
  ])
