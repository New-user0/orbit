import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Fingerprint } from "@orbit/core/config/fingerprint"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Class 1: the TUI imports the tui entry of a plugin folder that has no server entry, so editing it must move the
// plugins digest even though the plugin scan never activates that folder.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

const write = (file: string, contents: string) =>
  fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, contents))

const layout = Effect.gen(function* () {
  const project = (yield* tmpdirScoped()).path
  const folder = path.join(project, ".orbit")
  const plugin = path.join(folder, "plugins", "p")
  yield* Effect.promise(async () => {
    await write(path.join(plugin, "tui.ts"), "export default 1\n")
    await write(path.join(plugin, "package.json"), JSON.stringify({ name: "p", version: "1" }))
  })
  return { project, folder, plugin }
})

describe("Fingerprint digests a plugin folder that only has a tui entry", () => {
  it.live("editing tui.ts moves the plugins digest", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const place = yield* layout
      const read = () => Fingerprint.pluginsOf(files, place.folder, [place.project])
      const before = yield* read()
      expect(yield* read()).toBe(before)
      yield* Effect.promise(() => write(path.join(place.plugin, "tui.ts"), "export default 666\n"))
      expect(yield* read()).not.toBe(before)
    }),
  )

  it.live("editing package.json moves the plugins digest", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const place = yield* layout
      const read = () => Fingerprint.pluginsOf(files, place.folder, [place.project])
      const before = yield* read()
      yield* Effect.promise(() =>
        write(path.join(place.plugin, "package.json"), JSON.stringify({ name: "p", version: "2" })),
      )
      expect(yield* read()).not.toBe(before)
    }),
  )

  it.live("a tui.ts that links out of the folder is named, never read", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const place = yield* layout
      const outside = path.join(place.project, "..", `outside-${path.basename(place.project)}.ts`)
      yield* Effect.promise(() => write(outside, "export default 1\n"))
      yield* Effect.promise(() => fs.rm(path.join(place.plugin, "tui.ts")))
      const linked = yield* Effect.promise(() =>
        fs.symlink(outside, path.join(place.plugin, "tui.ts"), "file").then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "EPERM" || error.code === "UNKNOWN") return false
            throw error
          },
        ),
      )
      if (!linked) return
      const read = () => Fingerprint.pluginsOf(files, place.folder, [place.project])
      const before = yield* read()
      yield* Effect.promise(() => write(outside, "export default 666\n"))
      expect(yield* read()).toBe(before)
    }),
  )
})
