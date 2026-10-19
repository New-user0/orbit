import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// docs/upgrading.md, "A file outside the project is trusted by the folder that owns it": the shapes of owner that
// ProjectTrust.trustedAt refuses outside the test layout (FU-M3-115). Each row is the answer for one file.
describe("trustedAt: owners that the note on a file outside the project names", () => {
  const layout = (dotfiles: boolean) =>
    Effect.gen(function* () {
      const project = path.join((yield* tmpdirScoped()).path, "project")
      const home = (yield* tmpdirScoped()).path
      const trusted = path.join((yield* tmpdirScoped()).path, "trusted")
      const plain = path.join((yield* tmpdirScoped()).path, "plain")
      yield* Effect.promise(async () => {
        await Promise.all(
          [path.join(project, ".git"), path.join(trusted, ".git"), path.join(home, "inner"), plain].map((folder) =>
            fs.mkdir(folder, { recursive: true }),
          ),
        )
        if (dotfiles) await fs.mkdir(path.join(home, ".git"))
        await fs.symlink(trusted, path.join(home, "to-trusted"), "junction")
        await fs.symlink(trusted, path.join(plain, "to-trusted"), "junction")
      })
      const context = yield* Layer.build(
        AppNodeBuilder.build(LayerNode.group([ProjectTrust.node, WorkspaceTrust.node]), [
          Config.node.replace(Config.testLayer([])),
          Global.node.replace(Global.layerWith({ home })),
          WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
              ),
            ),
          ),
        ]),
      )
      const trust = Context.get(context, WorkspaceTrust.Service)
      yield* trust.grant(project, { persist: false, via: "test" })
      yield* trust.grant(trusted, { persist: false, via: "test" })
      yield* trust.grant(path.join(home, "inner"), { persist: false, via: "test" })
      yield* trust.grant(plain, { persist: false, via: "test" })
      const ask = (file: string) =>
        Effect.gen(function* () {
          return yield* (yield* ProjectTrust.Service).trustedAt(file)
        }).pipe(Effect.provide(Layer.succeedContext(context)))
      return { home, trusted, plain, trust, ask }
    })

  it.live("a home folder that is a repository owns what is granted below it, and stays refused until trusted", () =>
    Effect.gen(function* () {
      const rows = yield* Effect.forEach([true, false], (dotfiles) =>
        Effect.gen(function* () {
          const { home, trust, ask } = yield* layout(dotfiles)
          const probe = [
            path.join(home, "a.fake"),
            path.join(home, "inner", "a.fake"),
            path.join(home, "to-trusted", "a.fake"),
          ]
          const before = yield* Effect.forEach(probe, ask)
          // Trusting home for the session lifts every one of them, a dotfiles repository or not.
          yield* trust.grant(home, { persist: false, via: "test" })
          const after = yield* Effect.forEach(probe, ask)
          return { dotfiles, before, after }
        }),
      )
      expect(rows).toEqual([
        // home, a folder granted inside it (home owns it through .git), a trusted repository reached through a link in home
        { dotfiles: true, before: [false, false, false], after: [true, true, true] },
        // without .git the granted folder owns itself; the link in the untrusted home is still refused
        { dotfiles: false, before: [false, true, false], after: [true, true, true] },
      ])
    }),
  )

  it.live("a granted folder with no marker holds its files, and refuses a link that leads to a trusted repository", () =>
    Effect.gen(function* () {
      const { trusted, plain, ask } = yield* layout(false)
      const found = yield* Effect.forEach(
        [path.join(plain, "a.fake"), path.join(plain, "to-trusted", "a.fake"), path.join(trusted, "a.fake")],
        ask,
      )
      expect(found).toEqual([true, false, true])
    }),
  )
})
