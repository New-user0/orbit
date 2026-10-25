export * as PatchTool from "./patch.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { ToolFailure } from "@orbit/ai"
import { FileDiff } from "@orbit/schema/file-diff"
import { Effect, Result, Schema } from "effect"
import { Bom } from "@orbit/util/bom"
import { FSUtil } from "@orbit/util/fs-util"
import { statSync } from "fs"
import path from "path"
import { Environment } from "../../environment/index.js"
import { Formatter } from "../../formatter.js"
import { FileMutation } from "../../file-mutation.js"
import { FileLedger } from "../../file-ledger.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Patch } from "@orbit/util/patch"
import { Permission } from "../../permission.js"
import DESCRIPTION from "../patch.txt"
import { fileDiff } from "./file-diff.js"

export const name = "Patch"

export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description: "The full patch text describing add, update, and delete operations",
  }),
})

export const Applied = Schema.Struct({
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
})

export const Output = Schema.Struct({
  applied: Schema.Array(Applied),
  files: Schema.Array(FileDiff.Info),
})
export type Output = typeof Output.Type

export const toModelContent = (output: Output) =>
  [
    "Success. Updated the following files:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
  ].join("\n")

type Prepared =
  | (Extract<Patch.Hunk, { readonly type: "add" }> & {
      readonly target: FileAccess.Target
      readonly content: string
      readonly before: string
      readonly after: string
      readonly existed: boolean
    })
  | (Extract<Patch.Hunk, { readonly type: "delete" }> & {
      readonly target: FileAccess.Target
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      readonly target: FileAccess.Target
      readonly content: string
      readonly before: string
      readonly after: string
      readonly moveTarget?: FileAccess.Target
      /** The destination's text when a move replaces a file that already exists. */
      readonly replaced?: string
    })

export const Plugin = {
  id: "orbit.tool.patch",
  effect: Effect.fn("PatchTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const access = yield* FileAccess.Service
    const fileMutation = yield* FileMutation.Service
    const ledger = yield* FileLedger.Service
    const formatter = yield* Formatter.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false, permission: "Edit" },
          traits: {
            readOnly: false,
            concurrencySafe: false,
            // A patch that cannot be parsed is treated as destructive rather than guessed at.
            destructive: (input) => {
              const parsed = Patch.parse(input.patchText)
              return (
                Result.isFailure(parsed) ||
                // A move removes its source and replaces whatever is at its target.
                parsed.success.some(
                  (hunk) => hunk.type === "delete" || (hunk.type === "update" && hunk.movePath !== undefined),
                )
              )
            },
          },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (input, context) => {
            const applied: Array<typeof Applied.Type> = []
            const parsed = Patch.parse(input.patchText)
            // Each file is named here before the patch writes or removes it, and a failure carries the names in
            // `metadata.files`, so that a code rewind puts back what the patch changed before it failed.
            const touched: Array<{ file: string; from?: string }> = []
            const fail = (operation: string, error: unknown) => {
              const completed = applied.map((item) => item.resource).join(", ")
              return new ToolFailure({
                message: `${operation}: ${errorMessage(error)}${completed ? `. Completed before failure: ${completed}` : ""}`,
                metadata: { files: touched },
              })
            }
            return Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.messageID,
                id: context.id,
              }
              if (!input.patchText) return yield* new ToolFailure({ message: "patchText is required" })
              const hunks = yield* Effect.fromResult(parsed).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `patch verification failed: ${error.message}` })),
              )
              if (hunks.length === 0) {
                return yield* new ToolFailure({ message: "patch rejected: empty patch" })
              }
              // Every path is checked by FileAccess before the lock key resolves it on disk (a share would be opened).
              // Each hunk's paths are resolved once, for the lock and for the scan below.
              const named = yield* Effect.forEach(hunks, (hunk) =>
                Effect.forEach(
                  hunk.type === "update" && hunk.movePath ? [hunk.path, hunk.movePath] : [hunk.path],
                  (value) => access.resolve({ path: value, kind: "file" }),
                ),
              )
              const locked = named.flat()
              // A credential never reaches team memory (context-memory-11): what each hunk adds is scanned before anything
              // is read or asked, as Write's content and Edit's replacement are. A file moved into the folder is scanned
              // whole once its text is known, below. An update's context lines are already in the file, so a patch that
              // takes a key out beside another one passes, as an Edit that takes one out does.
              yield* Effect.forEach(
                hunks,
                (hunk, index) =>
                  hunk.type === "delete"
                    ? Effect.void
                    : access.refuseTeamSecrets(
                        named[index],
                        hunk.type === "add" ? hunk.contents : hunk.chunks.flatMap(added).join("\n"),
                      ),
                { discard: true },
              )
              return yield* Effect.gen(function* () {
                const prepared: Prepared[] = []
                const updates = new Map<string, string>()
                const places: string[] = []
                // Each path's state when it was first read, before anyone is asked: absent, or the snapshot. Rechecked after approval.
                const states = new Map<
                  string,
                  { absolute: string; display: string; snapshot: FileMutation.Snapshot | undefined }
                >()
                // Which spelling first named each file, so a second spelling of one file is refused before anyone is asked.
                const spellings = new Map<string, string>()
                const identify = (target: { readonly absolute: string }, display: string) =>
                  Effect.try({
                    try: () => fileIdentity(target.absolute),
                    catch: (error) =>
                      new ToolFailure({
                        message: `patch verification failed: Failed to resolve ${display}: ${errorMessage(error)}`,
                      }),
                  }).pipe(
                    Effect.tap((id) =>
                      spellings.has(id) && spellings.get(id) !== target.absolute
                        ? Effect.fail(
                            new ToolFailure({
                              message: `patch verification failed: ${display} and ${spellings.get(id)} are the same file`,
                            }),
                          )
                        : Effect.sync(() => spellings.set(id, target.absolute)),
                    ),
                  )
                const probe = (target: { readonly absolute: string }, display: string, id: string) =>
                  FileMutation.readSnapshot(environment.files, target.absolute).pipe(
                    Effect.catchTag("Environment.NotFound", () => Effect.undefined),
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message: `patch verification failed: Failed to read ${target.absolute}: ${errorMessage(error)}`,
                        }),
                    ),
                    Effect.tap((snapshot) =>
                      Effect.sync(() => {
                        if (!states.has(id)) states.set(id, { absolute: target.absolute, display, snapshot })
                      }),
                    ),
                  )
                const resolveTarget = Effect.fnUntraced(function* (value: string) {
                  const target = yield* access.resolve({ path: value, kind: "file" })
                  // Every file the patch reaches so far, a move's source and destination included, before anything is asked.
                  places.push(target.place)
                  yield* context.progress({ places: [...new Set(places)] })
                  if (!target.externalDirectory) return target
                  yield* access.authorizeExternal([target], context, {
                    filepath: target.place,
                    parentDir: target.externalDirectory.directory,
                  })
                  return target
                })
                for (const hunk of hunks) {
                  yield* Effect.gen(function* () {
                    const target = yield* resolveTarget(hunk.path)
                    const id = yield* identify(target, hunk.path)
                    if (hunk.type === "add") {
                      yield* ledger.assertRead(context.sessionID, target.absolute, hunk.path)
                      const existing = yield* probe(target, hunk.path, id)
                      yield* ledger.assertFresh(context.sessionID, target.absolute, hunk.path, existing)
                      const content =
                        hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`
                      prepared.push({
                        ...hunk,
                        target,
                        // Like Write, a replacing Add File keeps the BOM the file already has.
                        content: existing?.bom ? Bom.join(Bom.split(content).text, true) : content,
                        // A file that already exists is replaced, so its text is what the approval shows as removed.
                        before: existing?.text ?? "",
                        after: Bom.split(content).text,
                        existed: existing !== undefined,
                      })
                      return
                    }
                    // Refused before any content is loaded; the snapshot then tells a touched file from an edited one.
                    const previous = hunk.type === "update" ? updates.get(id) : undefined
                    yield* ledger.assertRead(context.sessionID, target.absolute, hunk.path)
                    const snapshot =
                      previous === undefined
                        ? yield* FileMutation.readSnapshot(environment.files, target.absolute).pipe(
                            Effect.mapError(
                              (error) =>
                                new ToolFailure({
                                  message:
                                    hunk.type === "delete"
                                      ? `patch verification failed: Failed to delete ${target.resource}: ${errorMessage(error)}`
                                      : `patch verification failed: Failed to read file to update ${target.absolute}: ${errorMessage(error)}`,
                                }),
                            ),
                          )
                        : undefined
                    if (snapshot) {
                      yield* ledger.assertFresh(context.sessionID, target.absolute, hunk.path, snapshot)
                      if (!states.has(id)) states.set(id, { absolute: target.absolute, display: hunk.path, snapshot })
                    }
                    if (hunk.type === "delete") {
                      prepared.push({ ...hunk, target, before: snapshot!.text, after: "" })
                      return
                    }
                    const original = previous ?? Bom.join(snapshot!.text, snapshot!.bom)
                    const before = Bom.split(original).text
                    const update = yield* Effect.try({
                      try: () => Patch.derive(hunk.path, hunk.chunks, original),
                      catch: (error) =>
                        new ToolFailure({ message: `patch verification failed: ${errorMessage(error)}` }),
                    })
                    const moveTarget = hunk.movePath ? yield* resolveTarget(hunk.movePath) : undefined
                    if (moveTarget) yield* access.refuseTeamSecrets([moveTarget], update.content)
                    const moveID = moveTarget && hunk.movePath ? yield* identify(moveTarget, hunk.movePath) : undefined
                    // Writing the destination and then removing the source would delete a file moved onto itself.
                    if (moveID !== undefined && moveID === id)
                      return yield* new ToolFailure({
                        message: `patch verification failed: ${hunk.movePath} is the file being moved (${hunk.path}); a move needs a different destination`,
                      })
                    // The destination follows the same sequence as an Add File target: read, probe, freshness.
                    const replaced =
                      moveTarget && hunk.movePath && moveID !== undefined
                        ? yield* ledger.assertRead(context.sessionID, moveTarget.absolute, hunk.movePath).pipe(
                            Effect.andThen(probe(moveTarget, hunk.movePath, moveID)),
                            Effect.tap((existing) =>
                              ledger.assertFresh(context.sessionID, moveTarget.absolute, hunk.movePath!, existing),
                            ),
                          )
                        : undefined
                    prepared.push({
                      ...hunk,
                      target,
                      content: Patch.joinBom(update.content, update.bom),
                      before,
                      after: update.content,
                      moveTarget,
                      replaced: replaced?.text,
                    })
                    if (!moveTarget) updates.set(id, Patch.joinBom(update.content, update.bom))
                  }).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure
                        ? error
                        : new ToolFailure({ message: `Unable to prepare patch at ${hunk.path}`, error }),
                    ),
                  )
                }

                const patchFiles = prepared.flatMap((change) => [patchFile(change), ...replacedFile(change)])
                const targets = prepared.flatMap((change) => [
                  change.target,
                  ...(change.type === "update" && change.moveTarget ? [change.moveTarget] : []),
                ])
                yield* permission.assert({
                  action: "Edit",
                  resources: [...new Set(targets.map((target) => target.resource))],
                  save: ["*"],
                  ...FileAccess.leadsOf(targets),
                  metadata: {
                    filepath: targets.map((target) => target.resource).join(", "),
                    // Every place the patch touches as resolved here, absolute: a move's source and its destination too.
                    paths: [...new Set(targets.map((target) => target.place))],
                    diff: patchFiles.map((file) => `${file.patch}\n`).join(""),
                    files: prepared.flatMap((change) => {
                      const [file, ...replaced] = [patchFile(change), ...replacedFile(change)]
                      return change.type === "update" && change.moveTarget
                        ? [
                            { ...file!, place: change.moveTarget.place, from: change.target.place },
                            ...replaced.map((item) => ({ ...item, place: change.moveTarget!.place })),
                          ]
                        : [{ ...file!, place: change.target.place }]
                    }),
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                // Every path before the first write, so a stale one leaves no partial patch.
                yield* Effect.forEach(
                  states.values(),
                  (state) =>
                    FileMutation.assertUnchanged(environment.files, state.absolute, state.display, state.snapshot),
                  { discard: true },
                )

                yield* Effect.forEach(
                  prepared,
                  (change) =>
                    Effect.gen(function* () {
                      if (change.type === "delete") {
                        touched.push({ file: change.target.resource })
                        yield* environment.files
                          .remove(change.target.absolute)
                          .pipe(Effect.mapError((error) => fail(`Failed to delete ${change.target.resource}`, error)))
                        applied.push({
                          type: change.type,
                          resource: change.target.resource,
                          target: change.target.absolute,
                        })
                        return
                      }
                      if (change.type === "update" && change.moveTarget) {
                        const moveTarget = change.moveTarget
                        touched.push({ file: moveTarget.resource, from: change.target.resource })
                        yield* environment.files
                          .write(moveTarget.absolute, new TextEncoder().encode(change.content))
                          .pipe(Effect.mapError((error) => fail(`Failed to write ${moveTarget.resource}`, error)))
                        yield* environment.files
                          .remove(change.target.absolute)
                          .pipe(
                            Effect.mapError((error) =>
                              fail(
                                `Wrote ${moveTarget.resource} but failed to remove ${change.target.resource}`,
                                error,
                              ),
                            ),
                          )
                        applied.push({
                          type: change.type,
                          resource: change.moveTarget.resource,
                          target: change.moveTarget.absolute,
                        })
                        return
                      }
                      touched.push({ file: change.target.resource })
                      yield* environment.files
                        .write(change.target.absolute, new TextEncoder().encode(change.content))
                        .pipe(Effect.mapError((error) => fail(`Failed to write ${change.target.resource}`, error)))
                      applied.push({
                        type: change.type,
                        resource: change.target.resource,
                        target: change.target.absolute,
                      })
                    }),
                  { discard: true },
                )
                const formatted = new Map<string, string>()
                // Where each file really is, as resolved for the approval, kept with the record of the write.
                const realPlaces = new Map<string, string>(
                  targets.map((target) => [target.absolute, FileAccess.realPlace(target)]),
                )
                yield* Effect.forEach(
                  [...new Set(applied.filter((item) => item.type !== "delete").map((item) => item.target))],
                  (target) =>
                    Effect.gen(function* () {
                      const written = yield* FileMutation.readSnapshot(environment.files, target).pipe(
                        Effect.mapError((error) => fail(`Failed to read ${target}`, error)),
                      )
                      const final = (yield* formatter.file(target))
                        ? yield* FileMutation.syncTextBom(environment.files, target, written.bom).pipe(
                            Effect.andThen(FileMutation.readSnapshot(environment.files, target)),
                            Effect.mapError((error) => fail(`Failed to sync ${target}`, error)),
                          )
                        : written
                      formatted.set(target, final.text)
                      yield* ledger.recordWrite(context.sessionID, target, { ...final, place: realPlaces.get(target) })
                    }),
                  { discard: true },
                )
                const files = prepared.flatMap((change) => {
                  if (change.type === "delete") return [patchFile(change)]
                  const target = change.type === "update" && change.moveTarget ? change.moveTarget : change.target
                  const after = formatted.get(target.absolute)
                  return [patchFile(change, after), ...replacedFile(change, after)]
                })
                return { applied, files }
              }).pipe(fileMutation.withLock(locked.map((target) => target.absolute)))
            }).pipe(
              Effect.map((output) => ({
                output,
                content: toModelContent(output),
                metadata: { files: output.files },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "Unable to apply patch", error }),
              ),
            )
          },
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.sync(() => {
        const usePatch =
          event.model.id.includes("gpt-") && !event.model.id.includes("oss") && !event.model.id.includes("gpt-4")
        if (usePatch) {
          delete event.tools.Edit
          delete event.tools.Write
          return
        }
        delete event.tools.Patch
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}

/**
 * One name per file. A file that exists is its device and inode, so two spellings (letter case on any case-insensitive
 * file system, links, hard links) are one file. A file that does not exist yet is its parent's real path plus its name,
 * folded where the platform ignores case.
 */
function fileIdentity(absolute: string) {
  const full = FSUtil.resolve(absolute)
  const stat = existing(full)
  if (stat && stat.ino !== 0n) return `${stat.dev}:${stat.ino}`
  const identity = path.join(FSUtil.resolve(path.dirname(full)), path.basename(full))
  return process.platform === "win32" || process.platform === "darwin" ? identity.toLowerCase() : identity
}

/** ENOENT and ENOTDIR mean the file is not there yet; any other error is a refusal. */
function existing(full: string) {
  try {
    return statSync(full, { bigint: true })
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return
    throw error
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Environment.NotFound) return "file does not exist"
  if (error instanceof Environment.WrongKind)
    return error.actual === "directory" ? "path is a directory" : `path is ${error.actual}`
  if (error instanceof Environment.Failed) return errorMessage(error.cause)
  return error instanceof Error ? error.message : String(error)
}

// A move's entry names its source in `from` as well, so that a code rewind knows the call removed that file too.
function patchFile(change: Prepared, after = change.after): typeof FileDiff.Info.Type & { readonly from?: string } {
  const moved = change.type === "update" ? change.moveTarget : undefined
  const diff = fileDiff(
    change.target.place,
    change.before,
    after,
    change.type === "add" && !change.existed ? "added" : change.type === "delete" ? "deleted" : "modified",
  )
  return {
    ...diff,
    file: moved?.resource ?? change.target.resource,
    ...(moved ? { from: change.target.resource } : {}),
  }
}

/** A move onto an existing file replaces it, so the destination's current text is shown as removed beside the move. */
function replacedFile(change: Prepared, after?: string): ReadonlyArray<typeof FileDiff.Info.Type> {
  if (change.type !== "update" || !change.moveTarget || change.replaced === undefined) return []
  const diff = fileDiff(change.moveTarget.place, change.replaced, after ?? change.after, "modified")
  return [{ ...diff, file: change.moveTarget.resource }]
}

// The lines a chunk adds: its new side less one copy of each line on its old side. A context line is on both sides and
// drops out; a line the chunk holds more often than the file did before is kept. Each old line is counted once and spent
// as the new side reaches its copy, so the work stays linear in the chunk, which every Patch pays.
const added = (chunk: Patch.UpdateFileChunk) => {
  const left = new Map<string, number>()
  chunk.oldLines.forEach((line) => left.set(line, (left.get(line) ?? 0) + 1))
  return chunk.newLines.filter((line) => {
    const remaining = (left.get(line) ?? 0) - 1
    left.set(line, remaining)
    return remaining < 0
  })
}
