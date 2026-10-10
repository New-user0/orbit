export * as GrepTool from "./grep.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { Ripgrep } from "../../ripgrep.js"
import { Token } from "../../util/token.js"
import { NonNegativeInt, RelativePath } from "../../schema.js"

export const name = "Grep"

/** A content page stops before its rendered text would pass this many estimated tokens. */
export const MAX_OUTPUT_TOKENS = 25_000

const ContextLines = NonNegativeInt.check(Schema.isLessThanOrEqualTo(20))

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern
    .check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
    .annotate({
      description: "Regular expression or literal text to match in file contents.",
    }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "File or directory to search. Defaults to the current working directory.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
  }),
  literal: FileSystem.GrepInput.fields.literal.annotate({
    description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
  }),
  caseSensitive: FileSystem.GrepInput.fields.caseSensitive.annotate({
    description: "Use case-sensitive matching (default: true).",
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum number of matching lines, files, or counts to return (default: ${FileSystem.DEFAULT_GREP_LIMIT})`,
  }),
  offset: Schema.optionalKey(NonNegativeInt).annotate({
    description: "Number of results to skip before returning `limit` results, for paging (default: 0).",
  }),
  outputMode: Schema.optionalKey(Schema.Literals(["content", "files_with_matches", "count"])).annotate({
    description:
      '"content" returns matching lines (default), "files_with_matches" returns only file paths, most recently modified first, and "count" returns the number of matches per file.',
  }),
  type: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_+-]+$/))).annotate({
    description:
      'ripgrep file type to search, for example "ts", "py", or "rust". More efficient than `include` for standard types.',
  }),
  multiline: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Let the pattern span lines, with `.` matching newlines (default: false).",
  }),
  context: Schema.optionalKey(ContextLines).annotate({
    description: 'Lines of context to show before and after each match. Only for "content" mode.',
  }),
  before: Schema.optionalKey(ContextLines).annotate({
    description: 'Lines of context to show before each match. Overrides `context`. Only for "content" mode.',
  }),
  after: Schema.optionalKey(ContextLines).annotate({
    description: 'Lines of context to show after each match. Overrides `context`. Only for "content" mode.',
  }),
})

const Matches = Schema.Array(FileSystem.Match)
export const Output = Schema.Union([
  Matches,
  Schema.Struct({ files: Schema.Array(RelativePath) }),
  Schema.Struct({ counts: Schema.Array(Schema.Struct({ path: RelativePath, count: NonNegativeInt })) }),
])
type EncodedOutput = typeof Matches.Encoded

const pageContent = (lines: string[], next: number | undefined) =>
  [
    ...lines,
    ...(next === undefined
      ? []
      : ["", `(Results are truncated. Use \`offset: ${next}\` to see more, or narrow the path or pattern.)`]),
  ].join("\n")

/**
 * Format raw search matches into concise model content. Context rows carry no submatches and print with a `-`
 * separator; a gap between rows of the same file prints as `--`.
 */
export const toModelContent = (matches: EncodedOutput, note?: string) => {
  const found = matches.filter((match) => match.submatches.length > 0).length
  const lines = found === 0 ? ["No matches found"] : [`Found ${found} matches`]
  let current = ""
  let previous = 0
  for (const match of matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    } else if (match.line > previous + 1 && matches.some((row) => row.submatches.length === 0)) lines.push("  --")
    previous = match.line
    lines.push(`  Line ${match.line}${match.submatches.length === 0 ? "-" : ":"} ${match.text.replace(/\r?\n$/, "")}`)
  }
  if (note) lines.push("", note)
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "orbit.tool.grep",
  effect: Effect.fn("GrepTool.Plugin")(function* (ctx: Context) {
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
          description: `Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with \`path\` or \`include\`. Returns matching file paths, line numbers, and line previews. A page holds up to ${FileSystem.DEFAULT_GREP_LIMIT} matches by default and stops earlier when its text would pass about ${MAX_OUTPUT_TOKENS.toLocaleString("en-US")} tokens; when results are truncated the note gives the \`offset\` that continues the search. Lines longer than ${Ripgrep.MAX_LINE_COLUMNS} characters are clipped around the first match.`,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              // A search reads what it searches, so the person's Read rules for that path decide it as they decide a
              // Read of it: a Read deny of `*.env` covers a search of `.env`. The pattern is asked about below.
              const target = yield* access.authorizeRead(input.path ?? ".", context)
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  // The searched place as resolved here, so a client shows it rather than the input's spelling, and the
                  // real place when a link in an untrusted project leads there.
                  path: target.place,
                  include: input.include,
                  literal: input.literal,
                  caseSensitive: input.caseSensitive,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const root = target.absolute
              const type = yield* Environment.typeFollowing(environment.files, root).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `Search path does not exist: ${input.path ?? "."}` })),
                ),
              )
              const cwd = type === "directory" ? root : path.dirname(root)
              const limit = input.limit ?? FileSystem.DEFAULT_GREP_LIMIT
              const offset = input.offset ?? 0
              const relative = (file: string) =>
                RelativePath.make(path.relative(location.directory, path.resolve(cwd, file)))
              const search = {
                cwd,
                pattern: input.pattern,
                file: type === "file" ? path.basename(root) : undefined,
                include: input.include,
                literal: input.literal,
                caseSensitive: input.caseSensitive,
                type: input.type,
                multiline: input.multiline,
                limit: offset + limit + 1,
              }
              const timeout = <A, E>(effect: Effect.Effect<A, E>) =>
                effect.pipe(
                  Effect.timeoutOrElse({
                    duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new ToolFailure({
                          message: `Search timed out after ${FileSystem.DEFAULT_SEARCH_TIMEOUT_MS / 1_000} seconds. Consider using a more specific path or pattern.`,
                        }),
                      ),
                  }),
                )
              if (input.outputMode === "files_with_matches") {
                const files = (yield* timeout(ripgrep.files(search))).map(relative)
                const page = files.slice(offset, offset + limit)
                const truncated = files.length > offset + limit
                return {
                  output: { files: page },
                  content: pageContent(
                    page.length === 0
                      ? ["No files found"]
                      : [`Found ${page.length} files`, ...page.map((file) => path.resolve(location.directory, file))],
                    truncated ? offset + limit : undefined,
                  ),
                  metadata: { matches: page.length, truncated },
                }
              }
              if (input.outputMode === "count") {
                const counts = (yield* timeout(ripgrep.count(search))).map((row) => ({
                  path: relative(row.path),
                  count: row.count,
                }))
                const page = counts.slice(offset, offset + limit)
                const truncated = counts.length > offset + limit
                const total = page.reduce((sum, row) => sum + row.count, 0)
                return {
                  output: { counts: page },
                  content: pageContent(
                    page.length === 0
                      ? ["No matches found"]
                      : [
                          `Found ${total} matches in ${page.length} files`,
                          ...page.map((row) => `${path.resolve(location.directory, row.path)}: ${row.count}`),
                        ],
                    truncated ? offset + limit : undefined,
                  ),
                  metadata: { matches: total, truncated },
                }
              }
              const rows = (yield* timeout(
                ripgrep.grep({
                  ...search,
                  before: input.before ?? input.context,
                  after: input.after ?? input.context,
                }),
              )).map((match) =>
                FileSystem.Match.make({
                  ...match,
                  entry: FileSystem.Entry.make({ ...match.entry, path: relative(match.entry.path) }),
                }),
              )
              // Page by matches, keeping each match's surrounding context rows with it.
              const ordinals = rows.reduce<number[]>(
                (all, row) => [...all, (all.at(-1) ?? -1) + (row.submatches.length > 0 ? 1 : 0)],
                [],
              )
              const matches = rows.filter((row, index) => {
                const ordinal = ordinals[index]!
                if (row.submatches.length > 0) return ordinal >= offset && ordinal < offset + limit
                // A context row belongs to the next match before it, or the previous one after it.
                return ordinal + 1 >= offset && ordinal < offset + limit
              })
              const total = (ordinals.at(-1) ?? -1) + 1
              const absolute = matches.map((match) => ({
                ...match,
                entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
              }))
              // Each match's group runs to the next match row, so it keeps its trailing context.
              const cuts = matches.flatMap((row, index) => (row.submatches.length > 0 ? [index] : [])).slice(1)
              cuts.push(matches.length)
              const note = (shown: number) =>
                `(Results are truncated: showing matches ${offset + 1}-${offset + shown}. Use \`offset: ${offset + shown}\` to see more, or narrow the path or pattern.)`
              const render = (count: number) => {
                const rendered = absolute.slice(0, cuts[count - 1] ?? 0)
                const more = count < cuts.length || total > offset + limit
                return toModelContent(rendered, more ? note(count) : undefined)
              }
              // The largest number of matches whose rendered text fits the page budget; always at least one, so
              // paging advances.
              const fits = (count: number) => Token.estimate(render(count)) <= MAX_OUTPUT_TOKENS
              const count = fits(cuts.length) ? cuts.length : largest(cuts.length, fits)
              const kept = absolute.slice(0, cuts[count - 1] ?? 0)
              const truncated = count < cuts.length || total > offset + limit
              const found = kept.filter((row) => row.submatches.length > 0).length
              return {
                output: matches.slice(0, kept.length),
                content: matches.length === 0 ? toModelContent([]) : render(count),
                metadata: { matches: found, truncated },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof FileAccess.DeviceError
                    ? new ToolFailure({ message: error.message })
                    : error instanceof Ripgrep.InvalidPatternError
                      ? new ToolFailure({ message: `Invalid regex pattern: ${error.message}` })
                      : new ToolFailure({ message: `Unable to grep for ${input.pattern}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

/** Binary search for the largest count in 1..max that fits, assuming fit is monotonic; 1 when nothing fits. */
const largest = (max: number, fits: (count: number) => boolean) => {
  let low = 1
  let high = max - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle - 1
  }
  return low
}
