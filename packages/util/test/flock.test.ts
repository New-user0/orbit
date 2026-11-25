import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "@orbit/util/flock"
import { runProgram } from "../../core/test/fixture/run-program.js"

function failure(code: string) {
  return Object.assign(new Error(code), { code })
}

describe("Flock.gone", () => {
  test("a missing file or folder is gone", () => {
    expect(Flock.gone(failure("ENOENT"))).toBe(true)
    expect(Flock.gone(failure("ENOTDIR"))).toBe(true)
  })

  // Windows CI met this while one holder released a lock and another checked whether it was stale:
  // stat on the meta.json being deleted threw EPERM, and withLock failed.
  test("on Windows a file whose deletion is pending (EPERM) is gone, and elsewhere EPERM stays an error", () => {
    expect(Flock.gone(failure("EPERM"))).toBe(process.platform === "win32")
  })

  test("a permission error, another error and a value without a code are not", () => {
    expect(Flock.gone(failure("EACCES"))).toBe(false)
    expect(Flock.gone(new Error("boom"))).toBe(false)
    expect(Flock.gone(undefined)).toBe(false)
  })
})

describe("Flock.acquire", () => {
  // The stale check stats the held lock's heartbeat. A heartbeat that another holder is deleting answers EPERM on
  // Windows; a heartbeat that the contender may not read answers EPERM too, and stands in for it here. The contender
  // then waits for the lock, as it does for a missing heartbeat, instead of failing with the error.
  test.skipIf(process.platform !== "win32")(
    "on Windows a contender whose stat of the held lock's heartbeat answers EPERM waits for the lock instead of failing",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-"))
      const held = await Flock.acquire("key", { dir })
      const lock = path.join(dir, (await fs.readdir(dir)).find((name) => name.endsWith(".lock"))!)
      const heartbeat = path.join(lock, "heartbeat")
      // By its full path, so no icacls.exe in the working folder is started instead (class 10).
      const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe")
      await runProgram([icacls, lock, "/deny", "*S-1-1-0:(RD)"])
      await runProgram([icacls, heartbeat, "/deny", "*S-1-1-0:(RA)"])
      const denied = await fs.stat(heartbeat).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error.code,
      )
      const waits: number[] = []
      const error = await Flock.acquire("key", {
        dir,
        timeoutMs: 300,
        baseDelayMs: 20,
        onWait: (event) => void waits.push(event.attempt),
      }).then(
        (lease) => lease.release().then(() => undefined),
        (error: Error) => error,
      )
      await runProgram([icacls, heartbeat, "/remove:d", "*S-1-1-0"])
      await runProgram([icacls, lock, "/remove:d", "*S-1-1-0"])
      await held.release()
      await fs.rm(dir, { recursive: true, force: true })
      expect(denied).toBe("EPERM")
      expect(error?.message).toBe("Timed out waiting for lock: key")
      expect(waits.length).toBeGreaterThan(0)
    },
  )
})
