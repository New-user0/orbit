import { Location } from "@orbit/schema/location"
import { Trust } from "@orbit/schema/trust"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors.js"

export const LocationQuery = Schema.Struct({
  location: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "LocationQuery" })

export const locationQueryOpenApi = OpenApi.annotations({
  transform: (operation) => {
    const parameters = operation.parameters
    if (!Array.isArray(parameters)) return operation
    return {
      ...operation,
      parameters: parameters.map((parameter) =>
        parameter?.name === "location" && parameter?.in === "query"
          ? { ...parameter, style: "deepObject", explode: true }
          : parameter,
      ),
    }
  },
})

// Middleware is applied per endpoint: reload acts on every loaded location and
// must not boot the caller's location first.
export const makeLocationGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApiGroup.make("server.location")
    .add(
      HttpApiEndpoint.get("location.get", "/api/location", {
        query: LocationQuery,
        success: Location.PublicInfo,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "location.get",
            summary: "Get location",
            description: "Resolve the requested location or the server default location.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("location.reload", "/api/location/reload", {
        success: HttpApiSchema.NoContent,
        error: ServiceUnavailableError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "location.reload",
          summary: "Reload configuration",
          description:
            "Shut down and rebuild every loaded location. Pending permissions and forms are cancelled; running sessions continue with fresh services at the next step boundary. Emits location.shutdown for client recovery and responds once all replacement builds settle.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("location.trust.get", "/api/location/trust", {
        query: LocationQuery,
        success: Trust.Status,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "location.trust.get",
            summary: "Get workspace trust",
            description:
              "Report whether the requested location's project is trusted, why, and which configuration files and directories hold something back while it is not. Never waits for a person.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("location.trust.update", "/api/location/trust", {
        query: LocationQuery,
        payload: Schema.Struct({
          trust: Schema.Boolean.annotate({
            description: "True trusts the location's project; false ends every grant for it.",
          }),
          persist: Schema.optional(Schema.Boolean).annotate({
            description:
              "Whether a grant is stored on disk (true when omitted) or lasts only until the serving process restarts. A grant for the home directory or a filesystem root always lasts only until the restart. Ignored when trust is false.",
          }),
        }),
        success: Trust.Status,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "location.trust.update",
            summary: "Update workspace trust",
            description:
              "Trust or stop trusting the requested location's project. Trust belongs to the project's root folder, so its linked worktrees share it. Granting or revoking reloads the configuration of every open location it concerns, which turns what was held back on or off, and publishes trust.updated.",
          }),
        ),
    )
    .add(
      // Grants belong to the server, not to a location, so this one boots none.
      HttpApiEndpoint.get("trust.list", "/api/trust", {
        success: Schema.Array(Trust.Grant),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "trust.list",
          summary: "List trusted folders",
          description:
            "List the grants stored on disk, ordered by folder. A grant that lasts only until the serving process restarts is not listed.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "location" }))
