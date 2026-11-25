import { Database as Sqlite } from "bun:sqlite"
import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@orbit/core/database/database"
import { Global } from "@orbit/util/global"
import { tmpdir } from "./fixture/tmpdir"

// A server that `orb`, `orb acp` or the TUI starts opens the data folder's orbit.db while the server that the previous
// command started may still be closing it: that command exits when its pipe to the server closes, without waiting for
// the server, and SQLite takes the database's lock while the last connection closes. The database must then wait for
// the lock, as its busy timeout says, rather than fail at once with "database is locked": the server would exit before
// it reported readiness ("Standalone server exited before reporting readiness" in docs/known-failures.md).
//
// The lock is held by another process, as a closing server would hold it, and let go after a second.
async function heldFor(file: string, ms: number) {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      [
        `const { Database } = require("bun:sqlite")`,
        `const db = new Database(${JSON.stringify(file)})`,
        `db.run("PRAGMA locking_mode = EXCLUSIVE")`,
        `db.run("BEGIN EXCLUSIVE")`,
        `db.run("insert into seed values (1)")`,
        `console.log("held")`,
        `setTimeout(() => { db.run("COMMIT"); db.close() }, ${ms})`,
      ].join("\n"),
    ],
    { stdout: "pipe", stderr: "inherit" },
  )
  const reader = holder.stdout.getReader()
  const first = await reader.read()
  if (!new TextDecoder().decode(first.value).includes("held")) throw new Error("the holder did not take the lock")
  reader.releaseLock()
  return holder
}

test("opening a database that another process is still closing waits for its lock instead of failing", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "orbit.db")
  const seed = new Sqlite(file)
  seed.run("PRAGMA journal_mode = WAL")
  seed.run("create table seed (x)")
  seed.close()

  const holder = await heldFor(file, 1_000)
  const opened = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(Database.layer({ path: file }))
      return "opened"
    }).pipe(
      Effect.scoped,
      Effect.provideService(Global.Service, Global.make({ data: tmp.path })),
      Effect.catchCause((cause) => Effect.succeed(String(cause))),
    ),
  )
  await holder.exited

  expect(opened).toBe("opened")
}, 30_000)

test("the same database opens when nobody holds it: the control for the row above", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "orbit.db")
  const opened = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(Database.layer({ path: file }))
      return "opened"
    }).pipe(Effect.scoped, Effect.provideService(Global.Service, Global.make({ data: tmp.path }))),
  )
  expect(opened).toBe("opened")
}, 30_000)
