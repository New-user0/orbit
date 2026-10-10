export * as Ripgrep from "./ripgrep.js"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@orbit/schema/filesystem"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { collectStream, waitForAbort } from "@orbit/util/process"
import { Environment } from "./environment/index.js"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"
import { RipgrepBinary } from "./ripgrep/binary.js"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_SUBMATCHES = 100
/** Longest line text returned for a row; longer lines are cut to a window around the first match. */
export const MAX_LINE_COLUMNS = 500
const LINE_LEAD_COLUMNS = 100
/** Version-control folders that no search or listing reaches into. */
export const VCS_DIRECTORIES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const
const vcsGlobs = VCS_DIRECTORIES.map((dir) => `--glob=!**/${dir}/**`)

const RawMatch = Schema.Struct({
  type: Schema.Literals(["match", "context"]),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedError<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedError<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly exclude?: readonly string[]
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly literal?: boolean
  readonly caseSensitive?: boolean
  /** ripgrep file type, for example `ts` or `py`. */
  readonly type?: string
  /** Let patterns span lines. */
  readonly multiline?: boolean
  /** Lines of context before and after each match; context rows come back with no submatches. */
  readonly before?: number
  readonly after?: number
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface FileCount {
  readonly path: RelativePath
  readonly count: number
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
  /** Paths of files with at least one match, most recently modified first. */
  readonly files: (input: GrepInput) => Effect.Effect<readonly RelativePath[], Error | InvalidPatternError>
  /** Match counts per file. */
  readonly count: (input: GrepInput) => Effect.Effect<readonly FileCount[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Ripgrep") {}

/**
 * ripgrep ignores `--max-columns` with `--json`, so long lines are cut here. The window starts shortly before the first
 * submatch. ripgrep reports submatch offsets in UTF-8 bytes; they are converted to characters of the returned text, and
 * those outside the window are dropped.
 */
export const clipLine = (
  text: string,
  submatches: readonly { readonly match: { readonly text: string }; readonly start: number; readonly end: number }[],
) => {
  const converted = toCharacters(text, submatches)
  const newline = /\r?\n$/u.exec(text)?.[0] ?? ""
  const body = text.slice(0, text.length - newline.length)
  if (body.length <= MAX_LINE_COLUMNS) return { text, submatches: converted }
  const isLowSurrogate = (index: number) => {
    const code = body.charCodeAt(index)
    return code >= 0xdc00 && code <= 0xdfff
  }
  const first = Math.max(0, (converted[0]?.start ?? 0) - LINE_LEAD_COLUMNS)
  // Never start or end inside a surrogate pair.
  const start = first > 0 && isLowSurrogate(first) ? first - 1 : first
  const limit = Math.min(body.length, start + MAX_LINE_COLUMNS)
  const end = limit < body.length && isLowSurrogate(limit) ? limit - 1 : limit
  const lead = start > 0 ? "…" : ""
  // A match that starts in the window stays, cut at the window end; the first one always starts in it.
  const kept = converted.filter((submatch, index) => index === 0 || (submatch.start >= start && submatch.start < end))
  return {
    text: `${lead}${body.slice(start, end)}${end < body.length ? "…" : ""} [line truncated: ${body.length} chars]${newline}`,
    submatches: kept.map((submatch) => {
      const last = Math.min(submatch.end, end)
      return {
        text: body.slice(submatch.start, last),
        start: submatch.start - start + lead.length,
        end: last - start + lead.length,
      }
    }),
  }
}

/** Converts ripgrep's UTF-8 byte offsets to character offsets of `text` in one forward pass. */
const toCharacters = (
  text: string,
  submatches: readonly { readonly match: { readonly text: string }; readonly start: number; readonly end: number }[],
) => {
  if (submatches.length === 0) return []
  const plain = Buffer.byteLength(text) === text.length
  const wanted = plain
    ? []
    : [...new Set(submatches.flatMap((submatch) => [submatch.start, submatch.end]))].sort((x, y) => x - y)
  const characters = new Map<number, number>()
  let byte = 0
  let character = 0
  let next = 0
  for (const point of plain ? [] : text) {
    while (next < wanted.length && wanted[next]! <= byte) characters.set(wanted[next++]!, character)
    if (next >= wanted.length) break
    byte += Buffer.byteLength(point)
    character += point.length
  }
  while (next < wanted.length) characters.set(wanted[next++]!, character)
  const convert = (offset: number) => (plain ? offset : characters.get(offset)!)
  return submatches.map((submatch) => ({
    text: submatch.match.text,
    start: convert(submatch.start),
    end: convert(submatch.end),
  }))
}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const normalizePath = (value: string) =>
  value
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/")

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          // Hosted environments will resolve rg through their driver image; the spawner is the execution seam.
          const handle = yield* environment.spawner.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
          )
          const truncated = rows.length > input.limit
          if (truncated) return rows.slice(0, input.limit)

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return code === 1 ? [] : rows
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    const searchArgs = (input: GrepInput) => [
      "--no-config",
      "--hidden",
      "--no-messages",
      ...(input.literal ? ["--fixed-strings"] : []),
      ...(input.caseSensitive === false ? ["--ignore-case"] : []),
      ...(input.multiline ? ["--multiline", "--multiline-dotall"] : []),
      ...(input.type ? [`--type=${input.type}`] : []),
      ...(input.include ? [`--glob=${input.include}`] : []),
      ...vcsGlobs,
    ]

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            // Newest first, so a limited listing keeps the files most likely to matter.
            "--sortr=modified",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            // Positive globs override rg's hidden-file filter; exclude before applying the result limit.
            ...(input.hidden ? [] : ["--glob=!**/.*"]),
            ...vcsGlobs,
            ".",
          ],
          parse: (line) => Effect.succeed(normalizePath(line)),
        }).pipe(
          Effect.map((result) =>
            result.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            ...(input.exclude ?? []).map((pattern) => `--glob=!${pattern}`),
            ...vcsGlobs,
            ".",
          ],
          parse: (line) => {
            const relative = normalizePath(line)
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause)))),
      grep: (input) =>
        run<RawMatchData>({
          ...input,
          // Context rows count toward the row limit too, so leave room for them around every match.
          limit: input.limit * (1 + (input.before ?? 0) + (input.after ?? 0)),
          args: [
            ...searchArgs(input),
            "--json",
            ...(input.before ? [`--before-context=${input.before}`] : []),
            ...(input.after ? [`--after-context=${input.after}`] : []),
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            decodeJsonRecord(line).pipe(
              Effect.mapError((cause) => failure("Invalid ripgrep JSON output", cause)),
              Effect.flatMap((json) => {
                if (
                  !json ||
                  typeof json !== "object" ||
                  !("type" in json) ||
                  (json.type !== "match" && json.type !== "context")
                )
                  return Effect.undefined
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: normalizePath(match.data.path.text) },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.map((match) =>
              Match.make({
                entry: Entry.make({
                  path: RelativePath.make(match.path.text),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                ...clipLine(match.lines.text, match.submatches),
              }),
            ),
          ),
        ),
      files: (input) =>
        run<RelativePath>({
          ...input,
          args: [
            ...searchArgs(input),
            "--files-with-matches",
            "--sortr=modified",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) => Effect.succeed(RelativePath.make(normalizePath(line))),
        }),
      count: (input) =>
        run<FileCount>({
          ...input,
          // Sorted so that paging with an offset sees the same order on every call.
          args: [
            ...searchArgs(input),
            "--count-matches",
            "--with-filename",
            "--sort=path",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          // Paths may contain colons; the count is always after the last one.
          parse: (line) => {
            const split = line.lastIndexOf(":")
            const count = Number(line.slice(split + 1))
            if (split < 0 || !Number.isInteger(count)) return Effect.undefined
            return Effect.succeed({ path: RelativePath.make(normalizePath(line.slice(0, split))), count })
          },
        }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node, RipgrepBinary.node] })
