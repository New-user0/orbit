import { Shell } from "@orbit/core/shell"
import { Location } from "@orbit/core/location"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { ShellNotFoundError } from "@orbit/protocol/errors"
import { Api } from "../api"
import { response } from "../location"
import { requireTrusted } from "./trust-error"

export const ShellHandler = HttpApiBuilder.group(Api, "server.shell", (handlers) =>
  Effect.gen(function* () {
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
          return yield* response(
            shell.create({ ...ctx.payload, cwd: ctx.payload.cwd || location.directory }).pipe(Effect.orDie),
          )
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
