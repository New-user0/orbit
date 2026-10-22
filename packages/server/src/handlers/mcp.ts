import { requireTrusted, resolveNamed, untrustedFolder } from "./trust-error"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { LocalConfig, type ServerConfig } from "@orbit/schema/mcp"
import { Global } from "@orbit/util/global"
import { Mcp } from "@orbit/core/mcp/index"
import { ForbiddenError, McpServerNotFoundError } from "@orbit/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const notFound = <A, R>(effect: Effect.Effect<A, Mcp.NotFoundError, R>) =>
  effect.pipe(Effect.mapError((error) => new McpServerNotFoundError({ server: error.server, message: error.message })))

export const McpHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    // A local server that names a working folder starts there, read once from the Location's folder, so that folder has
    // to be trusted. The caller is told so at once, and the server is added with that very folder (class 3, class 13).
    // `Mcp` checks it again before it starts, as it does for a folder that a config or a plugin names.
    const placed = Effect.fnUntraced(function* (config: ServerConfig) {
      if (config.type !== "local" || config.cwd === undefined) return config
      const location = yield* Location.Service
      const cwd = yield* resolveNamed(location.directory, config.cwd, global.home, "cwd")
      const trust = yield* ProjectTrust.Service
      const state = yield* trust.folder(cwd)
      if (!state.trusted) return yield* untrustedFolder(state)
      return new LocalConfig({ ...config, cwd })
    })
    return handlers
      .handle(
        "mcp.list",
        Effect.fn(function* () {
          const service = yield* Mcp.Service
          return yield* response(
            service
              .servers()
              .pipe(
                Effect.map((servers) =>
                  servers.map((info) => ({ name: info.name, status: info.status, integrationID: info.integrationID })),
                ),
              ),
          )
        }),
      )
      .handle(
        "mcp.add",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* service
            .add(ctx.params.server, yield* placed(ctx.payload.config))
            .pipe(Effect.mapError((error) => new ForbiddenError({ message: error.message })))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.remove",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.remove(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.connect",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          const service = yield* Mcp.Service
          yield* notFound(service.connect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.disconnect",
        Effect.fn(function* (ctx) {
          const service = yield* Mcp.Service
          yield* notFound(service.disconnect(ctx.params.server))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "mcp.resource.catalog",
        Effect.fn(function* () {
          const service = yield* Mcp.Service
          return yield* response(service.resourceCatalog())
        }),
      )
  }),
)
