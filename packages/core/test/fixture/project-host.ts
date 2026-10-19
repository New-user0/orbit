import { realpathSync } from "fs"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionTable } from "@orbit/core/session/sql"
import { gitExecutable } from "@orbit/core/util/git-executable"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { SessionID } from "@orbit/schema/session-id"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { tempGlobalLayer } from "./global"

// What `Project.resolve` names the folder in the first argument before and after the person trusts the folder it named,
// and where a session made before the grant ends up. A test runs this file in a process of its own with a PATH that it
// chose, because `gitExecutable` is decided once when the module loads. It prints one line of JSON.
const start = AbsolutePath.make(process.argv[2]!)

const result = await Effect.gen(function* () {
  const project = yield* Project.Service
  const trust = yield* WorkspaceTrust.Service
  const database = yield* Database.Service
  const before = yield* project.resolve(start)
  const id = SessionID.make("ses_project_host")
  yield* database.db
    .insert(SessionTable)
    .values({ id, project_id: before.id, directory: AbsolutePath.make(realpathSync.native(start)), slug: "host", version: "test" })
    .run()
  yield* trust.grant(before.canonical, { persist: false, via: "test" })
  const after = yield* project.resolve(start)
  const row = yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()
  return { gitExecutable, before, after, session: row?.project_id, trusted: (yield* trust.status(after.canonical)).trusted }
}).pipe(
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, WorkspaceTrust.node, SessionProjector.node]), [
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
      Global.node.replace(tempGlobalLayer),
    ]),
  ),
  Effect.scoped,
  Effect.runPromise,
)

console.log(JSON.stringify(result))
