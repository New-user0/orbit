import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { access } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "./fixture"

test("tmpdir waits for a file that is still held when it is disposed", async () => {
  const dir = await tmpdir()
  const db = new Database(path.join(dir.path, "held.db"))
  db.run("create table t (x)")
  setTimeout(() => db.close(), 400)
  await dir[Symbol.asyncDispose]()
  await expect(access(dir.path)).rejects.toThrow()
})
