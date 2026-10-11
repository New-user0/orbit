export * as FileMutation from "./file-mutation.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { ToolFailure } from "@orbit/ai"
import { Tool } from "@orbit/schema/tool"
import { Context, Effect, Layer } from "effect"
import path from "path"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Bom } from "@orbit/util/bom"
import { Environment } from "./environment/index.js"
import type { Files } from "./environment/index.js"
import type { FileAccess } from "./file-access.js"
import { FileLedger } from "./file-ledger.js"

export type Target = Pick<FileAccess.Target, "absolute" | "resource">

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface Interface {
  /** Serialize a complete read/prepare/write mutation transaction by resolved path. */
  readonly withLock: (
    targets: ReadonlyArray<string>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, Environment.Failed>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<WriteResult, Environment.WrongKind | Environment.Failed>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/FileMutation") {}

export const readText = Effect.fn("FileMutation.readText")(function* (files: Files, target: string) {
  return Bom.decodeBytes((yield* files.read(target)).bytes)
})

export type Snapshot = { readonly text: string; readonly digest: string }

/**
 * The decoded text of a file with the modification time and byte digest of the same read, so the FileLedger can check
 * freshness and a tool can record the result without another stat or read.
 */
export const readSnapshot = Effect.fn("FileMutation.readSnapshot")(function* (files: Files, target: string) {
  const file = yield* files.read(target)
  return { ...Bom.decodeBytes(file.bytes), mtimeMs: file.info.mtimeMs, digest: FileLedger.digest(file.bytes) }
})

/**
 * Fails with `edit.stale` unless `target` is still what it was when `before` was read: absent if `before` is undefined,
 * otherwise the same bytes. Only content counts, so a touch passes. Run it under the file's lock after approval and
 * immediately before the first write; a file that cannot be read now counts as changed.
 */
export const assertUnchanged = Effect.fn("FileMutation.assertUnchanged")(function* (
  files: Files,
  target: string,
  display: string,
  before: Snapshot | undefined,
) {
  const now = yield* readSnapshot(files, target).pipe(
    Effect.catchTag("Environment.NotFound", () => Effect.undefined),
    Effect.catch((error) =>
      Effect.logWarning(`could not read ${target} again after approval`, error).pipe(Effect.as("unreadable" as const)),
    ),
  )
  // The digest folds line endings; the decoded text keeps them, so both together mean the same bytes.
  const same =
    now === "unreadable"
      ? false
      : now === undefined
        ? before === undefined
        : before !== undefined && before.digest === now.digest && before.text === now.text
  if (same) return
  return yield* new ToolFailure({
    message: `${display} changed on disk while the change waited for approval, so nothing was written. Read it again before changing it.`,
    code: Tool.ErrorCode.EditStale,
  })
})

export const syncTextBom = Effect.fn("FileMutation.syncTextBom")(function* (
  files: Files,
  target: string,
  bom: boolean,
) {
  const synced = Bom.syncBytes((yield* files.read(target)).bytes, bom)
  if (synced.bytes) yield* files.write(target, synced.bytes)
  return synced.text
})

// The key is the file's long name (for a file that exists; a new file keeps the spelling it is given) with the periods and spaces Windows drops, so `cfg.` and `cfg` share one lock. A path that cannot be resolved keeps its lexical key.
function lockKey(target: string) {
  const lexical = FSUtil.windowsTrim(path.resolve(FSUtil.windowsPath(target)))
  // Resolving a share's path connects to its host. Outside the project's own folder FileAccess refuses such a path, and every file tool checks before it locks, so a key for one stays lexical.
  if (process.platform === "win32" && (lexical.startsWith("\\\\") || lexical.startsWith("//"))) return lexical
  try {
    return FSUtil.resolve(lexical)
  } catch {
    return lexical
  }
}

/** Share transaction locks across Location graphs that address the same file. */
const transactionLocks = KeyedMutex.makeUnsafe<string>()

/**
 * Mutation locking is process-local and serializes cooperating Orbit
 * changes; external writes can still race.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withLock: Interface["withLock"] = (targets) => (effect) =>
      // Keys are computed inside the effect: a path that cannot be resolved (a link loop, no access) must reach the tool as its own error, not a defect.
      Effect.suspend(() =>
        [...new Set(targets.map(lockKey))]
          .sort()
          .reduceRight((result, target) => transactionLocks.withLock(target)(result), effect),
      )
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.absolute)(Effect.uninterruptible(effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.absolute,
      resource: target.resource,
      existed,
    })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* environment.files.stat(input.target.absolute).pipe(
            Effect.as(true),
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(false)),
          )
          yield* environment.files.write(
            input.target.absolute,
            typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content,
          )
          return writeResult(input.target, existed)
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const next = Bom.split(input.content)
          const current = yield* environment.files.read(input.target.absolute, { offset: 0, length: 3 }).pipe(
            Effect.map((result) => result.bytes),
            Effect.catchTag("Environment.NotFound", () => Effect.undefined),
          )
          yield* environment.files.write(
            input.target.absolute,
            new TextEncoder().encode(Bom.join(next.text, Boolean(current && Bom.has(current)) || next.bom)),
          )
          return writeResult(input.target, current !== undefined)
        }),
      ),
    )

    return Service.of({ withLock, write, writeTextPreservingBom })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node] })

/**
 * Deferred until the corresponding integrations exist.
 */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after snapshot design exists.
// TODO: Design multi-file transactions / rollback if patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
