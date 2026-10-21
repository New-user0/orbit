import { Instruction } from "@orbit/schema/instruction"
import { Location } from "@orbit/schema/location"
import { AbsolutePath } from "@orbit/schema/schema"
import { Trust } from "@orbit/schema/trust"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError, UntrustedFolderError } from "../errors.js"

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
          holder: Schema.optional(Schema.String).annotate({
            description:
              "A folder to trust instead of the location's project: the project's own root, or the `directory` of a file in `withheld` that sits in a folder above the project. Any other folder trusts nothing and leaves the status as it is. The answer is always the location's status. Ignored when trust is false.",
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
      HttpApiEndpoint.get("instruction.note.targets", "/api/location/instructions/note", {
        query: LocationQuery,
        success: Schema.Struct({ data: Schema.Array(Instruction.NoteTarget) }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "instruction.note.targets",
            summary: "List instruction note targets",
            description:
              "For the user, project and local scopes, in that order, the instruction file a note would be added to, whether it exists, whether the scope's instruction files are loaded here, and whether the file is loaded now. It reads the instruction files from disk again first, so the answer does not depend on a file watcher. Nothing is written.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("instruction.note.add", "/api/location/instructions/note", {
        query: LocationQuery,
        payload: Schema.Struct({
          scope: Instruction.NoteScope,
          text: Schema.Trim.pipe(
            Schema.check(Schema.isMinLength(1), Schema.isMaxLength(Instruction.NOTE_LIMIT)),
          ).annotate({
            description: `The note, without surrounding white space: 1 to ${Instruction.NOTE_LIMIT} characters. Its first line becomes a bullet and later lines are indented under it.`,
          }),
        }),
        success: Schema.Struct({ data: Instruction.NoteAdded }),
        error: [InvalidRequestError, ServiceUnavailableError, UntrustedFolderError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "instruction.note.add",
            summary: "Add an instruction note",
            description:
              "Append a note as a bullet to the instruction file the loader reads for the scope, creating ORBIT.md (user), AGENTS.md (project) or ORBIT.local.md (local) when there is none, then read the instruction files again so the note is listed at once. A new local file is kept out of git through the repository's own exclude file. A scope that is not loaded here, an instruction list that could not be read, a file that instructions_exclude drops and a file that leads outside an untrusted project are refused with kind disabled, unavailable, excluded or outside, and nothing is written. A folder that is not trusted is refused with an untrusted-folder error, whatever the scope, and nothing is written. A file that cannot be written is a service-unavailable error for the instructions service.",
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
    .add(
      // Like the list, a grant belongs to the server: this one ends it by the folder's name, so a deleted folder works.
      HttpApiEndpoint.post("trust.revoke", "/api/trust/revoke", {
        payload: Schema.Struct({
          directory: Schema.String.annotate({
            description:
              "The folder as it is listed or as it was typed. It is matched by name, never looked up on disk, so a folder that was deleted can still be revoked; on a file system that ignores case, a different case matches.",
          }),
        }),
        success: Schema.Array(AbsolutePath).annotate({
          description: "The folders whose stored grants this ended. Empty when none matched.",
        }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "trust.revoke",
          summary: "Revoke a trusted folder by name",
          description:
            "End the stored grant for a folder, and what it recorded about the folder's config, by the folder's name. Only narrows trust, and publishes trust.updated for each folder it ends.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "location" }))
