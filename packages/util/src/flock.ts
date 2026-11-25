import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
import { mkdir, readFile, rm, stat, utimes, writeFile } from "fs/promises"
import { Hash } from "./hash.js"
import { Effect } from "effect"

export type FlockGlobal = {
  state: string
}

export namespace Flock {
  let global: FlockGlobal | undefined

  export function setGlobal(g: FlockGlobal) {
    global = g
  }

  const root = () => {
    if (!global) throw new Error("Flock global not set")
    return path.join(global.state, "locks")
  }

  // Defaults for callers that do not provide timing options.
  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
  }

  type Opts = {
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
  }

  type Owned = {
    acquired: true
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  function code(err: unknown) {
    if (typeof err !== "object" || err === null || !("code" in err)) return
    const value = err.code
    if (typeof value !== "string") return
    return value
  }

  // Windows answers EPERM to a mkdir while a folder of that name is still being deleted, as the folder of a lock that
  // its holder just released is until every handle to it closes. The lock is then as good as held: wait and try again.
  // A denial that lasts ends at the timeout, with the error that names the key.
  function releasing(err: unknown) {
    return process.platform === "win32" && code(err) === "EPERM"
  }

  // Windows refuses to delete a file that another handle has open without sharing deletion (EBUSY), and a scanner or a
  // contender reading the lock holds one for a moment; a folder whose deletion is still pending answers EPERM or EACCES.
  function busy(err: unknown) {
    const errCode = code(err)
    return process.platform === "win32" && (errCode === "EBUSY" || errCode === "EPERM" || errCode === "EACCES")
  }

  /** How long a holder that is releasing its lock waits for other handles to its folder to close. */
  export const RELEASE_DEADLINE_MS = 5_000

  // The holder's release removes the folder; a handle that lingers on Windows delays it, and the work already ran, so
  // the release waits for the handle rather than failing the call. A handle that is never let go fails it at the
  // deadline with the removal's error.
  async function removeHeld(lockDir: string) {
    const stop = mono() + RELEASE_DEADLINE_MS
    const attempt = async (delay: number): Promise<void> =>
      rm(lockDir, { recursive: true, force: true }).catch(async (err: unknown) => {
        if (!busy(err) || mono() + delay > stop) throw err
        await sleep(delay)
        return attempt(Math.min(delay * 2, 200))
      })
    return attempt(10)
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"))
        return
      }

      let timer: NodeJS.Timeout | undefined

      const done = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        if (timer) {
          clearTimeout(timer)
        }
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }

      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(done, ms)
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  function mono() {
    return performance.now()
  }

  function wall() {
    return performance.timeOrigin + mono()
  }

  async function stats(file: string) {
    try {
      return await stat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  async function stale(lockDir: string, heartbeatPath: string, metaPath: string, staleMs: number) {
    // Stale detection allows automatic recovery after crashed owners.
    const now = wall()
    const heartbeat = await stats(heartbeatPath)
    if (heartbeat) {
      return now - heartbeat.mtimeMs > staleMs
    }

    const meta = await stats(metaPath)
    if (meta) {
      return now - meta.mtimeMs > staleMs
    }

    const dir = await stats(lockDir)
    if (!dir) {
      return false
    }

    return now - dir.mtimeMs > staleMs
  }

  async function tryAcquireLockDir(lockDir: string, opts: Opts): Promise<Owned | { acquired: false }> {
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")

    try {
      await mkdir(lockDir, { mode: 0o700 })
    } catch (err) {
      if (releasing(err)) return { acquired: false }
      if (code(err) !== "EEXIST") {
        throw err
      }

      if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
        return { acquired: false }
      }

      const breakerPath = lockDir + ".breaker"
      try {
        await mkdir(breakerPath, { mode: 0o700 })
      } catch (claimErr) {
        const errCode = code(claimErr)
        if (errCode === "EEXIST") {
          const breaker = await stats(breakerPath)
          if (breaker && wall() - breaker.mtimeMs > opts.staleMs) {
            await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
          }
          return { acquired: false }
        }

        if (errCode === "ENOENT" || errCode === "ENOTDIR" || releasing(claimErr)) {
          return { acquired: false }
        }

        throw claimErr
      }

      try {
        // Breaker ownership ensures only one contender performs stale cleanup.
        if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
          return { acquired: false }
        }

        // A handle to the stale folder that lingers on Windows makes the removal fail; the lock is then tried again.
        const removed = await rm(lockDir, { recursive: true, force: true }).then(
          () => true,
          (err: unknown) => {
            if (busy(err)) return false
            throw err
          },
        )
        if (!removed) return { acquired: false }

        try {
          await mkdir(lockDir, { mode: 0o700 })
        } catch (retryErr) {
          const errCode = code(retryErr)
          // The folder just removed can still be pending deletion, as the first mkdir's EPERM above.
          if (errCode === "EEXIST" || errCode === "ENOTEMPTY" || releasing(retryErr)) {
            return { acquired: false }
          }
          throw retryErr
        }
      } finally {
        await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    const meta = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }

    await writeFile(heartbeatPath, "", { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but heartbeat already existed (possible compromise).")
    })

    await writeFile(metaPath, JSON.stringify(meta, null, 2), { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but meta.json already existed (possible compromise).")
    })

    let timer: NodeJS.Timeout | undefined

    const startHeartbeat = (intervalMs = Math.max(100, Math.floor(opts.staleMs / 3))) => {
      if (timer) return
      // Heartbeat prevents long critical sections from being evicted as stale.
      timer = setInterval(() => {
        const t = new Date()
        void utimes(heartbeatPath, t, t).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      const current = await readFile(metaPath, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== "object") return {}
          return {
            token: "token" in parsed && typeof parsed.token === "string" ? parsed.token : undefined,
          }
        })
        .catch((err) => {
          const errCode = code(err)
          if (errCode === "ENOENT" || errCode === "ENOTDIR") {
            throw new Error("Refusing to release: lock is compromised (metadata missing).")
          }
          if (err instanceof SyntaxError) {
            throw new Error("Refusing to release: lock is compromised (metadata invalid).")
          }
          throw err
        })
      // Token check prevents deleting a lock that was re-acquired by another process.
      if (current.token !== token) {
        throw new Error("Refusing to release: lock token mismatch (not the owner).")
      }

      await removeHeld(lockDir)
    }

    return {
      acquired: true,
      startHeartbeat,
      release,
    }
  }

  async function acquireLockDir(
    lockDir: string,
    input: { key: string; onWait?: Wait; signal?: AbortSignal },
    opts: Opts,
  ) {
    const stop = mono() + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()

      const res = await tryAcquireLockDir(lockDir, opts)
      if (res.acquired) {
        return res
      }

      if (mono() > stop) {
        throw new Error(`Timed out waiting for lock: ${input.key}`)
      }

      attempt += 1
      const ms = jitter(delay)
      await input.onWait?.({
        key: input.key,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  export async function acquire(key: string, input: Options = {}): Promise<Lease> {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
    }
    const dir = input.dir ?? root()

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await acquireLockDir(
      lockfile,
      {
        key,
        onWait: input.onWait,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()

    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  export async function withLock<T>(key: string, fn: () => Promise<T>, input: Options = {}) {
    await using _ = await acquire(key, input)
    input.signal?.throwIfAborted()
    return await fn()
  }

  export const effect = Effect.fn("Flock.effect")(function* (key: string, input: Options = {}) {
    return yield* Effect.acquireRelease(
      Effect.promise((signal) => Flock.acquire(key, { ...input, signal })).pipe(
        Effect.withSpan("Flock.acquire", {
          attributes: { key },
        }),
      ),
      (lock) => Effect.promise(() => lock.release()).pipe(Effect.withSpan("Flock.release")),
    ).pipe(Effect.asVoid)
  })
}
