import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createAcpFixture } from "./subprocess"

// A process that opens a SQLite database the way the private server opens orbit.db, says so, and closes it after `ms`.
async function holdDatabase(file: string, ms: number) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { Database } = require("bun:sqlite")
const db = new Database(${JSON.stringify(file)})
db.run("pragma journal_mode = wal")
db.run("create table if not exists t (x)")
console.log("open")
setTimeout(() => db.close(), ${ms})`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  )
  const reader = child.stdout.getReader()
  await reader.read()
  reader.releaseLock()
  return child
}

// CI run 45555726730, Windows cli 2/6: the ACP trust gate passed, then its fixture's removal failed with EBUSY, because
// the server that the last `orb acp` started was still closing orbit.db. This row is that state, with a stand-in holder.
// The helper itself is pinned by packages/core/test/remove-tree.test.ts.
test("the ACP fixture's cleanup waits for a process that still holds orbit.db, then removes the folder", async () => {
  const fixture = await createAcpFixture()
  const holder = await holdDatabase(path.join(fixture.root, "orbit.db"), 3_000)
  await fixture[Symbol.asyncDispose]()
  expect(await fs.exists(fixture.root)).toBe(false)
  expect(await holder.exited).toBe(0)
}, 60_000)
