import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { CommandFile } from "@orbit/core/config/plugin/command-file"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { canLinkFile } from "./fixture/symlink"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// M3 verification round 6 (shares): the share checks ran on every load and turned gates red under load, because the scan
// listed every folder of the config folder (the packages of a plugin included) once per pattern, and a chain of links was
// walked again from its root at every hop. These rows pin the work done, which does not depend on the load of the machine,
// and one row runs the real loaders in a child process with a deadline, so that a walk which does not end fails by itself.

setDefaultTimeout(60_000)
const win = process.platform === "win32"

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const command = "---\ndescription: x\n---\nrun it\n"

/** A project whose `.orbit` holds a command, a plugin with a large `node_modules`, and a chain of links to a skills folder. */
const build = async (project: string, packages: number, links: number) => {
  await write(path.join(project, ".orbit/commands/a.md"), command)
  await write(path.join(project, ".orbit/skills/real/s/SKILL.md"), "---\nname: s\ndescription: x\n---\nbody\n")
  for (let index = 0; index < packages; index++)
    for (const name of ["a.md", "b.md", "c.md", "SKILL.md", "index.js"])
      await write(path.join(project, `.orbit/plugins/p/node_modules/m${index}`, name), command)
  // `l0 -> l1 -> ... -> real`, created from the end so that every link has its target.
  const folder = path.join(project, ".orbit/skills")
  for (let index = links - 1; index >= 0; index--)
    await fs.symlink(index === links - 1 ? path.join(folder, "real") : `l${index + 1}`, path.join(folder, `l${index}`), "dir")
}

describe("the share checks do bounded work", () => {
  it.live("the command listing does not enter a folder that its pattern cannot match, or node_modules", () =>
    Effect.gen(function* () {
      const project = path.join((yield* tmpdirScoped()).path, "project")
      yield* Effect.promise(() => build(project, 50, 0))
      const recorded = recordedFileSystem()
      const files = yield* FSUtil.Service.pipe(Effect.provide(recorded.layer))
      expect((yield* CommandFile.load(files, path.join(project, ".orbit"))).map((item) => item.name)).toEqual(["a"])
      const listed = recorded.calls.filter((call) => call.startsWith("readDirectoryEntries ")).map((call) => call.slice(21))
      expect(listed.filter((folder) => folder.includes("plugins") || folder.includes("node_modules"))).toEqual([])
    }),
  )

  it.live("a listing for skills skips node_modules and still finds a skill beside it (control)", () =>
    Effect.gen(function* () {
      const project = path.join((yield* tmpdirScoped()).path, "project")
      yield* Effect.promise(async () => {
        await write(path.join(project, "skills/s/SKILL.md"), "x")
        await write(path.join(project, "skills/s/node_modules/m/SKILL.md"), "x")
        await write(path.join(project, "skills/node_modules/n/SKILL.md"), "x")
      })
      const recorded = recordedFileSystem()
      const files = yield* FSUtil.Service.pipe(Effect.provide(recorded.layer))
      const found = yield* LinkShare.scan(files, path.join(project, "skills"), ["{*.md,**/SKILL.md}"])
      expect(found.map((file) => path.relative(project, file).replaceAll("\\", "/"))).toEqual(["skills/s/SKILL.md"])
    }),
  )

  // The recorded reads are the work: before the change a chain of 63 links was read 63 times from its root at every hop.
  // Only Windows has links to shares, and the walk answers at once elsewhere; it needs the right to make a link.
  it.live("a chain of 63 links is read once per part, not once per hop and part", () =>
    Effect.gen(function* () {
      if (!win || !canLinkFile) return
      const project = path.join((yield* tmpdirScoped()).path, "project")
      yield* Effect.promise(() => build(project, 0, 63))
      const reads: string[] = []
      const files = yield* FSUtil.Service.pipe(Effect.provide(recordedFileSystem().layer))
      const reader = { readLink: (file: string) => (reads.push(file), files.readLink(file)) }
      expect(yield* LinkShare.of(reader, path.join(project, ".orbit/skills/l0/s/SKILL.md"))).toBeUndefined()
      expect(new Set(reads).size).toBe(reads.length)
      // The parts of the path, the 63 links and what is below the last one: linear, where it was quadratic.
      expect(reads.length).toBeLessThan(path.join(project, ".orbit/skills/l0/s/SKILL.md").split(path.sep).length + 63 * 3)
    }),
  )

})

describe.skipIf(!canLinkFile)("the real loaders on a large config folder", () => {
  it.live("finish within a deadline in a child process", () =>
    Effect.gen(function* () {
      const project = path.join((yield* tmpdirScoped()).path, "project")
      yield* Effect.promise(() => build(project, 400, win ? 63 : 20))
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/link-share-bound.ts"), project], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 50_000,
        killSignal: "SIGKILL",
      })
      const [code, out, err] = yield* Effect.promise(() =>
        Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
      )
      expect(err).toBe("")
      expect(code).toBe(0)
      const result = JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, { ms: number; value: number }>
      expect(result.commands!.value).toBe(1)
      expect(result.skills!.value).toBeGreaterThan(0)
      // Before the change these took seconds with a chain, and minutes under load; a generous bound still tells them apart.
      for (const name of ["commands", "agents", "skills", "up"]) expect(result[name]!.ms).toBeLessThan(10_000)
    }),
  )
})
