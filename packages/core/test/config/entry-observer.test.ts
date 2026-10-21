import { describe, expect } from "bun:test"
import { Config } from "@orbit/core/config"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { Event } from "@orbit/schema/event"
import { Deferred, Effect, PubSub, Ref, Stream } from "effect"
import { ConfigEntryObserver } from "../../src/config/plugin/entry-observer"
import { it } from "../lib/effect"

describe("ConfigEntryObserver", () => {
  it.effect("closes the startup race and reloads later updates", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make([document("first")])
      const updates = yield* PubSub.unbounded<ReturnType<typeof updated>>()
      const reloaded = yield* Deferred.make<void>()
      const config = Config.Service.of({
        entries: () => Ref.get(current),
        compatEnabled: () => Effect.succeed(Config.defaultCompat.enabled),
        compat: () => Effect.succeed(Config.defaultCompat),
        changes: () => Stream.empty,
        fingerprints: () => Effect.succeed([]),
        pluginsChanged: () => Effect.succeed(false),
        notify: () => Effect.void,
      })
      const event = {
        subscribe: () =>
          Stream.unwrap(Ref.set(current, [document("raced")]).pipe(Effect.as(Stream.fromPubSub(updates)))),
      }

      const loaded = yield* ConfigEntryObserver.observe(
        config,
        event,
        Deferred.succeed(reloaded, undefined).pipe(Effect.asVoid),
      )

      expect(Config.latest(loaded.entries, "shell")).toBe("raced")
      expect(yield* Deferred.isDone(reloaded)).toBe(false)

      yield* Ref.set(current, [document("later")])
      yield* PubSub.publish(updates, updated())
      yield* Deferred.await(reloaded)

      expect(Config.latest(loaded.entries, "shell")).toBe("later")
    }),
  )
})

function document(shell: string): Entry {
  return new Document({ type: "document", info: new Info({ shell }) })
}

function updated() {
  return { id: Event.ID.create(), created: Date.now(), type: "config.updated" as const, data: {} }
}
