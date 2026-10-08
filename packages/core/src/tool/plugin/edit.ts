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

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "File to edit",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to find and replace" }),
  newString: Schema.String.annotate({ description: "Text to replace oldString with (must differ from oldString)" }),
  replaceAll: Schema.optionalKey(Schema.Boolean).annotate({
    description:
      "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",
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
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
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

/** The edit that `input` asks for, planned against a file's text: where oldString is, and what replaces it. */
const plan = (input: typeof Input.Type, source: string) => {
  const ending = source.includes(crlf) ? crlf : "\n"
  const oldString = input.oldString.replaceAll(crlf, "\n").replaceAll("\n", ending)
  const newString = input.newString.replaceAll(crlf, "\n").replaceAll("\n", ending)
  const exact = findOccurrences(source, oldString)
  // These one-to-one mappings preserve offsets into the original source.
  const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(source), normalizeForMatch(oldString))
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(source, oldString)
  return { matches: exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing, newString }
}

/** Why an edit that needs no file cannot work, if it cannot. */
const refusal = (input: typeof Input.Type) => {
  if (input.oldString === input.newString)
    return new ToolFailure({
      message: "No changes to apply: oldString and newString are identical.",
      code: Tool.ErrorCode.EditNoChange,
    })
  if (input.oldString === "")
    return new ToolFailure({
      message: "oldString must not be empty. Use write to create or overwrite a file.",
      code: Tool.ErrorCode.EditEmptyOldString,
    })
}

/** Why an edit that matches `replacements` times cannot work, if it cannot. */
const mismatch = (input: typeof Input.Type, replacements: number) => {
  if (replacements === 0)
    return new ToolFailure({
      message: `Could not find oldString in ${input.path}. It must match exactly, including whitespace and indentation.`,
      code: Tool.ErrorCode.EditNoMatch,
    })
  if (replacements > 1 && input.replaceAll !== true)
    return new ToolFailure({
      message: `Found ${replacements} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`,
      code: Tool.ErrorCode.EditAmbiguous,
    })
}

const readOriginal = (files: Environment.Files, absolute: string, display: string) =>
  FileMutation.readText(files, absolute).pipe(
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
          options: { codemode: false, permission: "edit" },
          description:
            "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",
          input: Input,
          output: Output,
          // Refuses an edit that cannot work before `execute` asks anyone to approve it. A file outside the Location is
          // not looked at: nobody has approved reaching it yet, and `execute` asks first. This runs outside the file's
          // lock, so it can be out of date by the time `execute` runs; `execute` repeats every check.
          validate: (input, context) =>
            Effect.gen(function* () {
              const refused = refusal(input)
              if (refused) return yield* refused
              const target = yield* access.resolve({ path: input.path, kind: "file" })
              if (target.externalDirectory) return
              yield* ledger.assertFresh(context.sessionID, target.absolute, input.path)
              const original = yield* readOriginal(environment.files, target.absolute, input.path)
              const mismatched = mismatch(input, plan(input, original.text).matches.length)
              if (mismatched) return yield* mismatched
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

              const target = yield* access.resolve({ path: input.path, kind: "file" })
              yield* access.authorizeExternal([target], context)
              yield* ledger.assertFresh(context.sessionID, target.absolute, input.path)

              const original = yield* readOriginal(environment.files, target.absolute, input.path)
              const source = original.text
              const edit = plan(input, source)
              const replacements = edit.matches.length
              // The person is asked to approve an edit only once it is known to work, whichever file it is for.
              const mismatched = mismatch(input, replacements)
              if (mismatched) return yield* mismatched
              const replaced = (input.replaceAll === true ? edit.matches : edit.matches.slice(0, 1))
                .toReversed()
                .reduce(
                  (content, match) => `${content.slice(0, match.start)}${edit.newString}${content.slice(match.end)}`,
                  source,
                )
              yield* permission.assert({
                action: "edit",
                resources: [target.resource],
                save: ["*"],
                metadata: { files: [fileDiff(target.resource, source, replaced)] },
                sessionID: context.sessionID,
                agent: context.agent,
                source: permissionSource,
              })
              const replacementBom = replaced.startsWith("\uFEFF")
              const result = yield* fileMutation.write({
                target,
                content: Bom.join(replaced, original.bom || replacementBom),
              })
              const bom = original.bom || replacementBom
              const formatted = (yield* formatter.file(target.absolute))
                ? yield* FileMutation.syncTextBom(environment.files, target.absolute, bom)
                : (yield* FileMutation.readText(environment.files, target.absolute)).text
              yield* ledger.record(context.sessionID, target.absolute)
              return {
                files: [fileDiff(result.resource, source, formatted)],
                replacements,
              } satisfies Output
            }).pipe(
              fileMutation.withLock([FileAccess.resolvePath(location.directory, input.path)]),
              Effect.map((output) => ({
                output,
                content: `Edited ${output.files[0]?.file} (${output.replacements} replacement${output.replacements === 1 ? "" : "s"})`,
                metadata: { files: output.files },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to edit ${input.path}`, error }),
              ),
            )
          },
        }),
      )
      .pipe(Effect.orDie)
  }),
}
