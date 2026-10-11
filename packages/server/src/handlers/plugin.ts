import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Plugin } from "@orbit/core/plugin"
import { PluginUpdate } from "@orbit/core/plugin/update"
import { ForbiddenError, InvalidRequestError, ServiceUnavailableError } from "@orbit/protocol/errors"
import { PluginRestriction } from "@orbit/plugin/restriction"
import { Cause, Effect, Exit } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

/**
 * Why the organization's plugin lists keep a package from being installed, or undefined when they let it through. It
 * is asked before any registry request, the same way `orb plugin add` asks it.
 */
const refusal = (target: string) =>
  Effect.gen(function* () {
    const policy = yield* ManagedPolicy.Service
    const restrictions = policy.current().restrictions.plugins ?? {}
    const identity = yield* Effect.promise(() => PluginRestriction.identify(target))
    const checked = PluginRestriction.check(restrictions, identity)
    if (checked.allowed) return undefined
    return checked.reason === "blocked"
      ? `Plugin "${target}" is blocked by managed settings`
      : `Plugin "${target}" is not on the allow list in managed settings`
  })

export const PluginHandler = HttpApiBuilder.group(Api, "server.plugin", (handlers) =>
  handlers
    .handle("plugin.list", () =>
      Effect.gen(function* () {
        return yield* response(Plugin.Service.use((plugin) => plugin.list()))
      }),
    )
    .handle("plugin.check", (ctx) =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const inventory = yield* plugins.list()
        const targets = [
          ...new Set(inventory.flatMap((plugin) => (plugin.source.type === "package" ? [plugin.source.target] : []))),
        ].filter((target) => ctx.payload.target === undefined || target === ctx.payload.target)
        // A blocked package stays in the inventory as a failed entry, but it is never asked about: that is a request to its registry.
        const refused = new Set(
          yield* Effect.filter(targets, (target) => refusal(target).pipe(Effect.map((reason) => reason !== undefined))),
        )
        if (ctx.payload.target !== undefined && !targets.length)
          return yield* new InvalidRequestError({
            message: `Plugin package is not in the current server inventory: ${ctx.payload.target}`,
            field: "target",
          })
        const updates = yield* PluginUpdate.Service
        const outdated = new Map(
          yield* Effect.forEach(
            targets.filter((target) => !refused.has(target)),
            (target) => updates.check(target, { refresh: true }).pipe(Effect.map((value) => [target, value] as const)),
            { concurrency: "unbounded" },
          ),
        )
        return yield* response(
          Effect.succeed(
            inventory.map((plugin) => {
              if (plugin.source.type !== "package" || !outdated.has(plugin.source.target)) return plugin
              return {
                ...plugin,
                source: {
                  type: "package" as const,
                  target: plugin.source.target,
                  ...(plugin.source.version ? { version: plugin.source.version } : {}),
                  ...(outdated.get(plugin.source.target) ? { outdated: true as const } : {}),
                  ...(plugin.source.updating ? { updating: true as const } : {}),
                },
              }
            }),
          ),
        )
      }),
    )
    .handle("plugin.update", (ctx) =>
      Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const inventory = new Set(
          (yield* plugins.list()).flatMap((plugin) => (plugin.source.type === "package" ? [plugin.source.target] : [])),
        )
        const unknown = ctx.payload.targets.filter((target) => !inventory.has(target))
        if (unknown.length)
          return yield* new InvalidRequestError({
            message: `Plugin packages are not in the current server inventory: ${unknown.join(", ")}`,
            field: "targets",
          })
        // Before any update starts, so one blocked target downloads nothing and the others are not half-applied.
        const refusals = (yield* Effect.forEach(ctx.payload.targets, refusal)).filter(
          (reason): reason is string => reason !== undefined,
        )
        if (refusals.length) return yield* new ForbiddenError({ message: refusals.join("; ") })
        const updates = yield* PluginUpdate.Service
        // Let every update run to completion instead of interrupting the rest on the first failure.
        const failures = yield* Effect.forEach(
          ctx.payload.targets,
          (target) =>
            updates.update(target).pipe(
              Effect.exit,
              Effect.map((exit) => (Exit.isFailure(exit) ? [`${target}: ${Cause.pretty(exit.cause)}`] : [])),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => results.flat()))
        if (failures.length)
          return yield* new ServiceUnavailableError({
            message: `Failed to update plugin packages: ${failures.join("; ")}`,
            service: "plugin",
          })
      }),
    ),
)
