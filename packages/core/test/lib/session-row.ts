import { Effect } from "effect"
import { Database } from "@orbit/core/database/database"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable } from "@orbit/core/session/sql"

/**
 * Writes the row of a session straight into the store, so that a test can name any ID, the ones that no client
 * should send included. `parentID` makes it a subagent's session and `fork` a fork of that session.
 */
export const insertSession = (input: {
  readonly id: string
  readonly directory: string
  readonly parentID?: string
  readonly fork?: string
  readonly agent?: string
  readonly permission?: SessionSchema.Info["permissions"]
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(input.directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make(input.id),
        project_id: Project.ID.global,
        slug: "scratchpad",
        directory: input.directory,
        title: "scratchpad",
        version: "test",
        agent: input.agent,
        parent_id: input.parentID === undefined ? undefined : SessionSchema.ID.make(input.parentID),
        fork_session_id: input.fork === undefined ? undefined : SessionSchema.ID.make(input.fork),
        fork_boundary:
          input.fork === undefined ? undefined : { type: "through", messageID: SessionMessage.ID.make("msg_boundary") },
        permission: input.permission,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
