import { Permission } from "@orbit/core/permission"
import { Effect, Layer } from "effect"

export const permissionLayer = (overrides: Partial<Permission.Interface> = {}) =>
  Layer.mock(Permission.Service, { close: Effect.void, denied: () => Effect.succeed(false), ...overrides })

/**
 * Stands in for Permission in suites that build the Tool node without ever asking: the registry authorizes the Code
 * Mode functions that are not tools through it, so the node needs one, and every assertion passes.
 */
export const allowAllPermission = permissionLayer({ assert: () => Effect.void })
