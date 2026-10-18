import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { ConfigInstructionRules } from "@orbit/core/config/instruction-rules"
import { CompatMcpJson } from "@orbit/compat/mcp-json"
import { CompatNames } from "@orbit/compat/names"
import { CompatRoots } from "@orbit/compat/roots"
import { CompatSettings } from "@orbit/compat/settings"
import { ConfigVariable } from "@orbit/core/config/variable"
import { AgentFile } from "@orbit/core/config/plugin/agent-file"
import { CommandFile } from "@orbit/core/config/plugin/command-file"
import { PluginSourceDirectory } from "@orbit/core/plugin/source-directory"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { canLinkFile } from "./fixture/symlink"
import { tempGlobalLayer } from "./fixture/global"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Class 6, M3 verification round 5: every listing and every probe of a path that a repository supplies goes through
// `LinkShare`, so a link to a share is never opened, at the root of a loader's folder or one level below it. Each row
// links one place to a share that nobody answers (TEST-NET, never routable) and asks the real loader. The recorded file
// system is the oracle: no call but `readLink` may name the link or anything below it, and the `glob` package (`scan`),
// which follows every link it meets, is not used on a repository path at all.

setDefaultTimeout(30_000)
const win = process.platform === "win32"
let next = 140
const host = () => `203.0.113.${next++}`

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const command = "---\ndescription: x\n---\nrun it\n"
const agent = "---\ndescription: x\nmode: subagent\n---\nbe an agent\n"

const touched = (calls: readonly string[], at: string) => {
  const root = at.toLowerCase()
  return calls.filter((call) => {
    const [method, ...rest] = call.split(" ")
    const file = rest.join(" ").toLowerCase()
    return method === "scan" || (method !== "readLink" && (file === root || file.startsWith(root + path.sep)))
  })
}

const link = async (project: string, place: string) => {
  // The parent of the link exists, so that the link itself is the only thing that is not local.
  await fs.mkdir(path.dirname(path.join(project, place)), { recursive: true })
  await fs.symlink(`\\\\${host()}\\share`, path.join(project, place), "dir")
}

// Each loader as the server runs it, with the places a repository can link, at the folder's root and one level below.
const loaders = [
  {
    name: "CommandFile.load",
    links: [".orbit/commands", ".orbit/command", ".orbit/commands/sub"],
    run: (files: FSUtil.Interface, project: string) => CommandFile.load(files, path.join(project, ".orbit")),
  },
  {
    name: "AgentFile.load",
    links: [".orbit/agents", ".orbit/agent", ".orbit/modes", ".orbit/mode", ".orbit/agents/sub"],
    run: (files: FSUtil.Interface, project: string) => AgentFile.load(files, path.join(project, ".orbit")),
  },
  {
    name: "PluginSourceDirectory.discover",
    links: [".orbit/plugins", ".orbit/plugin", ".orbit/plugins/p"],
    run: (files: FSUtil.Interface, project: string) =>
      PluginSourceDirectory.discover(files, path.join(project, ".orbit")),
  },
  {
    name: "LinkShare.scan",
    links: [".orbit/skills", ".orbit/skills/x", `${CompatNames.vendor.directory}/skills`, `${CompatNames.vendor.directory}/skills/x`],
    run: (files: FSUtil.Interface, project: string) =>
      Effect.gen(function* () {
        for (const folder of [".orbit/skills", `${CompatNames.vendor.directory}/skills`])
          yield* LinkShare.scan(files, path.join(project, folder), ["{*.md,**/SKILL.md}"])
      }),
  },
  {
    name: "ConfigInstructionRules.scan",
    links: [".orbit/rules", ".orbit/rules/sub", ".orbit/rules/x.md", `${CompatNames.vendor.directory}/rules`],
    run: (files: FSUtil.Interface, project: string) =>
      Effect.gen(function* () {
        // `leads` names a share as ProjectTrust.leads does, without opening it.
        const leads = (spelling: string) =>
          LinkShare.of(files, spelling).pipe(
            Effect.flatMap((shared) => (shared === undefined ? files.resolve(spelling) : Effect.succeed(shared))),
          )
        for (const folder of [".orbit/rules", `${CompatNames.vendor.directory}/rules`])
          yield* ConfigInstructionRules.scan({
            directory: path.join(project, folder),
            fs: files,
            leads,
            allow: () => Effect.succeed(true),
          })
      }),
  },
] as const

describe.skipIf(!win || !canLinkFile)("a link to a share inside a loader's folder", () => {
  for (const loader of loaders)
    for (const place of loader.links)
      it.live(`${loader.name} does not open ${place} linked to a share`, () =>
        Effect.gen(function* () {
          const project = path.join((yield* tmpdirScoped()).path, "project")
          yield* Effect.promise(() => link(project, place))
          const recorded = recordedFileSystem()
          const files = yield* FSUtil.Service.pipe(Effect.provide(recorded.layer))
          const started = Date.now()
          yield* loader.run(files, project).pipe(Effect.exit)
          expect(Date.now() - started).toBeLessThan(15_000)
          expect(touched(recorded.calls, path.join(project, place))).toEqual([])
        }),
      )

  for (const place of [CompatNames.vendor.directory, CompatNames.agents, `${CompatNames.vendor.directory}/skills`])
    it.live(`CompatRoots.discover does not resolve ${place} linked to a share`, () =>
      Effect.gen(function* () {
        const project = path.join((yield* tmpdirScoped()).path, "project")
        yield* Effect.promise(() => link(project, place))
        const recorded = recordedFileSystem()
        const roots = yield* CompatRoots.discover({ directories: [project], global: false }).pipe(
          Effect.provide(recorded.layer),
          Effect.provide(tempGlobalLayer),
        )
        expect(touched(recorded.calls, path.join(project, place))).toEqual([])
        if (!place.endsWith("skills")) expect(roots.map((root) => root.path)).not.toContain(path.join(project, place))
      }),
    )

  // The files a loader reads once their folder is known: each is a link to a share, and none is opened.
  it.live("settings, the MCP file and a {file:} reference that link to a share are not read", () =>
    Effect.gen(function* () {
      const project = path.join((yield* tmpdirScoped()).path, "project")
      const settings = path.join(project, CompatNames.vendor.directory, CompatNames.vendor.settings.shared)
      const mcp = path.join(project, CompatNames.mcp)
      const reference = path.join(project, "secret.txt")
      yield* Effect.promise(async () => {
        await link(project, path.relative(project, settings))
        await link(project, path.relative(project, mcp))
        await link(project, path.relative(project, reference))
      })
      const recorded = recordedFileSystem()
      const root = {
        path: path.join(project, CompatNames.vendor.directory),
        kind: "vendor",
        scope: "project",
      } as unknown as CompatRoots.Root
      yield* Effect.gen(function* () {
        yield* CompatSettings.read([root])
        yield* CompatMcpJson.read({ file: mcp as never, env: {} })
        const text = yield* ConfigVariable.substitute({
          type: "path",
          path: path.join(project, "orbit.json"),
          text: "{file:secret.txt}",
          within: [project],
        })
        expect(text).toBe("{file:secret.txt}")
      }).pipe(Effect.provide(recorded.layer))
      for (const file of [settings, mcp, reference]) expect(touched(recorded.calls, file)).toEqual([])
    }),
  )

  it.live("a marker file of a project that links to a share is not looked at", () =>
    Effect.gen(function* () {
      const project = path.join((yield* tmpdirScoped()).path, "project")
      yield* Effect.promise(() => link(project, "AGENTS.md"))
      const recorded = recordedFileSystem()
      const files = yield* FSUtil.Service.pipe(Effect.provide(recorded.layer))
      expect(yield* files.up({ targets: ["AGENTS.md"], start: project, stop: project, type: "file" })).toEqual([])
      expect(touched(recorded.calls, path.join(project, "AGENTS.md"))).toEqual([])
    }),
  )
})

// The positive control: the same layouts with links that stay on the disk still load, in the same code path, so the
// rows above are not passing because the loaders found nothing at all.
describe.skipIf(!canLinkFile)("a link inside the project is still listed", () => {
  it.live("commands, agents and skills behind links to local folders load, and a loop of links ends", () =>
    Effect.gen(function* () {
      const project = path.join((yield* tmpdirScoped()).path, "project")
      yield* Effect.promise(async () => {
        await write(path.join(project, "store/commands/a.md"), command)
        await write(path.join(project, "store/agents/b.md"), agent)
        await write(path.join(project, "store/skills/s/SKILL.md"), "---\nname: s\ndescription: x\n---\nbody\n")
        await fs.mkdir(path.join(project, ".orbit"), { recursive: true })
        await fs.symlink(path.join(project, "store/commands"), path.join(project, ".orbit/commands"), "dir")
        await fs.symlink(path.join(project, "store/agents"), path.join(project, ".orbit/agents"), "dir")
        await fs.symlink(path.join(project, "store/skills"), path.join(project, ".orbit/skills"), "dir")
        await fs.symlink(project, path.join(project, "store/skills/again"), "dir")
      })
      const files = yield* FSUtil.Service.pipe(Effect.provide(recordedFileSystem().layer))
      expect((yield* CommandFile.load(files, path.join(project, ".orbit"))).map((item) => item.name)).toEqual(["a"])
      expect((yield* AgentFile.load(files, path.join(project, ".orbit"))).length).toBe(1)
      const skills = yield* LinkShare.scan(files, path.join(project, ".orbit/skills"), ["{*.md,**/SKILL.md}"])
      expect(skills.some((file) => path.basename(path.dirname(file)) === "s")).toBe(true)
    }),
  )
})
