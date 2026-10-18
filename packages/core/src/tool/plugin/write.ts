/**
 * Model-facing file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as WriteTool from "./write.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { Effect, Schema } from "effect"
import { Bom } from "@orbit/util/bom"
import { Environment } from "../../environment/index.js"
import { FileMutation } from "../../file-mutation.js"
import { FileLedger } from "../../file-ledger.js"
import { Formatter } from "../../formatter.js"
import { FileAccess } from "../../file-access.js"
import { Location } from "../../location.js"
import { Permission } from "../../permission.js"
import { fileDiff } from "./file-diff.js"

export const name = "Write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  file_path: Schema.String.annotate({
    description: "Path of the file to create or replace",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelContent = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred write UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.

export const Plugin = {
  id: "orbit.tool.write",
  effect: Effect.fn("WriteTool.Plugin")(function* (ctx: Context) {
    const access = yield* FileAccess.Service
    const fileMutation = yield* FileMutation.Service
    const ledger = yield* FileLedger.Service
    const environment = yield* Environment.Service
    const formatter = yield* Formatter.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false, permission: "Edit" },
          traits: { readOnly: false, concurrencySafe: false },
          description:
            "Creates a file, or replaces all of the content of an existing one. Missing parent folders are created. A partial change belongs to Edit.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.messageID,
                id: context.id,
              }
              const target = yield* access.resolve({ path: input.file_path, kind: "file" })
              // Before anything is asked or done, so a client names the place the tool acts on even when no rule asks.
              yield* context.progress({ places: [target.place] })
              yield* access.authorizeExternal([target], context)
              // Locked only now: the lock key resolves the path on disk, which FileAccess must have checked first.
              return yield* Effect.gen(function* () {
                yield* ledger.assertRead(context.sessionID, target.absolute, input.file_path)
                const current = yield* FileMutation.readSnapshot(environment.files, target.absolute).pipe(
                  Effect.catchTag("Environment.NotFound", () => Effect.undefined),
                )
                // A new file has nothing to be stale against; for an existing one the same read serves as the current state.
                yield* ledger.assertFresh(context.sessionID, target.absolute, input.file_path, current)
                const next = Bom.split(input.content)
                const preview = fileDiff(
                  FileAccess.shownName(target),
                  current?.text ?? "",
                  next.text,
                  current ? "modified" : "added",
                )
                yield* permission.assert({
                  action: "Edit",
                  resources: [target.resource],
                  save: ["*"],
                  ...FileAccess.leadsOf([target]),
                  // `paths` and each file's `place` are where the write lands as resolved here, absolute, for a client to show.
                  metadata: { paths: [target.place], files: [{ ...preview, place: target.place }] },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                yield* FileMutation.assertUnchanged(environment.files, target.absolute, input.file_path, current)
                const result = yield* fileMutation.writeTextPreservingBom({ target, content: input.content })
                const written = yield* FileMutation.readSnapshot(environment.files, target.absolute)
                const final = (yield* formatter.file(target.absolute))
                  ? yield* FileMutation.syncTextBom(environment.files, target.absolute, written.bom).pipe(
                      Effect.andThen(FileMutation.readSnapshot(environment.files, target.absolute)),
                    )
                  : written
                yield* ledger.recordWrite(context.sessionID, target.absolute, final)
                return result
              }).pipe(fileMutation.withLock([target.absolute]))
            }).pipe(
              Effect.map((output) => ({ output, content: toModelContent(output) })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to write ${input.file_path}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
