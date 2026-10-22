import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { KV } from "@orbit/core/kv"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

// trust-first: as the reference does, a folder counts as trusted when it or any folder above it holds a grant, so one
// answer for a repository covers its subfolders and one for a parent covers every project below it. The home directory
// and filesystem roots are never trusted for good, and a grant for one of them for this process covers that folder alone:
// it must not trust every clone below it (class 3). The walk goes up the folder's real path, so a link decides nothing by
// where it sits (class 4).
function build(input: { readonly database: string; readonly home: string; readonly implicit?: boolean }) {
  return AppNodeBuilder.build(LayerNode.group([WorkspaceTrust.node, Bus.node, KV.node]), [
    Database.node.replace(Database.configured({ path: input.database })),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: input.implicit ?? false })),
    Global.node.replace(Global.layerWith({ home: input.home })),
  ])
}

const fixture = Effect.gen(function* () {
  const base = (yield* tmpdirScoped()).path
  const real = yield* Effect.promise(() => fs.realpath(base))
  const folder = (...names: string[]) => AbsolutePath.make(path.join(real, ...names))
  const folders = {
    root: AbsolutePath.make(real),
    home: folder("home"),
    homeChild: folder("home", "clone"),
    parent: folder("work"),
    child: folder("work", "team", "repo"),
    sibling: folder("elsewhere"),
    linkHost: folder("links"),
  }
  yield* Effect.promise(() =>
    Promise.all(
      [folders.homeChild, folders.child, folders.sibling, folders.linkHost].map((directory) =>
        fs.mkdir(directory, { recursive: true }),
      ),
    ),
  )
  return { ...folders, database: path.join(real, "trust.db") }
})

describe("WorkspaceTrust coverage", () => {
  it.live("a stored grant for a folder covers every folder below it, and names the folder that granted it", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.status(folders.child)).toMatchObject({ trusted: false, persistent: true })

        yield* trust.grant(folders.parent, { persist: true, via: "test" })

        expect(yield* trust.status(folders.child)).toMatchObject({
          directory: folders.child,
          trusted: true,
          source: "saved",
          granted: folders.parent,
        })
        // A folder beside it is not below it.
        expect(yield* trust.status(folders.sibling)).toMatchObject({ trusted: false })
        // The grant is the parent's alone: nothing is stored for the child.
        expect((yield* trust.list()).map((grant) => grant.directory)).toEqual([folders.parent])
      }).pipe(Effect.provide(build(folders)))

      // A later process reads the same answer from the store.
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.status(folders.child)).toMatchObject({ trusted: true, source: "saved" })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  // The executable config a grant approved is recorded for the folder that was granted, so a folder below it that the
  // grant covers is compared with those records (F18), not with records of its own that no grant made.
  it.live("a folder that a parent's grant covers is compared with the records that grant made", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const source = path.join(folders.child, ".orbit")
      yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const observation = { path: source, identity: source, digests: { hooks: "approved" } }
        yield* trust.grant(folders.parent, { persist: true, via: "test", observations: [observation] })
        expect(yield* trust.compare(folders.child, [observation])).toEqual([])
        // The control: a digest the grant did not approve is a change.
        expect(yield* trust.compare(folders.child, [{ ...observation, digests: { hooks: "edited" } }])).toEqual([
          { path: source, kinds: ["hooks"] },
        ])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("a grant for this process covers the folders below it as well", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.parent, { persist: false, via: "test" })
        expect(yield* trust.status(folders.child)).toMatchObject({ trusted: true, source: "session" })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("a grant for the home directory or a filesystem root covers that folder alone", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const systemRoot = AbsolutePath.make(path.parse(folders.root).root)
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.home, { persist: false, via: "test" })
        yield* trust.grant(systemRoot, { persist: false, via: "test" })
        // The control: each is trusted itself, for this process.
        expect(yield* trust.status(folders.home)).toMatchObject({ trusted: true, source: "session" })
        expect(yield* trust.status(systemRoot)).toMatchObject({ trusted: true, source: "session" })
        // Nothing below them is.
        expect(yield* trust.status(folders.homeChild)).toMatchObject({ trusted: false })
        expect(yield* trust.status(folders.child)).toMatchObject({ trusted: false })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("revoking a folder that a parent's grant covers leaves it trusted, and names the parent to revoke", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.parent, { persist: true, via: "test" })
        expect(yield* trust.revoke(folders.child)).toMatchObject({
          trusted: true,
          source: "saved",
          granted: folders.parent,
        })
        // Revoking the parent ends it for both.
        yield* trust.revoke(folders.parent)
        expect(yield* trust.status(folders.child)).toMatchObject({ trusted: false })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live(
    "a folder reached through a link is covered by the folders it really lies in, not the one the link sits in",
    () =>
      Effect.gen(function* () {
        const folders = yield* fixture
        const link = path.join(folders.linkHost, "repo")
        yield* Effect.promise(() =>
          fs.symlink(folders.child, link, process.platform === "win32" ? "junction" : undefined),
        )
        yield* Effect.gen(function* () {
          const trust = yield* WorkspaceTrust.Service
          // A grant for the folder that holds the link is not a grant for where the link leads.
          yield* trust.grant(folders.linkHost, { persist: true, via: "test" })
          expect(yield* trust.status(link)).toMatchObject({ directory: folders.child, trusted: false })
          // A grant for a folder the link really leads into is.
          yield* trust.grant(folders.parent, { persist: true, via: "test" })
          expect(yield* trust.status(link)).toMatchObject({ directory: folders.child, trusted: true, source: "saved" })
        }).pipe(Effect.provide(build(folders)))
      }),
  )

  // A path that is not there keeps its spelling when it is resolved, so the walk has to start from where its existing part
  // really is: a missing folder below a link into a clone is the clone's, and a link that leads nowhere is covered by no
  // folder above it (class 4).
  it.live("a missing folder below a link is decided where the link leads, and a link that leads nowhere is covered by nothing", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const link = path.join(folders.linkHost, "clone")
      const gone = path.join(folders.root, "gone")
      const dangling = path.join(folders.linkHost, "dangling")
      const type = process.platform === "win32" ? "junction" : undefined
      yield* Effect.promise(async () => {
        await fs.symlink(folders.sibling, link, type)
        await fs.mkdir(gone)
        await fs.symlink(gone, dangling, type)
        await fs.rm(gone, { recursive: true })
      })
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.linkHost, { persist: true, via: "test" })
        // The control: a missing folder that really lies below the granted folder is covered by it.
        expect(yield* trust.status(path.join(folders.linkHost, "missing", "deeper"))).toMatchObject({
          trusted: true,
          granted: folders.linkHost,
        })
        expect(yield* trust.status(path.join(link, "missing"))).toMatchObject({ trusted: false })
        expect(yield* trust.status(dangling)).toMatchObject({ trusted: false })
        expect(yield* trust.status(path.join(dangling, "missing"))).toMatchObject({ trusted: false })
        // A grant for where the link leads covers the missing folder below it.
        yield* trust.grant(folders.sibling, { persist: true, via: "test" })
        expect(yield* trust.status(path.join(link, "missing"))).toMatchObject({
          trusted: true,
          granted: folders.sibling,
        })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  const windows = process.platform === "win32" ? it.live : it.live.skip
  windows("on Windows a parent's grant covers a child spelled in another case", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.parent.toUpperCase(), { persist: true, via: "test" })
        expect(yield* trust.status(folders.child.toLowerCase())).toMatchObject({ trusted: true, source: "saved" })
      }).pipe(Effect.provide(build(folders)))
    }),
  )
})
