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
/** Most characters one match record (a multiline match) keeps; later lines are summarized. */
export const MAX_RECORD_CHARS = 20_000
/** Version-control folders that no search or listing reaches into. */
export const VCS_DIRECTORIES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const
// A bare name excludes the folder and any file of that name (a worktree's `.git` pointer), at any depth.
const vcsGlobs = VCS_DIRECTORIES.map((dir) => `--glob=!**/${dir}`)

// ripgrep gives {bytes} (base64) instead of {text} for anything that is not valid UTF-8.
const RawText = Schema.Union([Schema.Struct({ text: Schema.String }), Schema.Struct({ bytes: Schema.String })])

const RawMatch = Schema.Struct({
  type: Schema.Literals(["match", "context"]),
  data: Schema.Struct({
    path: RawText,
    lines: RawText,
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

type GrepRow = {
  readonly path: string
  readonly line_number: number
  readonly absolute_offset: number
  readonly text: string
  readonly submatches: readonly Span[]
}

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
  /** Hidden files are listed unless this is `false`. */
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

type Span = { readonly start: number; readonly end: number }

/**
 * ripgrep ignores `--max-columns` with `--json`, so long lines are cut here. `submatches` are in characters of `text`.
 * Every physical line of the record is measured on its own, so a multiline match of short lines comes back whole. The
 * line holding the first submatch gets a window that starts shortly before it; other long lines are cut from their
 * start. Submatches that start in a cut part are dropped, and one that runs into a cut ends there. A record past
 * MAX_RECORD_CHARS keeps its first lines and ends with a marker.
 */
export const clipLine = (text: string, submatches: readonly Span[]) => {
  const first = submatches[0]?.start ?? 0
  const isLowSurrogate = (line: string, index: number) => {
    const code = line.charCodeAt(index)
    return code >= 0xdc00 && code <= 0xdfff
  }
  // Pieces of the record that come through unchanged, with where they start in the output.
  const pieces: { from: number; to: number; at: number }[] = []
  let out = ""
  let position = 0
  let dropped = 0
  while (position < text.length) {
    if (out.length > MAX_RECORD_CHARS) {
      dropped = text.slice(position).split("\n").length - (text.endsWith("\n") ? 1 : 0)
      break
    }
    const newline = text.indexOf("\n", position)
    const lineEnd = newline < 0 ? text.length : newline + 1
    const separator = newline < 0 ? "" : newline > position && text[newline - 1] === "\r" ? "\r\n" : "\n"
    const line = text.slice(position, lineEnd - separator.length)
    if (line.length <= MAX_LINE_COLUMNS) {
      const last = pieces.at(-1)
      if (last && last.to === position && last.at + (last.to - last.from) === out.length) last.to = lineEnd
      else pieces.push({ from: position, to: lineEnd, at: out.length })
      out += line + separator
      position = lineEnd
      continue
    }
    const lead = first >= position && first < lineEnd ? Math.max(0, first - position - LINE_LEAD_COLUMNS) : 0
    // Never start or end inside a surrogate pair.
    const start = lead > 0 && isLowSurrogate(line, lead) ? lead - 1 : lead
    const limit = Math.min(line.length, start + MAX_LINE_COLUMNS)
    const end = limit < line.length && isLowSurrogate(line, limit) ? limit - 1 : limit
    out += start > 0 ? "…" : ""
    const last = pieces.at(-1)
    // A line cut only at its end continues the piece before it.
    if (start === 0 && last && last.to === position && last.at + (last.to - last.from) === out.length) last.to = position + end
    else pieces.push({ from: position + start, to: position + end, at: out.length })
    out += `${line.slice(start, end)}${end < line.length ? "…" : ""} [line truncated: ${line.length} chars]${separator}`
    position = lineEnd
  }
  if (dropped > 0) out += `${out.endsWith("\n") ? "" : "\n"}[match continues for ${dropped} more lines]\n`
  return {
    text: out,
    submatches: submatches.flatMap((submatch) => {
      const piece = pieces.find((candidate) => submatch.start >= candidate.from && submatch.start <= candidate.to)
      if (!piece) return []
      const start = piece.at + submatch.start - piece.from
      const end = piece.at + Math.min(submatch.end, piece.to) - piece.from
      return [{ text: out.slice(start, end), start, end }]
    }),
  }
}

/** Converts ripgrep's UTF-8 byte offsets (into the UTF-8 form of `text`) to character offsets. */
const toCharacters = (text: string, submatches: readonly Span[]) => {
  if (submatches.length === 0) return []
  if (Buffer.byteLength(text) === text.length) return submatches
  const wanted = [...new Set(submatches.flatMap((submatch) => [submatch.start, submatch.end]))].sort((x, y) => x - y)
  const characters = new Map<number, number>()
  let byte = 0
  let character = 0
  let next = 0
  for (const point of text) {
    while (next < wanted.length && wanted[next]! <= byte) characters.set(wanted[next++]!, character)
    if (next >= wanted.length) break
    byte += Buffer.byteLength(point)
    character += point.length
  }
  while (next < wanted.length) characters.set(wanted[next++]!, character)
  return submatches.map((submatch) => ({ start: characters.get(submatch.start)!, end: characters.get(submatch.end)! }))
}

/**
 * Text of a ripgrep field. Bytes that are not valid UTF-8 become U+FFFD. The submatch offsets count the raw bytes (a
 * U+FFFD is 3 bytes for a bad byte of 1), so they are converted by decoding the segments between them.
 */
const decodeText = (field: typeof RawText.Type, submatches: readonly Span[] = []) => {
  if ("text" in field) return { text: field.text, submatches: toCharacters(field.text, submatches) }
  const raw = Buffer.from(field.bytes, "base64")
  const bounds = [...new Set([0, raw.length, ...submatches.flatMap((x) => [x.start, x.end])])]
    .filter((offset) => offset <= raw.length)
    .sort((x, y) => x - y)
  const decoder = new TextDecoder()
  const characters = new Map<number, number>()
  const text = bounds.reduce((joined, offset, index) => {
    characters.set(offset, joined.length)
    return index === bounds.length - 1 ? joined : joined + decoder.decode(raw.subarray(offset, bounds[index + 1]))
  }, "")
  return {
    text,
    submatches: submatches.map((x) => ({
      start: characters.get(Math.min(x.start, raw.length))!,
      end: characters.get(Math.min(x.end, raw.length))!,
    })),
  }
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
            // Oldest first, as a listing by modification time reads. Hidden files and files that .gitignore names are
            // listed: a search for a file by name is not a search of what a build leaves out.
            "--sort=modified",
            ...(input.hidden === false ? [] : ["--hidden"]),
            "--no-ignore",
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            // Positive globs override rg's hidden-file filter; exclude before applying the result limit.
            ...(input.hidden === false ? ["--glob=!**/.*"] : []),
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
        run<GrepRow>({
          ...input,
          // Context rows count toward the row limit too, so leave room for them around every match.
          limit: input.limit * (1 + (input.before ?? 0) + (input.after ?? 0)),
          args: [
            ...searchArgs(input),
            "--json",
            // Without a sort ripgrep searches files in parallel and the order changes per call, so an offset would page a different order.
            "--sort=path",
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
                // One record that cannot be decoded costs only itself.
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => {
                    const lines = decodeText(match.data.lines, match.data.submatches.slice(0, MAX_SUBMATCHES))
                    return {
                      path: normalizePath(decodeText(match.data.path).text),
                      line_number: match.data.line_number,
                      absolute_offset: match.data.absolute_offset,
                      text: lines.text,
                      submatches: lines.submatches,
                    }
                  }),
                  Effect.catch((cause) =>
                    Effect.logWarning("Skipping a ripgrep record that could not be decoded", cause).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) =>
            result.map((match) =>
              Match.make({
                entry: Entry.make({
                  path: RelativePath.make(match.path),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                ...clipLine(match.text, match.submatches),
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
