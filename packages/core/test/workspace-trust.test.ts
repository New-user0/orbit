import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Trust } from "@orbit/schema/trust"
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
  const folder = (name: string) => AbsolutePath.make(path.join(root, name))
  const folders = { root, home: folder("home"), repo: folder("repo"), other: folder("other") }
  yield* Effect.promise(() =>
    Promise.all([folders.home, folders.repo, folders.other].map((directory) => fs.mkdir(directory))),
  )
  return { ...folders, database: path.join(root, "trust.db") }
})

describe("WorkspaceTrust", () => {
  it.live("persists a grant across two builds over one file database", () =>
    Effect.gen(function* () {
      const folders = yield* fixture

      const granted = yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.status(folders.repo)).toEqual({
          directory: folders.repo,
          trusted: false,
          persistent: true,
        })
        const status = yield* trust.grant(folders.repo, { persist: true, via: "test" })
        // A grant that lasts only until the process stops, in the same build.
        yield* trust.grant(folders.other, { persist: false, via: "test" })
        expect(yield* trust.status(folders.other)).toMatchObject({ trusted: true, source: "session" })
        return status
      }).pipe(Effect.provide(build(folders)))
      expect(granted).toEqual({ directory: folders.repo, trusted: true, persistent: true, source: "saved" })

      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.status(folders.repo)).toEqual(granted)
        // The session grant ended with the first build.
        expect(yield* trust.status(folders.other)).toEqual({
          directory: folders.other,
          trusted: false,
          persistent: true,
        })
        const [grant, ...rest] = yield* trust.list()
        expect(rest).toEqual([])
        expect(grant).toMatchObject({ directory: folders.repo, via: "test" })
        expect(grant?.time).toBeGreaterThan(0)
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  // Another process that serves the same database, such as the background service, ends a stored grant by removing its
  // record. A grant for this process that the stored one replaced must not keep the folder trusted after that.
  it.live("a stored grant replaces a grant for this process, so a revoke made by another process ends it", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        expect(yield* trust.grant(folders.repo, { persist: false, via: "test" })).toMatchObject({ source: "session" })
        expect(yield* trust.grant(folders.repo, { persist: true, via: "test" })).toMatchObject({ source: "saved" })
        yield* kv.remove(`trust/${WorkspaceTrust.key(folders.repo)}`)
        expect(yield* trust.status(folders.repo)).toEqual({ directory: folders.repo, trusted: false, persistent: true })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("never stores a grant for the home directory or a filesystem root", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const systemRoot = path.parse(folders.root).root
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        for (const directory of [folders.home, systemRoot]) {
          expect(yield* trust.status(directory)).toMatchObject({ trusted: false, persistent: false })
          // Asking to persist trusts it until this process stops, and says so.
          expect(yield* trust.grant(directory, { persist: true, via: "test" })).toMatchObject({
            trusted: true,
            persistent: false,
            source: "session",
          })
        }
        expect(yield* trust.list()).toEqual([])
        expect((yield* kv.scan({ prefix: "trust/" })).entries).toEqual([])

        // A record that got there some other way never counts for them either.
        yield* trust.revoke(folders.home)
        yield* kv.set(`trust/${WorkspaceTrust.key(folders.home)}`, {
          directory: folders.home,
          time: 1,
          via: "elsewhere",
        })
        expect(yield* trust.status(folders.home)).toMatchObject({ trusted: false, persistent: false })
      }).pipe(Effect.provide(build(folders)))

      // Nothing the first build granted outlives it.
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.status(folders.home)).toMatchObject({ trusted: false })
        expect(yield* trust.status(systemRoot)).toMatchObject({ trusted: false })
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("trusts every folder but home and filesystem roots in implicit mode", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const systemRoot = path.parse(folders.root).root
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        expect(yield* trust.status(folders.repo)).toEqual({
          directory: folders.repo,
          trusted: true,
          persistent: true,
          source: "implicit",
        })
        expect(yield* trust.status(folders.home)).toMatchObject({ trusted: false, persistent: false })
        expect(yield* trust.status(systemRoot)).toMatchObject({ trusted: false, persistent: false })
        // An explicit grant still works where implicit trust does not reach, and a saved one outranks implicit.
        expect(yield* trust.grant(folders.home, { persist: false, via: "test" })).toMatchObject({
          trusted: true,
          source: "session",
        })
        expect(yield* trust.grant(folders.repo, { persist: true, via: "test" })).toMatchObject({ source: "saved" })
        // Revoking cannot take implicit trust away.
        expect(yield* trust.revoke(folders.repo)).toMatchObject({ trusted: true, source: "implicit" })
      }).pipe(Effect.provide(build({ ...folders, implicit: true })))
    }),
  )

  it.live("revokes a grant and publishes trust.updated for each change", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const bus = yield* Bus.Service
        const events = yield* bus
          .subscribe(Trust.Event.Updated)
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))

        yield* trust.grant(folders.repo, { persist: true, via: "test" })
        expect(yield* trust.revoke(folders.repo)).toEqual({
          directory: folders.repo,
          trusted: false,
          persistent: true,
        })
        expect(yield* trust.list()).toEqual([])
        yield* trust.grant(folders.repo, { persist: false, via: "test" })
        expect(yield* trust.status(folders.repo)).toMatchObject({ trusted: true, source: "session" })
        expect(yield* trust.revoke(folders.repo)).toMatchObject({ trusted: false })

        const published = yield* Fiber.join(events)
        expect(published.map((event) => event.data)).toEqual([
          { directory: folders.repo, trusted: true },
          { directory: folders.repo, trusted: false },
          { directory: folders.repo, trusted: true },
          { directory: folders.repo, trusted: false },
        ])
        // The event belongs to no Location, so every Location's config hears it.
        expect(published.map((event) => event.location)).toEqual([undefined, undefined, undefined, undefined])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("answers to one key however the folder is reached", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      const link = path.join(folders.root, "link")
      yield* Effect.promise(() => fs.symlink(folders.repo, link, process.platform === "win32" ? "junction" : undefined))
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(link, { persist: true, via: "test" })
        expect(yield* trust.status(folders.repo)).toMatchObject({ trusted: true, directory: folders.repo })
        expect(yield* trust.status(folders.repo + path.sep)).toMatchObject({ trusted: true, directory: folders.repo })
        expect(yield* trust.list()).toHaveLength(1)
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.live("does not trust a stored record that is not a grant", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        const kv = yield* KV.Service
        yield* kv.set(`trust/${WorkspaceTrust.key(folders.repo)}`, "yes")
        yield* trust.grant(folders.other, { persist: true, via: "test" })
        expect(yield* trust.status(folders.repo)).toMatchObject({ trusted: false })
        expect((yield* trust.list()).map((grant) => grant.directory)).toEqual([folders.other])
      }).pipe(Effect.provide(build(folders)))
    }),
  )

  it.effect("keys folders by case only where the file system ignores it", () =>
    Effect.sync(() => {
      expect(WorkspaceTrust.key("C:\\Repo", "win32")).toBe(WorkspaceTrust.key("c:\\repo", "win32"))
      expect(WorkspaceTrust.key("C:\\Repo", "win32")).toBe("c:\\repo")
      expect(WorkspaceTrust.key("/home/Dev/Repo", "linux")).not.toBe(WorkspaceTrust.key("/home/dev/repo", "linux"))
    }),
  )

  const windows = process.platform === "win32" ? it.live : it.live.skip
  windows("shares one key between C:\\Repo and c:\\repo", () =>
    Effect.gen(function* () {
      const folders = yield* fixture
      // A folder that exists is reported with the case the disk gives it; one that does not keeps the case it was
      // asked for, so only the key can make its spellings one.
      const ghost = path.join(folders.root, "Ghost")
      const drive = (directory: string, change: (text: string) => string) => change(directory[0]) + directory.slice(1)
      yield* Effect.gen(function* () {
        const trust = yield* WorkspaceTrust.Service
        yield* trust.grant(
          drive(folders.repo, (letter) => letter.toUpperCase()),
          { persist: true, via: "test" },
        )
        expect(yield* trust.status(drive(folders.repo, (letter) => letter.toLowerCase()))).toMatchObject({
          trusted: true,
          source: "saved",
        })
        yield* trust.grant(ghost.toUpperCase(), { persist: true, via: "test" })
        expect(yield* trust.status(ghost.toLowerCase())).toMatchObject({ trusted: true, source: "saved" })
        expect(yield* trust.list()).toHaveLength(2)
        expect(yield* trust.revoke(ghost.toLowerCase())).toMatchObject({ trusted: false })
        expect(yield* trust.status(ghost.toUpperCase())).toMatchObject({ trusted: false })
      }).pipe(Effect.provide(build(folders)))
    }),
  )
})
