/**
 * Reads front matter whose anchors each list the one before ten times, at levels 6 to 8 (a few hundred bytes that stand
 * for ten million to a billion values), and a control that writes the same lines without aliases, through each reader of
 * front matter, and measures `Fingerprint.canonical` on values that hold one list in many places, hold themselves or nest
 * deeper than a copy can recurse. It prints, for each row, whether the value was refused, how long the row took and how
 * much the process grew, as JSON. It is a script of its own because the work is synchronous: the test starts it with a
 * deadline. Rows run level by level, and the script stops after the first row that accepts a value it should refuse,
 * refuses a control, or takes or grows too much, so that a reader without its bound never meets the larger levels.
 */
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { Fingerprint } from "@orbit/core/config/fingerprint"
import { ConfigMarkdown } from "@orbit/core/config/markdown"
import { AgentFile } from "@orbit/core/config/plugin/agent-file"
import { CommandFile } from "@orbit/core/config/plugin/command-file"
import { SkillFile } from "@orbit/core/config/plugin/skill-file"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"

// What a row may take before the script stops; the test holds every row to the same.
const LIMITS = { ms: 1_000, growthMB: 64 }

const root = process.argv[2]
if (root === undefined) throw new Error("usage: front-matter-alias-stress.ts <empty folder>")

// `a0` lists ten values and each later anchor lists the one before ten times; the keys that the readers keep name the
// last. The control writes each list with plain values of the same length in place of the aliases.
const lines = (level: number, aliased: boolean) => [
  "description: aliased",
  `a0: ${aliased ? "&a0 " : ""}[${Array(10).fill("x").join(", ")}]`,
  ...Array.from({ length: level }, (_, index) =>
    aliased
      ? `a${index + 1}: &a${index + 1} [${Array(10).fill(`*a${index}`).join(", ")}]`
      : `a${index + 1}: [${Array(10).fill(`b${index}`).join(", ")}]`,
  ),
  ...["hooks", "mcp_servers", "metadata"].map((key) => `${key}: ${aliased ? `*a${level}` : "[c, c]"}`),
]

// One config folder for each file: an agent, a skill and a command that carry the same front matter.
const folderOf = async (name: string, level: number, aliased: boolean) => {
  const folder = path.join(root, name, ".orbit")
  const text = `---\n${lines(level, aliased).join("\n")}\n---\nBody.\n`
  for (const file of ["agents/x.md", "skills/x/SKILL.md", "commands/x.md"]) {
    await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true })
    await fs.writeFile(path.join(folder, file), text)
  }
  return { folder, text }
}

// A list of ten values, then `level` lists that each hold the one before ten times, built in memory.
const shared = (level: number) =>
  Array.from({ length: level }).reduce<unknown[]>((inner) => Array(10).fill(inner), Array(10).fill("x"))
const holdsItself = () => {
  const value: unknown[] = ["x"]
  value.push(value)
  return { hooks: value }
}
const nested = (depth: number) => Array.from({ length: depth }).reduce<unknown[]>((inner) => [inner], [])

type Row = {
  readonly name: string
  readonly hostile: boolean
  readonly refused: (files: FSUtil.Interface) => Effect.Effect<boolean, unknown>
}

const readers = (level: number, aliased: boolean) =>
  Effect.promise(() => folderOf(`${aliased ? "level" : "control"}-${level}`, level, aliased)).pipe(
    Effect.map((made): Row[] => {
      const name = (reader: string) => `${reader} ${aliased ? `level ${level}` : "control"}`
      return [
        {
          name: name("agent"),
          hostile: aliased,
          refused: (files) => AgentFile.load(files, made.folder).pipe(Effect.map((documents) => documents.length === 0)),
        },
        {
          name: name("skill"),
          hostile: aliased,
          refused: () =>
            Effect.sync(
              () =>
                SkillFile.parse(path.join(made.folder, "skills"), path.join(made.folder, "skills", "x", "SKILL.md"), made.text)
                  ._tag === "Skipped",
            ),
        },
        {
          name: name("command"),
          hostile: aliased,
          refused: (files) => CommandFile.load(files, made.folder).pipe(Effect.map((commands) => commands.length === 0)),
        },
        {
          // The output styles and the `paths` of a rule are read through `parseOption` itself.
          name: name("parseOption"),
          hostile: aliased,
          refused: () => Effect.sync(() => ConfigMarkdown.parseOption(made.text) === undefined),
        },
        {
          // A file that is refused carries no hooks and no servers, so the folder has no digest of either.
          name: name("Fingerprint.directory"),
          hostile: aliased,
          refused: (files) =>
            Fingerprint.directory(files, made.folder, [path.dirname(made.folder)]).pipe(
              Effect.map((digests) => digests.hooks === undefined && digests.mcp === undefined),
            ),
        },
      ]
    }),
  )

const canonical = (name: string, hostile: boolean, value: () => unknown): Row => ({
  name: `Fingerprint.canonical ${name}`,
  hostile,
  refused: () => Effect.sync(() => Fingerprint.canonical(value()) === undefined),
})

const program = Effect.gen(function* () {
  const files = yield* FSUtil.Service
  const rows = [
    ...(yield* readers(6, false)),
    canonical("control", false, () => shared(3)),
    ...(yield* readers(6, true)),
    canonical("level 6", true, () => shared(6)),
    canonical("nested 100,000 deep", true, () => nested(100_000)),
    canonical("holds itself", true, holdsItself),
    ...(yield* readers(7, true)),
    canonical("level 7", true, () => shared(7)),
    ...(yield* readers(8, true)),
    canonical("level 8", true, () => shared(8)),
  ]
  const report: { name: string; hostile: boolean; refused: boolean; ms: number; cpu: number; growthMB: number }[] = []
  for (const row of rows) {
    Bun.gc(true)
    const before = process.memoryUsage().rss
    const started = performance.now()
    const processor = process.cpuUsage()
    const refused = yield* row.refused(files)
    const used = process.cpuUsage(processor)
    const item = {
      name: row.name,
      hostile: row.hostile,
      refused,
      ms: performance.now() - started,
      cpu: (used.user + used.system) / 1_000,
      growthMB: (process.memoryUsage().rss - before) / 1_048_576,
    }
    report.push(item)
    if (item.refused !== row.hostile || item.ms > LIMITS.ms || item.growthMB > LIMITS.growthMB) break
  }
  return report
})

const report = await Effect.runPromise(
  program.pipe(Effect.provide(Layer.merge(AppNodeBuilder.build(LayerNode.group([FSUtil.node])), Logger.layer([])))),
)
console.log(JSON.stringify(report))
