export * as WebFetchCache from "./webfetch-cache.js"

import { Clock, Effect } from "effect"

/** One followed redirect: the URL that answered, the URL it pointed to and its status. */
export interface Hop {
  readonly from: string
  readonly to: string
  readonly status: number
}

export interface Entry {
  /** The URL of the last hop, which is where the content came from. */
  readonly finalUrl: string
  readonly contentType: string
  /** The converted output, which is what a call returns. */
  readonly content: string
  /** The size of the raw body. */
  readonly bytes: number
  /** The redirects that were followed to reach the page, in order, so a hit can be asked about as a live call is. */
  readonly hops: ReadonlyArray<Hop>
  readonly storedAt: number
}

type Stored = Entry & { readonly size: number }

/**
 * A page cache with a time to live and a bound on the total size of what it holds, evicting the entry used least
 * recently first. The time to live runs from the moment an entry is stored: reading it does not extend its life. It keeps
 * page content only, no headers, cookies or credentials.
 */
export function make(options: { readonly ttl: number; readonly maxBytes: number }) {
  // A Map iterates in insertion order, so the first key is the least recently used one: a read re-inserts its entry.
  const entries = new Map<string, Stored>()
  let total = 0

  const remove = (key: string, entry: Stored) => {
    entries.delete(key)
    total -= entry.size
  }

  return {
    get: (key: string) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const entry = entries.get(key)
          if (entry === undefined) return undefined
          remove(key, entry)
          if (now - entry.storedAt >= options.ttl) return undefined
          entries.set(key, entry)
          total += entry.size
          return entry as Entry
        }),
      ),
    set: (key: string, entry: Omit<Entry, "storedAt">) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          const previous = entries.get(key)
          if (previous !== undefined) remove(key, previous)
          const size = Math.max(1, Buffer.byteLength(entry.content))
          // A page larger than the whole cache would only push everything else out.
          if (size > options.maxBytes) return
          // Evicts from the least recently used end until the new entry fits.
          for (const [other, stored] of entries) {
            if (total + size <= options.maxBytes) break
            remove(other, stored)
          }
          entries.set(key, { ...entry, storedAt: now, size })
          total += size
        }),
      ),
  }
}
