import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Document, type Entry } from "@orbit/schema/config"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// trust-first part 2, D8 (owner, 2026-10-21: "match refrence"): as the reference does, a folder that is trusted loads its
// config as it is now. Nothing is recorded at the grant, nothing that changed since is held back, and the person is never
// asked to trust the changes. Every row runs the real loader on a store that trusts no folder on its own; the hook
// commands are only text here, nothing runs them.
const hook = (command: string) => ({ matcher: "shell", hooks: [{ type: "command", command }] })

const write = (file: string, contents: unknown) =>
  fs
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents)))

const folders = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const root = yield* Effect.promise(() => fs.realpath(tmp))
  return {
    home: path.join(root, "home"),
    globalConfig: path.join(root, "home", ".config", "orbit"),
    parent: path.join(root, "work"),
    repo: path.join(root, "work", "repo"),
  }
})

function loader(input: { readonly home: string; readonly globalConfig: string; readonly repo: string }) {
  return AppNodeBuilder.build(
    LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node, ConfigPluginSource.node]),
    [
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(input.repo) }))),
      ),
      Global.node.replace(Global.layerWith({ config: input.globalConfig, home: input.home })),
      Credential.node.replace(emptyCredentialNode),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
    ],
  )
}

const named = (entries: readonly Entry[], file: string) =>
  entries.find((entry): entry is Document => entry.type === "document" && entry.path === AbsolutePath.make(file))

const reread = Effect.gen(function* () {
  const config = yield* Config.Service
  const reload = config.reload
  expect(reload).toBeDefined()
  if (reload !== undefined) yield* reload()
})

describe("config of a trusted folder that changes after the grant", () => {
  it.live("applies as it is now, with nothing held back and nothing to trust again", () =>
    Effect.gen(function* () {
      const layout = yield* folders
      const settings = path.join(layout.repo, "orbit.json")
      yield* Effect.promise(() => write(settings, { hooks: { PreToolUse: [hook("echo one")] } }))
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const project = yield* ProjectTrust.Service
        yield* project.grant({ persist: true, via: "test" })
        yield* reread
        expect(named(yield* config.entries(), settings)?.info.hooks?.PreToolUse).toHaveLength(1)

        // A pull or a branch switch adds a hook after the grant.
        yield* Effect.promise(() =>
          write(settings, { hooks: { PreToolUse: [hook("echo one"), hook("echo CLONE-HOOK-AFTER-GRANT")] } }),
        )
        yield* reread
        const entry = named(yield* config.entries(), settings)
        expect(JSON.stringify(entry?.info.hooks ?? null)).toContain("CLONE-HOOK-AFTER-GRANT")
        expect(entry?.withheld).toBeUndefined()
        expect(entry?.trusted).toBeUndefined()
        const status = yield* project.status()
        expect(status).toMatchObject({ trusted: true, withheld: [] })
        // There is no list of changes to answer: the reference never asks again about a folder it trusts.
        expect(Object.keys(status)).not.toContain("changed")
      }).pipe(Effect.provide(loader(layout)))
    }),
    30_000,
  )

  // FU-M4-379: a project that a grant for a folder above covers had its own hooks read as changed since that grant.
  it.live("applies the own hooks of a project that a grant for a folder above covers, with no grant of its own", () =>
    Effect.gen(function* () {
      const layout = yield* folders
      const settings = path.join(layout.repo, "orbit.json")
      yield* Effect.promise(() => write(settings, { hooks: { SessionStart: [hook("echo CLONE-CHILD-HOOK")] } }))
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const project = yield* ProjectTrust.Service
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(layout.parent, { persist: true, via: "test" })
        yield* reread
        expect(JSON.stringify(named(yield* config.entries(), settings)?.info.hooks ?? null)).toContain("CLONE-CHILD-HOOK")
        expect(named(yield* config.entries(), settings)?.withheld).toBeUndefined()
        expect(yield* project.status()).toMatchObject({ trusted: true, granted: layout.parent, withheld: [] })
      }).pipe(Effect.provide(loader(layout)))
    }),
    30_000,
  )

  it.live("offers a plugin added to a trusted folder after the grant, as the reference loads what is there", () =>
    Effect.gen(function* () {
      const layout = yield* folders
      const plugins = path.join(layout.repo, ".orbit", "plugins")
      yield* Effect.promise(() => write(path.join(plugins, "one.ts"), "export default 1\n"))
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const source = yield* ConfigPluginSource.Service
        const targets = source
          .operations()
          .pipe(Effect.map((operations) => operations.flatMap((item) => (item.type === "add" ? [item.target] : []))))
        yield* project.grant({ persist: true, via: "test" })
        yield* reread
        expect(yield* targets).toEqual([path.join(plugins, "one.ts")])

        yield* Effect.promise(() => write(path.join(plugins, "two.ts"), "export default 2\n"))
        // Before the config has read the folder again, and after it has, both plugins are offered.
        expect((yield* targets).toSorted()).toEqual([path.join(plugins, "one.ts"), path.join(plugins, "two.ts")])
        yield* reread
        expect((yield* targets).toSorted()).toEqual([path.join(plugins, "one.ts"), path.join(plugins, "two.ts")])
      }).pipe(Effect.provide(loader(layout)))
    }),
    30_000,
  )
})
