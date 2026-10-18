import { describe, expect } from "bun:test"
import { realpathSync } from "fs"
import fs from "fs/promises"
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
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { repository } from "./fixture/git"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// The sessions made while a folder was untrusted follow it into the trusted project, whichever way the trusted ID is
// chosen: a first commit (see project-trust-id.test.ts), a Mercurial folder, or an ID that the folder ships in `.git/orbit`.

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, WorkspaceTrust.node, SessionProjector.node]), [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
    Global.node.replace(tempGlobalLayer),
  ]),
)
const abs = AbsolutePath.make
const SLOW = 90_000

describe("sessions made before trust, by the way the trusted ID is chosen", () => {
  ;(
    [
      ["a Mercurial folder", async (root: string) => {
          await fs.mkdir(path.join(root, ".hg"), { recursive: true })
        },
      ],
      [
        "a git folder that ships .git/orbit",
        async (root: string) => {
          await Bun.write(path.join(root, ".git", "orbit"), "c".repeat(40) + "\n")
        },
      ],
    ] as const
  ).forEach(([name, plant]) =>
    it.live(
      `moves them for ${name}`,
      () =>
        Effect.gen(function* () {
          const root = path.join((yield* tmpdirScoped()).path, "clone")
          if (name.startsWith("a git")) yield* repository(root)
          else yield* Effect.promise(() => fs.mkdir(root, { recursive: true }))
          yield* Effect.promise(() => plant(root))
          const project = yield* Project.Service
          const trust = yield* WorkspaceTrust.Service
          const database = yield* Database.Service

          const before = yield* project.resolve(abs(root))
          const id = SessionID.make("ses_before_trust_previous")
          yield* database.db
            .insert(SessionTable)
            .values({ id, project_id: before.id, directory: abs(realpathSync.native(root)), slug: "before", version: "test" })
            .run()
          yield* trust.grant(root, { persist: false, via: "test" })
          const after = yield* project.resolve(abs(root))
          const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()

          expect(after.id).not.toBe(before.id)
          expect(after.previous).toBe(before.id)
          expect(row?.project_id).toBe(after.id)
        }),
      SLOW,
    ),
  )
})
