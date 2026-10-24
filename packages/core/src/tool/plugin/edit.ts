/**
 * Model-facing exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 *
 * An edit that cannot work fails before anyone is asked to approve it.
 * `validate` refuses it when the file is inside the Location, and `execute`
 * refuses it again, under the file's lock, before it asks for the edit
 * permission. A file outside the Location is first put to the
 * external_directory approval, and nothing reads it before then.
 */
export * as EditTool from "./edit.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { FileDiff } from "@orbit/schema/file-diff"
import { Tool } from "@orbit/schema/tool"
import { Bom } from "@orbit/util/bom"
import { Effect, Schema } from "effect"
import { Environment } from "../../environment/index.js"
import { FileMutation } from "../../file-mutation.js"
import { FileLedger } from "../../file-ledger.js"
import { Formatter } from "../../formatter.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { fileDiff } from "./file-diff.js"

export const name = "Edit"

export const Input = Schema.Struct({
  file_path: Schema.String.annotate({
    description: "File to edit",
  }),
  old_string: Schema.String.annotate({ description: "Exact text to find and replace" }),
  new_string: Schema.String.annotate({ description: "Text to replace old_string with (must differ from old_string)" }),
  replace_all: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Whether to replace every occurrence of old_string. When false, old_string must match exactly once. Defaults to false.",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const crlf = "\r\n"

interface Match {
  readonly start: number
  readonly end: number
}

const normalizeForMatch = (value: string) =>
  value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")

const findOccurrences = (content: string, search: string) => {
  const result: Match[] = []
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length })
    offset += search.length
  }
  return result
}

const findLineOccurrences = (content: string, search: string) => {
  const trailingNewline = search.endsWith("\n")
  const expected = search.split("\n")
  if (trailingNewline) expected.pop()
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex].trimEnd()),
      )
    )
      return []
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) return result
    result.push(candidate)
    return result
  }, [])
}

/** The edit that `input` asks for, planned against a file's text: where old_string is, and what replaces it. */
const plan = (input: typeof Input.Type, source: string) => {
  const ending = source.includes(crlf) ? crlf : "\n"
  const oldText = input.old_string.replaceAll(crlf, "\n").replaceAll("\n", ending)
  const newText = input.new_string.replaceAll(crlf, "\n").replaceAll("\n", ending)
  const exact = findOccurrences(source, oldText)
  // These one-to-one mappings preserve offsets into the original source.
  const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(source), normalizeForMatch(oldText))
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(source, oldText)
  const matches = exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing
  const selected = input.replace_all === true ? matches : matches.slice(0, 1)
  // A deletion that leaves a whole line empty takes the line break with it. A mid-line deletion, an old_string that
  // already ends or starts with a line break, and a match whose widened range would touch another match are left alone.
  const wholeLines = input.new_string === "" && !input.old_string.endsWith("\n") && !/^\r?\n/.test(input.old_string)
  const edits = selected.map((match) => {
    // Restyle only when the file's quotes differ from the ones old_string spelled. A match that differs in whitespace,
    // dashes or spaces alone leaves the model's own quote characters as they are.
    const slice = source.slice(match.start, match.end)
    const text = quotesOf(slice) === quotesOf(oldText) ? newText : restyleQuotes(slice, newText)
    const range = wholeLines ? wholeLine(source, match) : undefined
    const widened =
      range && !selected.some((other) => other !== match && other.end > range.start && other.start < range.end)
    return { ...(widened ? range : match), text }
  })
  return { matches, edits }
}

/** The line `match` sits on, with its line break, when nothing but whitespace is on that line outside the match. */
const wholeLine = (source: string, match: Match) => {
  const start = match.start === 0 ? 0 : source.lastIndexOf("\n", match.start - 1) + 1
  if (!/^[^\S\n]*$/.test(source.slice(start, match.start))) return
  const tail = /^[^\S\n]*(\n|$)/.exec(source.slice(match.end))
  if (!tail) return
  return { start, end: match.end + tail[0].length }
}

const opening = new Set([" ", "\t", "\n", "\r", "(", "[", "{", "—", "–"])

/**
 * Writes `text` in the quote style of the file text it replaces. A quote kind is restyled only when `slice` holds
 * that kind in curly form; detection and output cover U+2018, U+2019, U+201C and U+201D only. A straight quote
 * opens at the start of `text`, after a space, tab or line break, after `(`, `[` or `{`, or after an en or em dash, and closes anywhere else.
 */
const quotesOf = (value: string) => value.replace(/[^"'‘’“”„‟‚‛]/g, "")

const restyleQuotes = (slice: string, text: string) => {
  const restyle = (value: string, straight: string, left: string, right: string) =>
    // Index the code-point array being mapped: a string index drifts after any astral character.
    Array.from(value)
      .map((char, index, chars) =>
        char !== straight ? char : index === 0 || opening.has(chars[index - 1]) ? left : right,
      )
      .join("")
  const doubled = /[“”]/.test(slice) ? restyle(text, '"', "“", "”") : text
  return /[‘’]/.test(slice) ? restyle(doubled, "'", "‘", "’") : doubled
}

/** Why an edit that needs no file cannot work, if it cannot. */
const refusal = (input: typeof Input.Type) => {
  if (input.old_string === input.new_string)
    return new ToolFailure({
      message: "The edit would change nothing, because new_string equals old_string.",
      code: Tool.ErrorCode.EditNoChange,
    })
  if (input.old_string === "")
    return new ToolFailure({
      message: "old_string must not be empty. Use Write to create or overwrite a file.",
      code: Tool.ErrorCode.EditEmptyOldString,
    })
}

/** Why an edit that matches `replacements` times cannot work, if it cannot. */
const mismatch = (input: typeof Input.Type, replacements: number) => {
  if (replacements === 0)
    return new ToolFailure({
      message: `Could not find old_string in ${input.file_path}. It must match exactly, including whitespace and indentation.`,
      code: Tool.ErrorCode.EditNoMatch,
    })
  if (replacements > 1 && input.replace_all !== true)
    return new ToolFailure({
      message: `Found ${replacements} matches for old_string, but expected exactly one. Lengthen old_string until it matches one place, or set replace_all to true to change all of them.`,
      code: Tool.ErrorCode.EditAmbiguous,
    })
}

const readOriginal = (files: Environment.Files, absolute: string, display: string) =>
  FileMutation.readSnapshot(files, absolute).pipe(
    Effect.catchTag("Environment.NotFound", () =>
      Effect.fail(new ToolFailure({ message: `File not found: ${display}`, code: Tool.ErrorCode.FileNotFound })),
    ),
    // Any other kind of file is left to the caller, which reports a failure it has no code for.
    Effect.catchTag("Environment.WrongKind", (error) =>
      Effect.fail(
        error.actual === "directory"
          ? new ToolFailure({
              message: `Path is a directory, not a file: ${display}`,
              code: Tool.ErrorCode.FileIsDirectory,
            })
          : error,
      ),
    ),
  )

/** Deferred edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.

export const Plugin = {
  id: "orbit.tool.edit",
  effect: Effect.fn("EditTool.Plugin")(function* (ctx: Context) {
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
            "Replaces exact text in a file. old_string is copied from Read output with its indentation as shown and without the `N: ` line-number prefix, which belongs to neither old_string nor new_string. The edit fails when old_string is absent, and also when it matches several places unless replace_all is true: in that case lengthen old_string until it matches one place, or set replace_all to change every occurrence. An empty new_string deletes the matched lines together with their line break, so no blank line remains.",
          input: Input,
          output: Output,
          // Refuses an edit that cannot work before `execute` asks anyone to approve it. A file outside the Location is
          // not looked at: nobody has approved reaching it yet, and `execute` asks first. The file is read under the
          // file's lock, so an earlier edit of the same file that is still formatting or recording does not make this
          // one look stale. `execute` still repeats every check, because the file can change between the two.
          validate: (input, context) =>
            Effect.gen(function* () {
              const refused = refusal(input)
              if (refused) return yield* refused
              const target = yield* access.resolve({ path: input.file_path, kind: "file" })
              // Only the replacement is new text: an edit that takes a credential out of team memory is not refused.
              yield* access.refuseTeamSecrets([target], input.new_string)
              if (target.externalDirectory) return
              yield* Effect.gen(function* () {
                // An unread file is refused before any of it is loaded; the snapshot then tells a touched file from an edited one.
                yield* ledger.assertRead(context.sessionID, target.absolute, input.file_path)
                const original = yield* readOriginal(environment.files, target.absolute, input.file_path).pipe(
                  Effect.tap((snapshot) =>
                    ledger.assertFresh(context.sessionID, target.absolute, input.file_path, snapshot),
                  ),
                )
                const mismatched = mismatch(input, plan(input, original.text).matches.length)
                if (mismatched) return yield* mismatched
              }).pipe(fileMutation.withLock([FileAccess.resolvePath(location.directory, input.file_path)]))
            }).pipe(
              // Only a finding refuses the call, and every finding above carries a code. A path that cannot be
              // resolved or read for any other reason is left to `execute`, which reports it.
              Effect.catchIf(
                (error): error is Exclude<typeof error, ToolFailure> => !(error instanceof ToolFailure),
                () => Effect.void,
              ),
            ),
          execute: (input, context) => {
            return Effect.gen(function* () {
              const permissionSource = {
                type: "tool" as const,
                messageID: context.messageID,
                id: context.id,
              }
              const refused = refusal(input)
              if (refused) return yield* refused

              const target = yield* access.resolve({ path: input.file_path, kind: "file" })
              // Before anything is asked or done, so a client names the place the tool acts on even when no rule asks.
              yield* context.progress({ places: [target.place] })
              yield* access.refuseTeamSecrets([target], input.new_string)
              yield* access.authorizeExternal([target], context)
              yield* ledger.assertRead(context.sessionID, target.absolute, input.file_path)
              const original = yield* readOriginal(environment.files, target.absolute, input.file_path).pipe(
                Effect.tap((snapshot) =>
                  ledger.assertFresh(context.sessionID, target.absolute, input.file_path, snapshot),
                ),
              )
              const source = original.text
              const edit = plan(input, source)
              const replacements = edit.matches.length
              // The person is asked to approve an edit only once it is known to work, whichever file it is for.
              const mismatched = mismatch(input, replacements)
              if (mismatched) return yield* mismatched
              const replaced = edit.edits
                .toReversed()
                .reduce(
                  (content, match) => `${content.slice(0, match.start)}${match.text}${content.slice(match.end)}`,
                  source,
                )
              yield* permission.assert({
                action: "Edit",
                resources: [target.resource],
                save: ["*"],
                ...FileAccess.leadsOf([target]),
                // `paths` and each file's `place` are where the edit lands as resolved here, absolute, for a client to show.
                metadata: {
                  paths: [target.place],
                  files: [{ ...fileDiff(FileAccess.shownName(target), source, replaced), place: target.place }],
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: permissionSource,
              })
              const replacementBom = replaced.startsWith("\uFEFF")
              yield* FileMutation.assertUnchanged(environment.files, target.absolute, input.file_path, original)
              const bom = original.bom || replacementBom
              return yield* Effect.gen(function* () {
                const result = yield* fileMutation.write({ target, content: Bom.join(replaced, bom) })
                if (yield* formatter.file(target.absolute))
                  yield* FileMutation.syncTextBom(environment.files, target.absolute, bom)
                const final = yield* FileMutation.readSnapshot(environment.files, target.absolute)
                yield* ledger.recordWrite(context.sessionID, target.absolute, final)
                return {
                  files: [fileDiff(result.resource, source, final.text)],
                  replacements,
                } satisfies Output
              }).pipe(
                // From the write on, a failure still names the file, so that a code rewind puts back what it wrote.
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Unable to edit ${input.file_path}`,
                      error,
                      metadata: { files: [{ file: target.resource }] },
                    }),
                ),
              )
            }).pipe(
              fileMutation.withLock([FileAccess.resolvePath(location.directory, input.file_path)]),
              Effect.map((output) => ({
                output,
                content: `Edited ${output.files[0]?.file} (${output.replacements} replacement${output.replacements === 1 ? "" : "s"})`,
                metadata: { files: output.files },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to edit ${input.file_path}`, error }),
              ),
            )
          },
        }),
      )
      .pipe(Effect.orDie)
  }),
}
