import { Git } from "@orbit/core/git"
import { Worktree } from "@orbit/core/worktree"
import { Project } from "@orbit/core/project"
import { ProjectNotFoundError, UntrustedFolderError } from "@orbit/protocol/errors"
import { WorktreeError } from "@orbit/protocol/groups/worktree"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { untrustedFolder } from "./trust-error"

export const WorktreeHandler = HttpApiBuilder.group(Api, "server.worktree", (handlers) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktree.Service
    return handlers
      .handle("worktree.list", (ctx) =>
        worktrees.list(ctx.query).pipe(Effect.catchTag("Project.NotFoundError", missingProject)),
      )
      .handle("worktree.create", (ctx) => worktrees.create(ctx.payload).pipe(badRequest))
      .handle("worktree.remove", (ctx) =>
        worktrees.remove(ctx.payload).pipe(badRequest, Effect.as(HttpApiSchema.NoContent.make())),
      )
      .handle("worktree.refresh", (ctx) =>
        worktrees.refresh(ctx.payload).pipe(badRequest, Effect.as(HttpApiSchema.NoContent.make())),
      )
  }),
)

function badRequest<A, R>(effect: Effect.Effect<A, Worktree.Error, R>) {
  return effect.pipe(
    Effect.catchTag("Project.NotFoundError", missingProject),
    // A project whose folder is not trusted is refused with the folder to trust, not as an unavailable directory
    // (FU-M4-232).
    Effect.catchTag("Worktree.UntrustedError", (error) => Effect.fail(untrustedFolder(error))),
    Effect.mapError((error) =>
      error instanceof ProjectNotFoundError || error instanceof UntrustedFolderError
        ? error
        : new WorktreeError({
            name: "WorktreeError",
            data: {
              message: message(error),
              forceRequired:
                error instanceof Git.WorktreeError || error instanceof Worktree.OperationError
                  ? error.forceRequired
                  : undefined,
            },
          }),
    ),
  )
}

function missingProject(error: Project.NotFoundError) {
  return Effect.fail(
    new ProjectNotFoundError({ projectID: error.projectID, message: `Project not found: ${error.projectID}` }),
  )
}

function message(error: Exclude<Worktree.Error, Project.NotFoundError>) {
  if (error instanceof Worktree.SourceDirectoryNotFoundError)
    return error.directory
      ? `Worktree source not found: ${error.directory}`
      : `Worktree source not found for project: ${error.projectID}`
  if (error instanceof Worktree.DestinationExistsError) return `Worktree destination already exists: ${error.directory}`
  if (error instanceof Worktree.DirectoryUnavailableError) return `Worktree directory unavailable: ${error.directory}`
  if (error instanceof Worktree.InvalidDirectoryError) return `Invalid worktree directory: ${error.directory}`
  if (error instanceof Worktree.StrategyUnavailableError) return `Worktree strategy unavailable: ${error.strategy}`
  return error.message
}
