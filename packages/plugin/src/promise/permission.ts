import type { PermissionApi } from "@orbit/client/promise/api"
import type { Agent } from "@orbit/schema/agent"
import type { Permission } from "@orbit/schema/permission"
import type { Session } from "@orbit/schema/session"
import type { Hooks } from "./registration.js"

export interface PermissionEvaluation {
  readonly sessionID: Session.ID
  readonly agent?: Agent.ID
  readonly action: string
  readonly resources: ReadonlyArray<string>
  /**
   * Other spellings of a resource that rules may be written against, keyed by that resource, such as the host behind
   * a URL. A resource with no entry has none, so an alias never speaks for another resource of the same request. A
   * hook that only inspects `resources` never sees them and decides on the primary spelling alone.
   */
  readonly aliases?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: Permission.Effect
  message?: string
}

export interface PermissionHooks {
  readonly evaluate: PermissionEvaluation
}

export type PermissionDomain = Pick<PermissionApi, "list" | "get" | "reply"> & {
  readonly hook: Hooks<PermissionHooks>
}
