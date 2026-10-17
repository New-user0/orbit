import { describe, expect } from "bun:test"
import { realpathSync } from "fs"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { Project } from "@orbit/core/project"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionID } from "@orbit/schema/session-id"
import { eq } from "drizzle-orm"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Hash } from "@orbit/util/hash"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { git, repository } from "./fixture/git"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Review of #118: a repository with no remote is named by its path while it is not trusted and by its first commit once it
// is. One ID per repository has to hold across the decision, or the sessions made before it drop out of the project, and a
// database that already holds the project does not read it as a new one while the folder is untrusted.

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, WorkspaceTrust.node, SessionProjector.node]), [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
    Global.node.replace(tempGlobalLayer),
  ]),
)
const abs = AbsolutePath.make
const SLOW = 90_000
const pathID = (folder: string) => Project.ID.make(Hash.fast(`directory:${folder}`))
const real = (file: string) => Effect.sync(() => abs(realpathSync.native(file)))

describe("the project ID of a folder with no remote across the trust decision", () => {
  it.live(
    "names the untrusted ID as the previous one when the folder is trusted",
    () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        yield* repository(root)
        const project = yield* Project.Service
        const trust = yield* WorkspaceTrust.Service

        const before = yield* project.resolve(abs(root))
        yield* trust.grant(root, { persist: false, via: "test" })
        const after = yield* project.resolve(abs(root))

        expect(before.id).toBe(pathID(yield* real(root)))
        expect(after.id).not.toBe(before.id)
        expect(after.previous).toBe(before.id)
      }),
    SLOW,
  )

  it.live(
    "keeps the ID that Orbit already holds for the folder while it is not trusted",
    () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        yield* repository(root)
        const project = yield* Project.Service
        const trust = yield* WorkspaceTrust.Service

        // As a database from a version that named an untrusted folder by its first commit.
        yield* trust.grant(root, { persist: false, via: "test" })
        const known = yield* project.resolve(abs(root))
        yield* trust.revoke(root)
        const again = yield* project.resolve(abs(root))

        expect(known.id).not.toBe(pathID(yield* real(root)))
        expect(again.id).toBe(known.id)
      }),
    SLOW,
  )

  it.live(
    "keeps the trusted ID when trust is granted, revoked and the folder is resolved again",
    () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        yield* repository(root)
        const project = yield* Project.Service
        const trust = yield* WorkspaceTrust.Service

        const untrusted = yield* project.resolve(abs(root))
        yield* trust.grant(root, { persist: false, via: "test" })
        const trusted = yield* project.resolve(abs(root))
        yield* trust.revoke(root)
        const revoked = yield* project.resolve(abs(root))
        yield* trust.grant(root, { persist: false, via: "test" })
        const again = yield* project.resolve(abs(root))

        expect(untrusted.id).toBe(pathID(yield* real(root)))
        expect(trusted.id).not.toBe(untrusted.id)
        expect(revoked.id).toBe(trusted.id)
        expect(again.id).toBe(trusted.id)
      }),
    SLOW,
  )

  it.live(
    "lists a session made before trust in the trusted project",
    () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        yield* repository(root)
        const project = yield* Project.Service
        const trust = yield* WorkspaceTrust.Service
        const database = yield* Database.Service

        const before = yield* project.resolve(abs(root))
        const id = SessionID.make("ses_before_trust")
        yield* database.db
          .insert(SessionTable)
          .values({ id, project_id: before.id, directory: abs(yield* real(root)), slug: "before", version: "test" })
          .run()
        yield* trust.grant(root, { persist: false, via: "test" })
        const after = yield* project.resolve(abs(root))
        const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()

        expect(after.id).not.toBe(before.id)
        expect(row?.project_id).toBe(after.id)
      }),
    SLOW,
  )

  // Review of #118, round 3: which checkout was resolved first decides which path hash the old row holds, and a checkout
  // that is not that one must still find the project trust made after a revoke.
  ;(["main", "linked"] as const).forEach((first) =>
    it.live(
      `keeps each checkout's trusted ID after a revoke when ${first} was resolved first`,
      () =>
        Effect.gen(function* () {
          const base = (yield* tmpdirScoped()).path
          const folders = { main: path.join(base, "clone"), linked: path.join(base, "linked") }
          yield* repository(folders.main)
          yield* Effect.promise(() => git(folders.main, "worktree", "add", "-b", "side", folders.linked))
          const project = yield* Project.Service
          const trust = yield* WorkspaceTrust.Service
          const names = first === "main" ? (["main", "linked"] as const) : (["linked", "main"] as const)
          const resolve = Effect.forEach(names, (name) =>
            project.resolve(abs(folders[name])).pipe(Effect.map((found) => [name, found.id] as const)),
          ).pipe(Effect.map((entries) => Object.fromEntries(entries)))

          yield* resolve
          yield* trust.grant(folders.main, { persist: false, via: "test" })
          const trusted = yield* resolve
          yield* trust.revoke(folders.main)
          const revoked = yield* resolve
          yield* trust.grant(folders.main, { persist: false, via: "test" })
          const again = yield* resolve

          expect(revoked).toEqual(trusted)
          expect(again).toEqual(trusted)
        }),
      SLOW,
    ),
  )

  // Review of #118, round 4: the sessions each checkout made before trust follow the repository into the trusted project,
  // for every order of untrusted and trusted resolves (taking the earlier ID from the preferred row loses them).
  ;(
    [
      ["main", "main"],
      ["main", "linked"],
      ["linked", "main"],
      ["linked", "linked"],
    ] as const
  ).forEach(([first, trustedFirst]) =>
    it.live(
      `moves each checkout's earlier sessions when untrusted ${first} and trusted ${trustedFirst} are resolved first`,
      () =>
        Effect.gen(function* () {
          const base = (yield* tmpdirScoped()).path
          const folders = { main: path.join(base, "clone"), linked: path.join(base, "linked") }
          yield* repository(folders.main)
          yield* Effect.promise(() => git(folders.main, "worktree", "add", "-b", "side", folders.linked))
          const project = yield* Project.Service
          const trust = yield* WorkspaceTrust.Service
          const database = yield* Database.Service
          const order = (head: "main" | "linked") =>
            head === "main" ? (["main", "linked"] as const) : (["linked", "main"] as const)
          const resolve = (head: "main" | "linked") =>
            Effect.forEach(order(head), (name) =>
              project.resolve(abs(folders[name])).pipe(Effect.map((found) => [name, found.id] as const)),
            ).pipe(Effect.map((entries) => Object.fromEntries(entries) as Record<"main" | "linked", Project.ID>))

          const untrusted = yield* resolve(first)
          yield* Effect.forEach(["main", "linked"] as const, (name) =>
            database.db
              .insert(SessionTable)
              .values({
                id: SessionID.make(`ses_round4_${name}`),
                project_id: untrusted[name],
                directory: realpathSync.native(folders[name]),
                slug: name,
                version: "test",
              })
              .run(),
          )
          yield* trust.grant(folders.main, { persist: false, via: "test" })
          const trusted = yield* resolve(trustedFirst)
          const rows = yield* Effect.forEach(["main", "linked"] as const, (name) =>
            database.db
              .select()
              .from(SessionTable)
              .where(eq(SessionTable.id, SessionID.make(`ses_round4_${name}`)))
              .get(),
          )

          expect(trusted.main).toBe(trusted.linked)
          expect(rows.map((row) => row?.project_id)).toEqual([trusted.main, trusted.linked])
        }),
      SLOW,
    ),
  )
})
