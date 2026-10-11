export * as ManagedPolicy from "./managed-policy.js"

import { ConfigManaged } from "@orbit/schema/config/managed"
import { ConfigPolicy } from "@orbit/schema/config/policy"
import type { Mcp } from "@orbit/schema/mcp"
import type { Permission } from "@orbit/schema/permission"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@orbit/util/effect/app-node"

/** Where organization policy comes from: the managed settings files on disk, or the connected Console. */
export type Source = "file" | "connection"

/** The MCP servers the managed settings files define, and the timeout defaults they set. */
export interface McpDefinitions {
  readonly servers: Readonly<Record<string, Mcp.ServerConfig>>
  readonly timeout?: Mcp.TimeoutConfig
}

/** What one managed source supplies. */
export interface State {
  readonly statements: ReadonlyArray<ConfigPolicy.Info>
  /** Permission rules from the managed settings files. Only the file source supplies them. */
  readonly rules?: Permission.Ruleset
  /** Permission rules that managed settings give a named agent (`agents.<name>.permissions`). */
  readonly agentRules?: Readonly<Record<string, Permission.Ruleset>>
  /** Restrictions from the managed settings files. Only the file source supplies them. */
  readonly restrictions?: ConfigManaged.Restrictions
  /** The MCP servers the managed settings files define. Only the file source supplies them. */
  readonly mcp?: McpDefinitions
  /** Organization name for denial messages, when the source knows it. */
  readonly organization?: string
}

/** The sources merged. */
export interface Current {
  /** The file source's statements, then the connection's. */
  readonly statements: ReadonlyArray<ConfigPolicy.Info>
  readonly rules: Permission.Ruleset
  readonly agentRules: Readonly<Record<string, Permission.Ruleset>>
  readonly restrictions: ConfigManaged.Restrictions
  /** The MCP servers the managed settings files define; what runs when `restrictions.mcp.managed_only` is set. */
  readonly mcp: McpDefinitions
  /** The file's organization, else the connection's. */
  readonly organization?: string
}

export interface Interface {
  /** Synchronous so catalog transforms can consult the statements while they run. */
  readonly current: () => Current
  /** Replaces the state of one source and leaves the other as it is; statements never merge across reloads. */
  readonly set: (source: Source, state: State) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/ManagedPolicy") {}

const empty: State = { statements: [] }

export const layer = Layer.sync(Service, () => {
  const sources: Record<Source, State> = { file: empty, connection: empty }
  return Service.of({
    current: () => {
      const organization = sources.file.organization ?? sources.connection.organization
      return {
        statements: [...sources.file.statements, ...sources.connection.statements],
        rules: sources.file.rules ?? [],
        agentRules: sources.file.agentRules ?? {},
        restrictions: sources.file.restrictions ?? {},
        mcp: sources.file.mcp ?? { servers: {} },
        ...(organization === undefined ? {} : { organization }),
      }
    },
    set: (source, next) =>
      Effect.sync(() => {
        sources[source] = next
      }),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
