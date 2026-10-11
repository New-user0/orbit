import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { ProjectTrust } from "@orbit/core/project-trust"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { ServiceUnavailableError } from "@orbit/protocol/errors"
import { AbsolutePath } from "@orbit/schema/schema"
import { Cause, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const workspaces = yield* WorkspaceTrust.Service
    return handlers
      .handle(
        "location.get",
        Effect.fn(function* () {
          const location = yield* Location.Service
          return new Location.Info({
            directory: location.directory,
            project: location.project,
          })
        }),
      )
      .handle("location.reload", () =>
        LocationServiceMap.reload().pipe(
          Effect.provideService(LocationServiceMap.Service, locations),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.fail(new ServiceUnavailableError({ message: Cause.pretty(cause), service: "location" })),
          ),
        ),
      )
      .handle("location.trust.get", () => ProjectTrust.Service.use((trust) => trust.status()))
      .handle(
        "location.trust.update",
        Effect.fn(function* (ctx) {
          const trust = yield* ProjectTrust.Service
          if (!ctx.payload.trust) return yield* trust.revoke()
          // The API does not know which client asked, so a grant says only that it came through here.
          return yield* trust.grant({ persist: ctx.payload.persist ?? true, via: "api", holder: ctx.payload.holder })
        }),
      )
      .handle("trust.list", () => workspaces.list())
      .handle("trust.revoke", (ctx) => workspaces.forget(ctx.payload.directory).pipe(Effect.map((ended) => ended.map((item) => AbsolutePath.make(item)))))
  }),
)
