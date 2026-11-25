import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "../../../core/test/fixture/decoy"
import { createAcpFixture } from "../acp/subprocess"
import { removeTree } from "./remove-tree"

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

describe("removing a test's folder", () => {
  // CI run 45555726730, Windows cli 2/6: the ACP trust gate passed, then its fixture's removal failed with EBUSY, because
  // the server that the last `orb acp` started was still closing orbit.db. This row is that state, with a stand-in holder.
  test("the ACP fixture's cleanup waits for a process that still holds orbit.db, then removes the folder", async () => {
    const fixture = await createAcpFixture()
    const holder = await holdDatabase(path.join(fixture.root, "orbit.db"), 3_000)
    await fixture[Symbol.asyncDispose]()
    expect(await fs.exists(fixture.root)).toBe(false)
    expect(await holder.exited).toBe(0)
  }, 60_000)

  // The cause, kept as a row: Bun's rm takes `maxRetries` and does not retry, so it fails at once while the handle is open.
  test.skipIf(process.platform !== "win32")(
    "Bun's rm fails at once on a database that is still open, whatever maxRetries says (Windows)",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-cli-remove-"))
      const holder = await holdDatabase(path.join(root, "orbit.db"), 3_000)
      const started = Date.now()
      const error = await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      )
      expect({ code: error?.code, quick: Date.now() - started < 1_000 }).toEqual({ code: "EBUSY", quick: true })
      await holder.exited
      await removeTree(root)
    },
    60_000,
  )

  test.skipIf(process.platform !== "win32")(
    "a holder that outlasts the deadline fails the removal, which names the folder, the error and the holder (Windows)",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-cli-remove-"))
      const holder = await holdDatabase(path.join(root, "orbit.db"), 30_000)
      const error = await removeTree(root, { deadline: 1_000, parents: [process.pid] }).then(
        () => undefined,
        (error: Error) => error,
      )
      holder.kill("SIGKILL")
      await holder.exited
      await removeTree(root)
      expect(error?.message).toContain(`${root} could not be removed within 1 s (EBUSY)`)
      expect(error?.message).toContain(`${holder.pid} `)
      expect(error?.message).toContain("bun:sqlite")
    },
    90_000,
  )

  // Class 10: the holder list starts PowerShell by its full path. A bare name is looked up, and a working folder that
  // PATH names (or, for a program that Windows itself looks up, any working folder) would supply its own powershell.exe,
  // which would run instead and leave the list empty. Bun.spawn looks a bare name up on PATH only, so this row puts the
  // working folder first on PATH.
  test.skipIf(process.platform !== "win32")(
    "listing what holds the folder starts no powershell.exe from the working folder, even when PATH names it (Windows)",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-cli-remove-"))
      const work = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-cli-decoy-"))
      using _ = currentDirectoryOnPath()
      const ran = await plant(work, "powershell")
      const holder = await holdDatabase(path.join(root, "orbit.db"), 30_000)
      const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { removeTree } from ${JSON.stringify(path.join(import.meta.dir, "remove-tree.ts"))}
const error = await removeTree(${JSON.stringify(root)}, { deadline: 500, parents: [${process.pid}] }).then(() => undefined, (error) => error)
console.log(error?.message ?? "removed")`,
        ],
        {
          cwd: work,
          // Windows spells the variable as it likes (`Path`), so the one that is there is replaced.
          env: { ...process.env, [pathKey]: `${work}${path.delimiter}${process.env[pathKey] ?? ""}` },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "inherit",
        },
      )
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      holder.kill("SIGKILL")
      await holder.exited
      const started = await ran()
      await removeTree(root)
      await removeTree(work)
      expect(code).toBe(0)
      expect(started).toEqual([])
      expect(output).toContain(`${root} could not be removed within 0.5 s (EBUSY)`)
      expect(output).toContain(`${holder.pid} `)
    },
    90_000,
  )

  test("an error that no holder causes fails at once", async () => {
    const started = Date.now()
    const error = await removeTree(path.join(os.tmpdir(), "bad\0name"), { deadline: 20_000 }).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(error?.message).toContain("could not be removed")
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
