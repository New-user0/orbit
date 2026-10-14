import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Trust } from "@orbit/schema/trust"
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

// The trust service over a file database, so that a second build over the same file is a new process.
function build(input: { readonly database: string; readonly home: string; readonly implicit?: boolean }) {
  return AppNodeBuilder.build(LayerNode.group([WorkspaceTrust.node, Bus.node, KV.node]), [
    Database.node.replace(Database.configured({ path: input.database })),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: input.implicit ?? false })),
    Global.node.replace(Global.layerWith({ home: input.home })),
  ])
}

const fixture = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const folders = {
    root,
    home: AbsolutePath.make(path.join(root, "home")),
    repo: AbsolutePath.make(path.join(root, "repo")),
    other: AbsolutePath.make(path.join(root, "other")),
  }
  yield* Effect.promise(() =>
    Promise.all([folders.home, folders.repo, folders.other].map((directory) => fs.mkdir(directory))),
  )
  // Two sources the grants below record, as files that exist.
  const first = path.join(folders.repo, "orbit.json")
  const second = path.join(folders.repo, "orbit.local.json")
  yield* Effect.promise(() => Promise.all([fs.writeFile(first, "{}"), fs.writeFile(second, "{}")]))
  return { ...folders, database: path.join(root, "trust.db"), first, second }
})

const observation = (file: string, digests: Partial<Record<Trust.Kind, string>>): WorkspaceTrust.Observation => ({
  path: file,
  identity: file,
  digests,
})

describe("WorkspaceTrust records", () => {
  it.live("persists the records of a grant across two builds over one file database", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const seen = [observation(folders.first, { hooks: "h1", shell: "s1" }), observation(folders.second, { mcp: "m1" })]
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.repo, { persist: true, via: "test", observations: seen })
        expect(yield* trust.compare(folders.repo, seen)).toEqual([])
      }).pipe(Effect.provide(build(folders)))

      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.compare(folders.repo, seen)).toEqual([])
        expect(
          yield* trust.compare(folders.repo, [observation(folders.first, { hooks: "h2", shell: "s1" }), seen[1]]),
        ).toEqual([{ path: folders.first, kinds: ["hooks"] }])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  // Table: a record and an observation, and what differs.
  const rows: ReadonlyArray<{
    readonly name: string
    readonly recorded: Partial<Record<Trust.Kind, string>> | undefined
    readonly now: Partial<Record<Trust.Kind, string>>
    readonly differs: readonly Trust.Kind[]
  }> = [
    { name: "an unchanged kind", recorded: { hooks: "a" }, now: { hooks: "a" }, differs: [] },
    { name: "a kind whose digest differs", recorded: { hooks: "a", shell: "b" }, now: { hooks: "x", shell: "b" }, differs: ["hooks"] },
    { name: "a kind that was not there", recorded: { hooks: "a" }, now: { hooks: "a", mcp: "m" }, differs: ["mcp"] },
    { name: "a kind that is gone", recorded: { hooks: "a", mcp: "m" }, now: { hooks: "a" }, differs: [] },
    { name: "a source with nothing in it now", recorded: { hooks: "a" }, now: {}, differs: [] },
    { name: "a source with no record", recorded: undefined, now: { hooks: "a", env: "e" }, differs: ["hooks", "env"] },
    { name: "a source with no record and nothing in it", recorded: undefined, now: {}, differs: [] },
    { name: "a digest that could not be read", recorded: { hooks: "a" }, now: { hooks: WorkspaceTrust.unreadable }, differs: ["hooks"] },
  ]
  for (const row of rows) {
    it.live(`compares ${row.name}`, () =>
      Effect.gen(function* () {
        const folders = yield* fixture
        yield* Effect.gen(function* () {
          const trust = yield* WorkspaceTrust.Service
          yield* trust.grant(folders.repo, {
            persist: true,
            via: "test",
            observations: row.recorded === undefined ? [] : [observation(folders.first, row.recorded)],
          })
          const found = yield* trust.compare(folders.repo, [observation(folders.first, row.now)])
          expect(found.flatMap((item) => item.kinds).toSorted()).toEqual([...row.differs].toSorted())
          expect(found.every((item) => item.path === folders.first)).toBe(true)
        }).pipe(Effect.provide(build(folders)))
      }),
    )
  }

  it.live("does not record a digest that could not be read, so the kind stays changed after the grant", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const seen = [observation(folders.first, { hooks: WorkspaceTrust.unreadable, shell: "s" })]
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.repo, { persist: true, via: "test", observations: seen })
        expect(yield* trust.compare(folders.repo, seen)).toEqual([{ path: folders.first, kinds: ["hooks"] }])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("finds nothing different for an untrusted folder or for one the server trusts without a grant", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const seen = [observation(folders.first, { hooks: "h" })]
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.compare(folders.repo, seen)).toEqual([])
      }).pipe(Effect.provide(build(folders)))
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.compare(folders.repo, seen)).toEqual([])
      }).pipe(Effect.provide(build({ ...folders, implicit: true })))
    }),
  )

  it.live("compares nothing on a server that trusts every folder, even for a folder that also has a saved grant", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const seen = [observation(folders.first, { hooks: "h" })]
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        // A grant saved with no record of the source: on a server that asks, the source would read as changed.
        yield* trust.grant(folders.repo, { persist: true, via: "test", observations: [] })
        expect(yield* trust.compare(folders.repo, seen)).toEqual([{ path: folders.first, kinds: ["hooks"] }])
      }).pipe(Effect.provide(build(folders)))
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect((yield* trust.status(folders.repo)).source).toBe("saved")
        expect(yield* trust.compare(folders.repo, seen)).toEqual([])
      }).pipe(Effect.provide(build({ ...folders, implicit: true })))
    }),
  )

  it.live("leaves the records of other sources alone and drops those of files that no longer exist", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        const gone = path.join(folders.repo, "gone.json")
        yield* Effect.promise(() => fs.writeFile(gone, "{}"))
        yield* trust.grant(folders.repo, {
          persist: true,
          via: "test",
          observations: [observation(folders.first, { hooks: "a" }), observation(gone, { hooks: "g" })],
        })
        const recorded = (yield* kv.scan({ prefix: "trust-fingerprint/" })).entries
        expect(recorded).toHaveLength(2)

        yield* Effect.promise(() => fs.rm(gone))
        // A grant that saw only the second source: the first one's record stays, and the deleted file's goes.
        yield* trust.grant(folders.repo, {
          persist: true,
          via: "test",
          observations: [observation(folders.second, { mcp: "m" })],
        })
        const after = (yield* kv.scan({ prefix: "trust-fingerprint/" })).entries
        expect(after.map((entry) => (entry.value as { path: string }).path).toSorted()).toEqual(
          [folders.first, folders.second].toSorted(),
        )
        expect(yield* trust.compare(folders.repo, [observation(folders.first, { hooks: "a" })])).toEqual([])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("deletes the records with a revoke", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        const seen = [observation(folders.first, { hooks: "a" })]
        yield* trust.grant(folders.repo, { persist: true, via: "test", observations: seen })
        yield* trust.grant(folders.other, { persist: true, via: "test", observations: seen })
        expect((yield* kv.scan({ prefix: "trust-fingerprint/" })).entries).toHaveLength(2)
        yield* trust.revoke(folders.repo)
        expect((yield* kv.scan({ prefix: "trust-fingerprint/" })).entries).toHaveLength(1)
        // A grant made again after the revoke has no record to compare with.
        yield* trust.grant(folders.repo, { persist: true, via: "test" })
        expect(yield* trust.compare(folders.repo, seen)).toEqual([{ path: folders.first, kinds: ["hooks"] }])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("keeps the records of a folder inside a folder that is revoked or granted again", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        const child = AbsolutePath.make(path.join(folders.repo, "child"))
        const seen = [observation(folders.first, { hooks: "a" })]
        yield* trust.grant(folders.repo, { persist: true, via: "test", observations: seen })
        yield* trust.grant(child, { persist: true, via: "test", observations: [observation(folders.second, { mcp: "m" })] })
        expect((yield* kv.scan({ prefix: "trust-fingerprint/" })).entries).toHaveLength(2)

        // The child's keys start with the parent's prefix, and are not the parent's.
        yield* trust.revoke(folders.repo)
        const left = (yield* kv.scan({ prefix: "trust-fingerprint/" })).entries
        expect(left.map((entry) => (entry.value as { path: string }).path)).toEqual([folders.second])
        expect(yield* trust.compare(child, [observation(folders.second, { mcp: "m" })])).toEqual([])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("keeps the records of a grant that is not stored in memory, and loses them with the process", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const seen = [observation(folders.first, { hooks: "a" })]
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        yield* trust.grant(folders.repo, { persist: false, via: "test", observations: seen })
        expect(yield* trust.compare(folders.repo, seen)).toEqual([])
        expect(yield* trust.compare(folders.repo, [observation(folders.first, { hooks: "b" })])).toEqual([
          { path: folders.first, kinds: ["hooks"] },
        ])
        expect((yield* kv.scan({ prefix: "trust-fingerprint/" })).entries).toEqual([])
        yield* trust.revoke(folders.repo)
        expect(yield* trust.status(folders.repo)).toMatchObject({ trusted: false })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("does not list a record as a grant", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.repo, {
          persist: true,
          via: "test",
          observations: [observation(folders.first, { hooks: "a" })],
        })
        expect(yield* trust.list()).toHaveLength(1)
      }).pipe(Effect.provide(build(folders)))
    }),
  )
})

describe("WorkspaceTrust.forget", () => {
  it.live("ends a stored grant and its records by the directory it was shown as, without the folder existing", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        yield* trust.grant(folders.other, {
          persist: true,
          via: "test",
          observations: [observation(folders.first, { hooks: "a" })],
        })
        yield* Effect.promise(() => fs.rm(folders.other, { recursive: true }))
        // A different spelling of the same folder, as a person types it on a platform that ignores case.
        const spelled = process.platform === "win32" ? folders.other.toUpperCase() : folders.other
        expect(yield* trust.forget(spelled)).toEqual([folders.other])
        expect(yield* trust.list()).toEqual([])
        expect((yield* kv.scan({ prefix: "trust-fingerprint/" })).entries).toEqual([])
        expect(yield* trust.forget(folders.other)).toEqual([])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("answers nothing for a folder that was never granted", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(folders.repo, { persist: true, via: "test" })
        expect(yield* trust.forget(path.join(folders.root, "never"))).toEqual([])
        expect(yield* trust.list()).toHaveLength(1)
      }).pipe(Effect.provide(build(folders)))
    }),
  )
})
