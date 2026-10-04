import type { PermissionApi } from "@orbit/client/effect/api"
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
   * Other spellings of `resources` that rules may be written against, such as the full URL behind a host resource.
   * A hook that only inspects `resources` never sees them and decides on the primary spelling alone.
   */
  readonly aliases?: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: Permission.Source
  effect: Permission.Effect
  message?: string
}

export interface PermissionHooks {
  readonly evaluate: PermissionEvaluation
}

export type PermissionDomain = Pick<PermissionApi<unknown>, "list" | "get" | "reply"> & {
  readonly hook: Hooks<PermissionHooks>
}
