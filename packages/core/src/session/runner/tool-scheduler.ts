export * as ToolScheduler from "./tool-scheduler.js"

import { Deferred, Effect } from "effect"

/** What `run` settled as: the work finished, or the entry was cancelled before it could (or while it did). */
export type Result<A, E> =
  | { readonly _tag: "Ran"; readonly value: A }
  | { readonly _tag: "Cancelled"; readonly error: E }

/** One registered tool call. Create it with `register`, and always `release` it. */
export interface Entry<E> {
  readonly id: string
  /** Set once the entry is cancelled; a cancelled entry never starts its work. */
  cancelled?: { readonly error: E }
  /** `registered` has no traits yet, `queued` waits for its turn, `running` holds a slot. */
  state: "registered" | "queued" | "running" | "settled"
  safe: boolean
  readonly turn: Deferred.Deferred<void>
  readonly cancel: Deferred.Deferred<E>
}

export interface Options {
  /** Most safe entries that run together. */
  readonly maxConcurrency: number
  /** An entry has resolved traits but cannot start yet. */
  readonly onQueued?: (id: string) => Effect.Effect<void>
  /** An entry that was reported as queued starts. */
  readonly onStarted?: (id: string) => Effect.Effect<void>
}

export interface Selection {
  /** Also cancel the entries that are running. Queued ones are always cancelled. */
  readonly running: boolean
  /** Also cancel the entries that are registered after this call and match `select`. */
  readonly future: boolean
  readonly select: (id: string) => boolean
}

/**
 * Orders the tool calls of one model attempt. Entries start strictly in registration order: a safe entry shares the
 * cap with the safe entries that run, a non-safe entry runs alone, and an entry whose traits are not resolved yet holds
 * back every entry behind it. Eligibility is re-checked on each state change (traits arriving, release, cancel, halt),
 * so a partition starts while later calls are still streaming in.
 */
export function make<E>(options: Options) {
  const entries: Array<Entry<E>> = []
  const rules: Array<{ readonly select: (id: string) => boolean; readonly error: E }> = []
  let halted: { readonly error: E } | undefined

  // Every state change happens in a synchronous block that ends here, so two fibers never see a half-updated queue.
  const pump = () => {
    let running = 0
    let exclusive = false
    for (const entry of entries) {
      if (entry.state === "running") {
        running++
        if (!entry.safe) exclusive = true
        continue
      }
      if (entry.state !== "queued") return
      const eligible = entry.safe ? !exclusive && running < options.maxConcurrency : running === 0
      if (!eligible) return
      entry.state = "running"
      running++
      if (!entry.safe) exclusive = true
      Deferred.doneUnsafe(entry.turn, Effect.void)
    }
  }

  const settle = (entry: Entry<E>, error: E) => {
    if (entry.cancelled) return
    entry.cancelled = { error }
    Deferred.doneUnsafe(entry.cancel, Effect.succeed(error))
  }

  const remove = (entry: Entry<E>) => {
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
    entry.state = "settled"
  }

  /** Registers a call in provider order. It starts nothing: only `run` supplies the traits that let it start. */
  const register = (id: string): Entry<E> => {
    const entry: Entry<E> = {
      id,
      state: "registered",
      safe: false,
      turn: Deferred.makeUnsafe<void>(),
      cancel: Deferred.makeUnsafe<E>(),
    }
    const rule = halted ?? rules.find((item) => item.select(id))
    // A call that is cancelled on arrival never joins the queue, so it cannot hold back the calls behind it.
    if (rule) settle(entry, rule.error)
    else entries.push(entry)
    return entry
  }

  /** Waits for the entry's turn, then runs `work`; both the wait and the work end as `Cancelled` on cancel. */
  const run = <A, F, R>(
    entry: Entry<E>,
    traits: { readonly concurrencySafe: boolean },
    work: Effect.Effect<A, F, R>,
  ): Effect.Effect<Result<A, E>, F, R> =>
    Effect.suspend((): Effect.Effect<Result<A, E>, F, R> => {
      if (entry.cancelled) return Effect.succeed({ _tag: "Cancelled", error: entry.cancelled.error })
      entry.safe = traits.concurrencySafe
      entry.state = "queued"
      pump()
      const queued = entry.state === "queued"
      const started = Deferred.await(entry.turn).pipe(
        Effect.andThen(queued ? (options.onStarted?.(entry.id) ?? Effect.void) : Effect.void),
        Effect.andThen(work),
        Effect.map((value): Result<A, E> => ({ _tag: "Ran", value })),
      )
      const aborted = Deferred.await(entry.cancel).pipe(
        Effect.map((error): Result<A, E> => ({ _tag: "Cancelled", error })),
      )
      return (queued ? (options.onQueued?.(entry.id) ?? Effect.void) : Effect.void).pipe(
        Effect.andThen(Effect.raceFirst(started, aborted)),
      )
    })

  /** Frees the entry's slot, or its place in the queue, and lets the next entries start. Safe to call twice. */
  const release = (entry: Entry<E>) =>
    Effect.sync(() => {
      remove(entry)
      pump()
    })

  /** Cancels the queued entries that match, the running ones when asked, and optionally the matching ones to come. */
  const cancel = (selection: Selection, error: E) =>
    Effect.sync(() => {
      if (selection.future) rules.push({ select: selection.select, error })
      entries
        .filter((entry) => selection.select(entry.id) && (selection.running || entry.state !== "running"))
        .forEach((entry) => {
          settle(entry, error)
          if (entry.state !== "running") remove(entry)
        })
      pump()
    })

  /** Cancels the queued entries and every entry registered later. Running entries are left to finish. */
  const halt = (error: E) =>
    Effect.sync(() => {
      halted ??= { error }
      entries
        .filter((entry) => entry.state !== "running")
        .forEach((entry) => {
          settle(entry, error)
          remove(entry)
        })
      pump()
    })

  return { register, run, release, cancel, halt }
}
