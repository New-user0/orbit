export * as Permission from "./permission.js"

import { Schema } from "effect"
import { FileDiff } from "./file-diff.js"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("Permission.ID"),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    id: Schema.String,
  }),
]).annotate({ identifier: "Permission.Source" })
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.Array(Schema.String).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  source: Source.pipe(optional),
  message: Schema.String.pipe(optional),
  // Set on an Edit or Write question: a person may answer it once with their own version of the file instead of the
  // proposal. The server keeps the text it read, so the reply carries only the new content.
  revisable: Schema.Boolean.pipe(optional),
}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
}).annotate({ identifier: "Permission.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const Mode = Schema.Literals(["default", "accept-edits", "plan", "bypass", "dont-ask", "auto"]).annotate({
  identifier: "Permission.Mode",
  description:
    "How permission requests are decided: default asks, accept-edits allows file edits, plan is read-only, bypass allows everything, dont-ask refuses what would be asked, auto lets a classifier decide",
})
export type Mode = typeof Mode.Type

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({ identifier: "Permission.Reply" })
export type Reply = typeof Reply.Type

const Asked = ephemeral({ type: "permission.asked", schema: Request.fields })
const Replied = ephemeral({
  type: "permission.replied",
  schema: {
    sessionID: SessionID,
    requestID: ID,
    reply: Reply,
    // Present when the person answered with their own version: the diff the server approved, from the file as the
    // question read it to that version, at the place the question named. It is what the tool then writes.
    files: Schema.Array(Schema.Struct({ ...FileDiff.Info.fields, place: Schema.String })).pipe(optional),
  },
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }

export const Effect = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "Permission.Effect" })
export type Effect = typeof Effect.Type

export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Effect,
}).annotate({ identifier: "Permission.Rule" })

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "Permission.Ruleset" })
export type Ruleset = typeof Ruleset.Type
