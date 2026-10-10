import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { WebFetchCache } from "../src/tool/webfetch-cache"
import { it } from "./lib/effect"

const ttl = Duration.toMillis(Duration.minutes(15))
const page = (content: string) => ({ finalUrl: "https://example.com/", contentType: "text/plain", content, bytes: content.length })

describe("WebFetchCache", () => {
  it.effect("evicts the least recently used entry first, and a read makes an entry recent", () =>
    Effect.gen(function* () {
      const cache = WebFetchCache.make({ ttl, maxBytes: 10 })
      yield* cache.set("a", page("aaaa"))
      yield* cache.set("b", page("bbbb"))
      yield* cache.get("a")
      yield* cache.set("c", page("cccc"))

      expect(yield* cache.get("b")).toBeUndefined()
      expect((yield* cache.get("a"))?.content).toBe("aaaa")
      expect((yield* cache.get("c"))?.content).toBe("cccc")
    }),
  )

  it.effect("restarts the time to live when a key is replaced", () =>
    Effect.gen(function* () {
      const cache = WebFetchCache.make({ ttl, maxBytes: 100 })
      yield* cache.set("a", page("old"))
      yield* TestClock.adjust(Duration.minutes(10))
      yield* cache.set("a", page("new"))
      yield* TestClock.adjust(Duration.minutes(10))

      expect((yield* cache.get("a"))?.content).toBe("new")
    }),
  )

  it.effect("does not store an entry larger than the whole bound, and keeps the others", () =>
    Effect.gen(function* () {
      const cache = WebFetchCache.make({ ttl, maxBytes: 5 })
      yield* cache.set("small", page("abc"))
      yield* cache.set("huge", page("abcdefgh"))

      expect(yield* cache.get("huge")).toBeUndefined()
      expect((yield* cache.get("small"))?.content).toBe("abc")
    }),
  )

  it.effect("counts an empty page as one byte", () =>
    Effect.gen(function* () {
      const cache = WebFetchCache.make({ ttl, maxBytes: 2 })
      yield* cache.set("a", page(""))
      yield* cache.set("b", page(""))
      yield* cache.set("c", page(""))

      expect(yield* cache.get("a")).toBeUndefined()
      expect(yield* cache.get("b")).toBeDefined()
      expect(yield* cache.get("c")).toBeDefined()
    }),
  )

  it.effect("expires an entry at exactly 15 minutes, and not before", () =>
    Effect.gen(function* () {
      const cache = WebFetchCache.make({ ttl, maxBytes: 100 })
      yield* cache.set("a", page("a"))
      yield* TestClock.adjust(Duration.millis(ttl - 1))
      expect(yield* cache.get("a")).toBeDefined()
      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* cache.get("a")).toBeUndefined()
    }),
  )
})
