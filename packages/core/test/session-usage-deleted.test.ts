// A usage or side-query record published after its Session was deleted is dropped quietly: no defect, no row.
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionTable, SessionUsageTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { Money } from "@orbit/schema/money"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured())],
  ),
)
const sessionID = Session.ID.make("ses_deleted_late")

describe("usage after the session is deleted", () => {
  for (const kind of ["usage", "side_query"] as const)
    it.effect(`a ${kind} record published after the session is deleted`, () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const bus = yield* Bus.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "s",
            directory: "/project",
            title: "t",
            version: "t",
          })
          .run()
        yield* bus.publish(SessionEvent.Deleted, { sessionID })
        yield* bus.remove(sessionID)
        const usage = {
          cost: Money.USD.make(1),
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        const exit = yield* Effect.exit(
          kind === "usage"
            ? bus.publish(SessionEvent.UsageRecorded, { sessionID, source: "title", ...usage })
            : bus.publish(SessionEvent.SideQueryRecorded, { sessionID, purpose: "webfetch.summarize", ...usage }),
        )
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(
          yield* db.select().from(SessionUsageTable).where(eq(SessionUsageTable.session_id, sessionID)).all(),
        ).toEqual([])
      }),
    )
})
