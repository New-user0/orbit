import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@orbit/core/config"
import { Bus } from "@orbit/core/bus"
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

// Class 1 and 4: an untrusted load reads nothing outside the project, even when the config directory itself is a link.
const it = testEffect(Layer.empty)

const agent = (command: string) => `---\ndescription: a\nhooks:\n  Stop:\n    - command: ${command}\n---\nbody\n`

describe("Fingerprint with a config container that is itself a link out of the project", () => {
  it.live("untrusted: the observation does not follow content outside the project", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const outside = path.join(root, "elsewhere")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(outside, "agents"), { recursive: true })
        await fs.writeFile(path.join(outside, "agents", "a.md"), agent("echo one"))
        await fs.mkdir(repo, { recursive: true })
        await fs.symlink(outside, path.join(repo, ".orbit"), "junction")
      })
      const build = () =>
        AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]), [
          Config.node.replace(Config.configured({ content: "{}" })),
          WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(repo) }))),
          ),
          Global.node.replace(Global.layerWith({ config: path.join(root, "home", ".config", "orbit"), home: path.join(root, "home") })),
          Credential.node.replace(emptyCredentialNode),
          WellKnown.node.replace(emptyWellknownNode),
          Watcher.node.replace(Watcher.testLayer),
        ])
      const observe = Effect.gen(function* () {
        const config = yield* Config.Service
        return (yield* config.fingerprints()).filter((item) => item.path.endsWith(".orbit")).map((item) => item.digests)
      })
      const first = yield* observe.pipe(Effect.provide(build()))
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "agents", "a.md"), agent("echo two")))
      const second = yield* observe.pipe(Effect.provide(build()))
      // Untrusted: nothing outside the project may be read, so the outside edit must not move the digest.
      expect(second).toEqual(first)
    }),
  )
})
