import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { VcsHgPlugin } from "@orbit/core/plugin/vcs/hg"
import { AbsolutePath } from "@orbit/core/schema"
import { Vcs } from "@orbit/core/vcs"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { AppProcess } from "@orbit/util/process"
import { plant, withCurrentDirectoryOnPath } from "./fixture/decoy"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

// Class 1 (M3 verification round 6): the Mercurial provider runs `hg branch`, `hg status` and `hg diff` in the folder, and
// Mercurial loads the `[extensions]` and `[hooks]` of the folder's own `.hg/hgrc` into each. The terminal UI asks for the
// branch of the folder it opens before anyone is asked, so the provider starts no `hg` until the folder is trusted. The
// oracle is a program named `hg` first on PATH that records each run; the trusted row is the control.

const graph = (folder: string, implicit: boolean) =>
  AppNodeBuilder.build(LayerNode.group([Vcs.node, Bus.node, Location.node, ProjectTrust.node, AppProcess.node, FSUtil.node]), [
    ...untrustedProjectNodes,
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(
            { directory: AbsolutePath.make(folder) },
            { vcs: { type: "hg", store: AbsolutePath.make(path.join(folder, ".hg")) } },
          ),
        ),
      ),
    ),
  ])

const run = (implicit: boolean) =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped()).path
    const project = path.join(root, "project")
    const bin = path.join(root, "bin")
    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(project, ".hg"), { recursive: true })
      await fs.mkdir(bin)
    })
    const ran = yield* Effect.promise(async () => {
      if (process.platform === "win32") return plant(bin, "hg")
      const log = path.join(bin, "ran.txt")
      await Bun.write(path.join(bin, "hg"), `#!/bin/sh
echo "hg $@" >> ${JSON.stringify(log)}
exit 1
`)
      await fs.chmod(path.join(bin, "hg"), 0o755)
      return async () => ((await Bun.file(log).exists()) ? (await Bun.file(log).text()).split("
").filter(Boolean) : [])
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
    const context = host()
    const answers = yield* Effect.gen(function* () {
      const vcs = yield* Vcs.Service
      yield* VcsHgPlugin.Plugin.effect({
        ...context,
        vcs: { ...context.vcs, transform: vcs.transform, reload: vcs.reload },
      })
      // What the server's `vcs.get`, `vcs.status` and `vcs.diff` handlers ask.
      return { info: yield* vcs.info(), status: yield* vcs.status(), diff: yield* vcs.diff("working") }
    }).pipe(Effect.provide(graph(project, implicit)))
    return { answers, ran: yield* Effect.promise(ran) }
  })

const it = testEffect(Layer.empty)

describe("the Mercurial provider and a folder with .hg", () => {
  it.live(
    "starts no hg while the folder is not trusted",
    () =>
      Effect.gen(function* () {
        const found = yield* withCurrentDirectoryOnPath(run(false))
        expect(found.ran).toEqual([])
        expect(found.answers).toEqual({ info: { provider: "hg", branch: {} }, status: [], diff: [] })
      }),
    60_000,
  )

  it.live(
    "starts hg once the folder is trusted (control)",
    () =>
      Effect.gen(function* () {
        const found = yield* withCurrentDirectoryOnPath(run(true))
        const commands = found.ran.map((line) => line.split(" ")[1])
        expect(commands).toContain("branch")
        expect(commands).toContain("status")
        expect(commands).toContain("diff")
      }),
    60_000,
  )
})
