export * as GlobTool from "./glob.js"

import { ToolFailure } from "@orbit/ai"
import { Tool } from "../../tool.js"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Ripgrep } from "../../ripgrep.js"
import { RelativePath } from "../../schema.js"
import { Permission } from "../../permission.js"

export const name = "Glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "Directory to search. Defaults to the current working directory.",
  }),
  hidden: FileSystem.GlobInput.fields.hidden.annotate({
    description: "Include hidden files and directories (default: true).",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: `Maximum number of matching files to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

export const Output = Schema.Array(FileSystem.Entry)

// The most files read from ripgrep while looking for enough that a Read rule leaves in.
const MAX_FETCH = 5_000
const slash = (file: string) => file.replaceAll("\\", "/")
type EncodedOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelContent = (entries: EncodedOutput, truncated = false) => {
  const lines = entries.length === 0 ? ["No files found"] : entries.map((item) => item.path)
  if (truncated)
    lines.push(
      "",
      `(The list stops at ${entries.length} results. Search a narrower folder or use a tighter pattern to see the rest.)`,
    )
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "orbit.tool.glob",
  effect: Effect.fn("GlobTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false },
          traits: { readOnly: true, concurrencySafe: true, interruptBehavior: "cancel" },
          description:
            'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx"). Files that .gitignore names are listed too.',
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const searchPath = input.path === "undefined" || input.path === "null" ? undefined : input.path
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              // A listing of a folder is a Read of it, so the person's Read rules for that folder decide it as they decide
              // a Read of the folder. The pattern is asked about below.
              const target = yield* access.authorizeRead(searchPath ?? ".", context, { kind: "directory" })
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: searchPath ?? ".",
                  // The searched folder as resolved here, so a client shows it rather than the input's spelling, and the
                  // real folder when a link in an untrusted project leads there.
                  path: target.place,
                  hidden: input.hidden,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const type = yield* Environment.typeFollowing(environment.files, target.absolute).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `Search path does not exist: ${searchPath ?? "."}` })),
                ),
              )
              if (type !== "directory")
                return yield* Effect.fail(
                  new ToolFailure({ message: `Search path is not a directory: ${searchPath ?? "."}` }),
                )
              const root = target.absolute
              const limit = input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT
              // A file that the person's Read rules deny is left out of the list, decided without asking anybody, so the
              // list never names what a Read of it would be refused. Files left out do not count against the limit.
              const readable = (entries: readonly FileSystem.Entry[]) =>
                Effect.forEach(
                  entries,
                  (entry) =>
                    permission
                      .denied({
                        action: "Read",
                        resources: [slash(path.relative(location.directory, path.resolve(root, entry.path)))],
                        save: ["*"],
                        metadata: {},
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source,
                      })
                      .pipe(Effect.map((denied) => (denied ? [] : [entry]))),
                  { concurrency: 16 },
                ).pipe(Effect.map((rows) => rows.flat()))
              const list = (fetch: number): Effect.Effect<readonly FileSystem.Entry[], unknown> =>
                ripgrep.glob({ cwd: root, pattern: input.pattern, hidden: input.hidden, limit: fetch }).pipe(
                  Effect.flatMap((found) =>
                    readable(found).pipe(
                      Effect.flatMap((kept) =>
                        kept.length > limit || found.length < fetch || fetch >= MAX_FETCH
                          ? Effect.succeed(kept)
                          : list(fetch * 2),
                      ),
                    ),
                  ),
                )
              const entries = yield* list(limit + 1)
                .pipe(
                  Effect.timeoutOrElse({
                    duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new ToolFailure({
                          message: `The search ran out of time after ${FileSystem.DEFAULT_SEARCH_TIMEOUT_MS / 1_000} seconds. Search a narrower folder or use a tighter pattern.`,
                        }),
                      ),
                  }),
                  Effect.map((result) =>
                    result.map((entry) =>
                      FileSystem.Entry.make({
                        ...entry,
                        path: RelativePath.make(path.relative(location.directory, path.resolve(root, entry.path))),
                      }),
                    ),
                  ),
                )
              return { entries: entries.slice(0, limit), truncated: entries.length > limit }
            }).pipe(
              Effect.map((result) => ({
                output: result.entries,
                content: toModelContent(
                  result.entries.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
                  result.truncated,
                ),
                metadata: { count: result.entries.length, truncated: result.truncated },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof FileAccess.DeviceError
                    ? new ToolFailure({ message: error.message, code: Tool.ErrorCode.FileDevice })
                    : new ToolFailure({ message: `Unable to find files matching ${input.pattern}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
