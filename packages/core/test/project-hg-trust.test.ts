import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { plant, withCurrentDirectoryOnPath } from "./fixture/decoy"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Class 1 (M3 verification round 6): `Project.resolve` runs `hg log` in a folder that holds `.hg` to name the project, and
// Mercurial loads the `[extensions]` (Python) and `[hooks]` of that folder's own `.hg/hgrc` into the command. It runs when
// a client opens the folder, before anyone is asked, so no `hg` may start in a folder that is not trusted. The oracle is a
// program named `hg` that the test puts first on PATH and that records each run, so the rows pass or fail without
// Mercurial installed. The trusted rows are the control: the same folder, with the same program, does start it.

const graph = (implicit: boolean) =>
  AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node]), [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
    Global.node.replace(tempGlobalLayer),
  ])
const untrusted = testEffect(graph(false))
const trusted = testEffect(graph(true))

/** A folder of `.hg` and an `hg` on PATH that records its runs; the reader returns them. */
const fakeHg = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const project = path.join(root, "project")
  const bin = path.join(root, "bin")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(project, ".hg"), { recursive: true })
    await fs.mkdir(path.join(project, "app"), { recursive: true })
    // The folder's own configuration, which a real `hg` would load: a hook and an extension that name a marker file.
    await Bun.write(
      path.join(project, ".hg", "hgrc"),
      `[hooks]\nprecommand = echo ran > ${JSON.stringify(path.join(root, "hook.txt"))}\n[extensions]\nmarker = ${path.join(project, "marker.py")}\n`,
    )
    await fs.mkdir(bin)
  })
  const ran = yield* Effect.promise(async () => {
    if (process.platform === "win32") return plant(bin, "hg")
    const log = path.join(bin, "ran.txt")
    await Bun.write(path.join(bin, "hg"), `#!/bin/sh\necho "hg $@" >> ${JSON.stringify(log)}\nexit 1\n`)
    await fs.chmod(path.join(bin, "hg"), 0o755)
    return async () => ((await Bun.file(log).exists()) ? (await Bun.file(log).text()).split("\n").filter(Boolean) : [])
  })
  const name = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"
  const before = process.env[name]
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.env[name] = bin + path.delimiter + (before ?? "")
    }),
    () =>
      Effect.sync(() => {
        if (before === undefined) delete process.env[name]
        else process.env[name] = before
      }),
  )
  return { project, ran: () => Effect.promise(ran) }
})

describe("Project.resolve and a folder with .hg that is not trusted", () => {
  for (const start of ["", "app"])
    untrusted.live(
      `starts no hg (${start === "" ? "the folder itself" : "a folder below it"})`,
      () =>
        Effect.gen(function* () {
          const found = yield* fakeHg
          const project = yield* Project.Service
          const result = yield* withCurrentDirectoryOnPath(project.resolve(AbsolutePath.make(path.join(found.project, start))))
          expect(yield* found.ran()).toEqual([])
          expect(result.vcs?.type).toBe("hg")
          // Identified without a first changeset, as it is when `hg` is not installed.
          expect(result.id).toBe(Project.ID.make("global"))
        }),
      60_000,
    )

  for (const start of ["", "app"])
    trusted.live(
      `a trusted one still starts hg (control, ${start === "" ? "the folder itself" : "a folder below it"})`,
      () =>
        Effect.gen(function* () {
          const found = yield* fakeHg
          const project = yield* Project.Service
          yield* withCurrentDirectoryOnPath(project.resolve(AbsolutePath.make(path.join(found.project, start))))
          expect((yield* found.ran()).some((line) => line.includes("log"))).toBe(true)
        }),
      60_000,
    )
})
