export * as Agent from "./agent.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"
import { Model } from "./model.js"
import { Permission } from "./permission.js"
import { Provider } from "./provider.js"
import { ConfigAgent } from "./config/agent.js"
import { ConfigHooks } from "./config/hooks.js"
import { Scope } from "./config.js"
import { AbsolutePath } from "./schema.js"
import { PositiveInt, statics } from "./schema.js"

const Updated = ephemeral({ type: "agent.updated", schema: {} })

export const ID = Schema.String.pipe(Schema.brand("Agent.ID"))
export type ID = typeof ID.Type

export const Name = Schema.String.pipe(Schema.brand("Agent.Name"))
export type Name = typeof Name.Type

export const Color = Schema.String.annotate({ identifier: "Agent.Color" })
export type Color = typeof Color.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Name,
  model: Model.Ref.pipe(optional),
  request: Provider.Request,
  system: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(optional),
  steps: PositiveInt.pipe(optional),
  permissions: Permission.Ruleset,
  modelTier: ConfigAgent.ModelTier.pipe(optional),
  effort: Model.VariantID.pipe(optional),
  tools: Schema.Struct({
    allow: Schema.Array(Schema.String).pipe(optional).annotate({
      description: "The only tools the agent may use. Absent means every tool; an empty list means none",
    }),
    deny: Schema.Array(Schema.String).pipe(optional).annotate({ description: "Tools removed from the agent" }),
  }).pipe(optional),
  permissionMode: Permission.Mode.pipe(optional),
  mcpServers: Schema.Array(ConfigAgent.McpServer).pipe(optional),
  hooks: ConfigHooks.Info.pipe(optional),
  skills: Schema.Array(Schema.String).pipe(optional),
  initialPrompt: Schema.String.pipe(optional),
  memory: ConfigAgent.Memory.pipe(optional),
  background: Schema.Boolean.pipe(optional),
  isolation: ConfigAgent.Isolation.pipe(optional),
  context: ConfigAgent.Context.pipe(optional),
  source: Schema.Struct({
    scope: Scope,
    path: AbsolutePath.pipe(optional),
    plugin: Schema.String.pipe(optional),
  })
    .pipe(optional)
    .annotate({ description: "Where the definition came from. Absent for an agent that Orbit ships" }),
})
  .annotate({ identifier: "Agent.Info" })
  .pipe(
    statics(() => ({
      default: (id: ID) =>
        ({
          id,
          name: Name.make(id),
          request: { settings: {}, headers: {}, body: {} },
          mode: "primary",
          hidden: false,
          permissions: [
            { action: "*", resource: "*", effect: "allow" },
            { action: "external_directory", resource: "*", effect: "ask" },
            { action: "read", resource: "*.env", effect: "ask" },
            { action: "read", resource: "*.env.*", effect: "ask" },
            { action: "read", resource: "*.env.example", effect: "allow" },
          ],
        }) satisfies Info,
    })),
  )

export const Event = {
  Updated,
  Definitions: inventory(Updated),
}
