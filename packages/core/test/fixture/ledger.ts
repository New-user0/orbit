import fs from "fs/promises"
import { Effect } from "effect"
import { FileLedger } from "@orbit/core/file-ledger"
import type { Session } from "@orbit/core/session"

/** Records the file as a whole read of it right now would: its time and the digest of its bytes. */
export const readNow = (sessionID: Session.ID, file: string) =>
  Effect.gen(function* () {
    const ledger = yield* FileLedger.Service
    const [info, bytes] = yield* Effect.promise(() => Promise.all([fs.stat(file), fs.readFile(file)]))
    yield* ledger.recordRead(sessionID, file, { mtimeMs: info.mtimeMs, digest: FileLedger.digest(bytes) })
  })
