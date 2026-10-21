import path from "node:path"
import { Shell } from "@orbit/core/shell"
import { Location } from "@orbit/core/location"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { ShellNotFoundError } from "@orbit/protocol/errors"
import { Api } from "../api"
import { response } from "../location"
import { requireTrusted, requireTrustedAt } from "./trust-error"

export const ShellHandler = HttpApiBuilder.group(Api, "server.shell", (handlers) =>
  Effect.gen(function* () {
    const folders = { projects: yield* Project.Service, trust: yield* WorkspaceTrust.Service }
    return handlers
      .handle(
        "shell.list",
        Effect.fn(function* () {
          const shell = yield* Shell.Service
          return yield* response(shell.list())
        }),
      )
      .handle(
        "shell.create",
        Effect.fn(function* (ctx) {
          yield* requireTrusted()
          const shell = yield* Shell.Service
          const location = yield* Location.Service
          const cwd = ctx.payload.cwd ? path.resolve(location.directory, ctx.payload.cwd) : location.directory
          // The command runs in the folder the caller picks, which can be another than the Location's, so that folder has
          // to be trusted too, and the command runs in the very folder that was checked (class 3).
          yield* requireTrustedAt(folders, AbsolutePath.make(cwd))
          return yield* response(shell.create({ ...ctx.payload, cwd }).pipe(Effect.orDie))
        }),
      )
      .handle(
        "shell.get",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          return yield* response(
            shell
              .get(ctx.params.id)
              .pipe(
                Effect.catchTag(
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        "shell.output",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          return yield* response(
            shell
              .output(ctx.params.id, { cursor: ctx.query.cursor, limit: ctx.query.limit })
              .pipe(
                Effect.catchTag(
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        "shell.kill",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          return yield* response(
            shell
              .kill(ctx.params.id)
              .pipe(
                Effect.catchTag(
                  "Shell.NotFoundError",
                  () =>
                    new ShellNotFoundError({ id: ctx.params.id, message: `Shell command not found: ${ctx.params.id}` }),
                ),
              ),
          )
        }),
      )
      .handle(
        "shell.remove",
        Effect.fn(function* (ctx) {
          const shell = yield* Shell.Service
          yield* shell.remove(ctx.params.id).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.void))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
