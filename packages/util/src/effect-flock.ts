import path from "path"
import os from "os"
import { randomUUID } from "crypto"
import { Context, Effect, Function, Layer, Option, Schedule, Schema } from "effect"
import type { FileSystem, Scope } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Flock } from "./flock.js"
import { FSUtil } from "./fs-util.js"
import { Global } from "./global.js"
import { makeGlobalNode } from "./effect/app-node.js"
import { Hash } from "./hash.js"

export namespace EffectFlock {
  // ---------------------------------------------------------------------------
  // Errors
  // ---------------------------------------------------------------------------

  export class LockTimeoutError extends Schema.TaggedError<LockTimeoutError>()("LockTimeoutError", {
    key: Schema.String,
  }) {}

  export class LockCompromisedError extends Schema.TaggedError<LockCompromisedError>()("LockCompromisedError", {
    detail: Schema.String,
  }) {}

  class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      return this.detail
    }
  }

  /** Internal: signals "lock is held, retry later". Never leaks to callers. */
  class NotAcquired extends Schema.TaggedError<NotAcquired>()("NotAcquired", {}) {}

  export type LockError = LockTimeoutError | LockCompromisedError

  export interface Options {
    readonly staleMs?: number
    readonly timeoutMs?: number
  }

  // ---------------------------------------------------------------------------
  // Timing defaults
  // ---------------------------------------------------------------------------

  const DEFAULT_STALE_MS = 60_000
  const DEFAULT_TIMEOUT_MS = 5 * 60_000
  const BASE_DELAY_MS = 100
  const MAX_DELAY_MS = 2_000

  const retrySchedule = (timeoutMs: number) =>
    Schedule.min([
      Schedule.exponential(BASE_DELAY_MS, 1.7),
      Schedule.spaced(Math.min(MAX_DELAY_MS, Math.max(BASE_DELAY_MS, Math.floor(timeoutMs / 10)))),
    ]).pipe(
      Schedule.jittered,
      Schedule.while((meta) => meta.elapsed < timeoutMs),
    )

  // ---------------------------------------------------------------------------
  // Lock metadata schema
  // ---------------------------------------------------------------------------

  const LockMetaJson = Schema.fromJsonString(
    Schema.Struct({
      token: Schema.String,
      pid: Schema.Number,
      hostname: Schema.String,
      createdAt: Schema.String,
    }),
  )

  const decodeMeta = Schema.decodeUnknownSync(LockMetaJson)
  const encodeMeta = Schema.encodeSync(LockMetaJson)

  // ---------------------------------------------------------------------------
  // Service
  // ---------------------------------------------------------------------------

  export interface Interface {
    readonly acquire: (key: string, dir?: string, options?: Options) => Effect.Effect<void, LockError, Scope.Scope>
    readonly withLock: {
      (key: string, dir?: string): <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockError, R>
      <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R>
    }
  }

  export class Service extends Context.Service<Service, Interface>()("EffectFlock") {}

  // ---------------------------------------------------------------------------
  // Layer
  // ---------------------------------------------------------------------------

  function wall() {
    return performance.timeOrigin + performance.now()
  }

  const mtimeMs = (info: FileSystem.File.Info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()

  const isPathGone = (e: PlatformError) => e.reason._tag === "NotFound" || e.reason._tag === "Unknown"

  // Windows answers EPERM to a mkdir while a folder of that name is still being deleted, as the folder of a lock that
  // its holder just released is until every handle to it closes. The lock is then as good as held: wait and try again.
  // A denial that lasts ends at the timeout, with the error that names the key.
  const releasing = (e: PlatformError) => process.platform === "win32" && causeCode(e) === "EPERM"

  // Windows refuses to delete a file that another handle has open without sharing deletion (EBUSY), and a scanner or a
  // contender reading the lock holds one for a moment; a folder whose deletion is still pending answers EPERM or EACCES.
  const busy = (e: PlatformError) => process.platform === "win32" && ["EBUSY", "EPERM", "EACCES"].includes(causeCode(e))

  // The file system names no reason for EPERM or EBUSY, so the code is read from the cause.
  const causeCode = (e: PlatformError) =>
    typeof e.reason.cause === "object" && e.reason.cause !== null && "code" in e.reason.cause
      ? String(e.reason.cause.code)
      : ""

  const layer: Layer.Layer<Service, never, Global.Service | FSUtil.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const fs = yield* FSUtil.Service
      const lockRoot = path.join(global.state, "locks")
      const hostname = os.hostname()
      const ensuredDirs = new Set<string>()

      // -- helpers (close over fs) --

      const safeStat = (file: string) =>
        fs.stat(file).pipe(
          Effect.catchIf(isPathGone, () => Effect.void),
          Effect.orDie,
        )

      const forceRemove = (target: string) => fs.remove(target, { recursive: true }).pipe(Effect.ignore)

      /**
       * Atomic mkdir — returns true if created, false if already exists, NotAcquired while a folder of that name is
       * still being deleted on Windows, dies on other errors.
       */
      const atomicMkdir = (dir: string) =>
        fs.makeDirectory(dir, { mode: 0o700 }).pipe(
          Effect.as(true),
          Effect.catchIf(
            (e) => e.reason._tag === "AlreadyExists",
            () => Effect.succeed(false),
          ),
          Effect.catch((e) => (releasing(e) ? Effect.fail(new NotAcquired()) : Effect.die(e))),
        )

      /** Write with exclusive create — compromised error if file already exists. */
      const exclusiveWrite = (filePath: string, content: string, lockDir: string, detail: string) =>
        fs.writeFileString(filePath, content, { flag: "wx" }).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              yield* forceRemove(lockDir)
              return yield* new LockCompromisedError({ detail })
            }),
          ),
        )

      const cleanStaleBreaker = Effect.fnUntraced(function* (breakerPath: string, staleMs: number) {
        const bs = yield* safeStat(breakerPath)
        if (bs && wall() - mtimeMs(bs) > staleMs) yield* forceRemove(breakerPath)
        return false
      })

      const ensureDir = Effect.fnUntraced(function* (dir: string) {
        if (ensuredDirs.has(dir)) return
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
        ensuredDirs.add(dir)
      })

      const isStale = Effect.fnUntraced(function* (
        lockDir: string,
        heartbeatPath: string,
        metaPath: string,
        staleMs: number,
      ) {
        const now = wall()

        const hb = yield* safeStat(heartbeatPath)
        if (hb) return now - mtimeMs(hb) > staleMs

        const meta = yield* safeStat(metaPath)
        if (meta) return now - mtimeMs(meta) > staleMs

        const dir = yield* safeStat(lockDir)
        if (!dir) return false

        return now - mtimeMs(dir) > staleMs
      })

      // -- single lock attempt --

      type Handle = { token: string; metaPath: string; heartbeatPath: string; lockDir: string }

      const tryAcquireLockDir = (lockDir: string, key: string, staleMs: number) =>
        Effect.gen(function* () {
          const token = randomUUID()
          const metaPath = path.join(lockDir, "meta.json")
          const heartbeatPath = path.join(lockDir, "heartbeat")

          // Atomic mkdir — the POSIX lock primitive
          const created = yield* atomicMkdir(lockDir)

          if (!created) {
            if (!(yield* isStale(lockDir, heartbeatPath, metaPath, staleMs))) return yield* new NotAcquired()

            // Stale — race for breaker ownership
            const breakerPath = lockDir + ".breaker"

            const claimed = yield* fs.makeDirectory(breakerPath, { mode: 0o700 }).pipe(
              Effect.as(true),
              Effect.catchIf(
                (e) => e.reason._tag === "AlreadyExists",
                () => cleanStaleBreaker(breakerPath, staleMs),
              ),
              Effect.catchIf(isPathGone, () => Effect.succeed(false)),
              Effect.orDie,
            )

            if (!claimed) return yield* new NotAcquired()

            // We own the breaker — double-check staleness, nuke, recreate
            const recreated = yield* Effect.gen(function* () {
              if (!(yield* isStale(lockDir, heartbeatPath, metaPath, staleMs))) return false
              yield* forceRemove(lockDir)
              return yield* atomicMkdir(lockDir)
            }).pipe(Effect.ensuring(forceRemove(breakerPath)))

            if (!recreated) return yield* new NotAcquired()
          }

          // We own the lock dir — write heartbeat + meta with exclusive create
          yield* exclusiveWrite(heartbeatPath, "", lockDir, "heartbeat already existed")

          const metaJson = encodeMeta({ token, pid: process.pid, hostname, createdAt: new Date().toISOString() })
          yield* exclusiveWrite(metaPath, metaJson, lockDir, "meta.json already existed")

          return { token, metaPath, heartbeatPath, lockDir } satisfies Handle
        }).pipe(
          Effect.withSpan("EffectFlock.tryAcquire", {
            attributes: { key },
          }),
        )

      // -- retry wrapper (preserves Handle type) --

      const acquireHandle = (
        lockfile: string,
        key: string,
        options: { staleMs: number; timeoutMs: number },
      ): Effect.Effect<Handle, LockError> =>
        tryAcquireLockDir(lockfile, key, options.staleMs).pipe(
          Effect.retry({
            while: (err) => err._tag === "NotAcquired",
            schedule: retrySchedule(options.timeoutMs),
          }),
          Effect.catchTag("NotAcquired", () => Effect.fail(new LockTimeoutError({ key }))),
          Effect.timeoutOrElse({
            duration: options.timeoutMs,
            orElse: () => Effect.fail(new LockTimeoutError({ key })),
          }),
        )

      // -- release --

      const release = (handle: Handle) =>
        Effect.gen(function* () {
          const raw = yield* fs.readFileString(handle.metaPath).pipe(
            Effect.catch((err) => {
              if (isPathGone(err)) return Effect.die(new ReleaseError({ detail: "metadata missing" }))
              return Effect.die(err)
            }),
          )

          const parsed = yield* Effect.try({
            try: () => decodeMeta(raw),
            catch: (cause) => new ReleaseError({ detail: "metadata invalid", cause }),
          }).pipe(Effect.orDie)

          if (parsed.token !== handle.token) return yield* Effect.die(new ReleaseError({ detail: "token mismatch" }))

          // The holder's release removes the folder; a handle that lingers on Windows delays it, and the work already
          // ran, so the release waits for the handle (as Flock's does) rather than leaving a folder with a fresh
          // heartbeat that the next acquirer would wait out until it is stale. A handle that is never let go fails the
          // release at the deadline with the removal's error.
          yield* fs.remove(handle.lockDir, { recursive: true, force: true }).pipe(
            Effect.retry({
              while: busy,
              schedule: Schedule.min([Schedule.exponential(10, 2), Schedule.spaced(200)]).pipe(
                Schedule.while((meta) => meta.elapsed < Flock.RELEASE_DEADLINE_MS),
              ),
            }),
            Effect.orDie,
          )
        })

      // -- build service --

      const acquire = Effect.fn("EffectFlock.acquire")(function* (key: string, dir?: string, options: Options = {}) {
        const lockDir = dir ?? lockRoot
        const staleMs = options.staleMs ?? DEFAULT_STALE_MS
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        yield* ensureDir(lockDir)

        const lockfile = path.join(lockDir, Hash.fast(key) + ".lock")

        // acquireRelease: acquire is uninterruptible, release is guaranteed
        const handle = yield* Effect.acquireRelease(acquireHandle(lockfile, key, { staleMs, timeoutMs }), (handle) =>
          release(handle),
        )

        // Heartbeat fiber — scoped, so it's interrupted before release runs
        yield* Effect.suspend(() => {
          const now = new Date()
          return fs.utimes(handle.heartbeatPath, now, now)
        }).pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced(Math.max(100, Math.floor(staleMs / 3)))),
          Effect.forkScoped,
        )
      })

      const withLock: Interface["withLock"] = Function.dual(
        (args) => Effect.isEffect(args[0]),
        <A, E, R>(body: Effect.Effect<A, E, R>, key: string, dir?: string): Effect.Effect<A, E | LockError, R> =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* acquire(key, dir)
              return yield* body
            }),
          ),
      )

      return Service.of({ acquire, withLock })
    }),
  )

  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Global.node, FSUtil.node] })
}
