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
import { repository } from "./fixture/git"
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
})
