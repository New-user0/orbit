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

// Class 1: a folder named node_modules in a plugins folder is a dependency tree, not a plugin. Reading it would hash
// every dependency file on every status read, so the digest must not touch it, and an edit inside it moves nothing.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

describe("Fingerprint.pluginsOf and node_modules", () => {
  it.live("nothing under plugins/node_modules is read, and the plugin beside it is digested", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const project = path.join((yield* tmpdirScoped()).path, "project")
      const folder = path.join(project, ".orbit")
      const plugins = path.join(folder, "plugins")
      const modules = path.join(plugins, "node_modules")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(modules, "dep"), { recursive: true })
        await fs.writeFile(path.join(plugins, "a.ts"), "export default 1\n")
        await fs.writeFile(path.join(modules, "dep", "index.js"), "1\n")
      })
      const seen: string[] = []
      const note = <A extends (target: string, ...rest: never[]) => unknown>(fn: A) =>
        ((target: string, ...rest: never[]) => {
          seen.push(target)
          return fn(target, ...rest)
        }) as A
      const view: FSUtil.Interface = {
        ...files,
        exists: note(files.exists),
        isDir: note(files.isDir),
        isFile: note(files.isFile),
        readFile: note(files.readFile),
        readFileString: note(files.readFileString),
        readDirectoryEntries: note(files.readDirectoryEntries),
        resolve: note(files.resolve),
      }
      const first = yield* Fingerprint.pluginsOf(view, folder, [project])
      yield* Effect.promise(() => fs.writeFile(path.join(modules, "dep", "index.js"), "2\n"))
      expect(yield* Fingerprint.pluginsOf(view, folder, [project])).toBe(first)
      expect(
        seen.filter((item) => path.resolve(item) === modules || path.resolve(item).startsWith(modules + path.sep)),
      ).toEqual([])

      // Control: the single-file plugin beside it is digested by content.
      yield* Effect.promise(() => fs.writeFile(path.join(plugins, "a.ts"), "export default 2\n"))
      expect(yield* Fingerprint.pluginsOf(view, folder, [project])).not.toBe(first)
    }),
  )
})
