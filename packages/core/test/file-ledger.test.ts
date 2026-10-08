import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileLedger } from "@orbit/core/file-ledger"
import { Location } from "@orbit/core/location"
import { Session } from "@orbit/core/session"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = Session.ID.make("ses_file_ledger_test")
const other = Session.ID.make("ses_file_ledger_other")

const message = (exit: Exit.Exit<void, { readonly message: string }>) =>
  Exit.isFailure(exit) ? exit.cause.toString() : "ok"

describe("FileLedger", () => {
  it.live("requires a read before changing an existing file, and a fresh read after it changes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "a.ts")
      yield* Effect.promise(async () => {
        await Bun.write(file, "one\n")
        await fs.utimes(file, new Date(1_000_000), new Date(1_000_000))
      })
      const ledger = yield* FileLedger.Service

      expect(yield* ledger.assertFresh(sessionID, path.join(tmp.path, "new.ts"), "new.ts").pipe(Effect.exit)).toEqual(
        Exit.void,
      )
      expect(message(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit))).toContain(
        "a.ts has not been read in this session",
      )
      expect((yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")

      yield* ledger.record(sessionID, file)
      expect(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit)).toEqual(Exit.void)
      expect(message(yield* ledger.assertFresh(other, file, "a.ts").pipe(Effect.exit))).toContain("has not been read")
      expect((yield* ledger.assertFresh(other, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")

      yield* Effect.promise(() => fs.utimes(file, new Date(2_000_000), new Date(2_000_000)))
      expect(message(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit))).toContain(
        "a.ts changed since it was last read",
      )
      expect((yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.flip)).code).toBe("file.stale")
    }).pipe(Effect.provide(AppNodeBuilder.build(FileLedger.node, [Location.node.replace(tempLocationLayer)]))),
  )
})
