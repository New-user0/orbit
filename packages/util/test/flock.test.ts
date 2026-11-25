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

// The stale check stats the held lock's heartbeat. A heartbeat that another holder is deleting answers EPERM on
// Windows; a heartbeat that the contender may not read answers EPERM too, and stands in for it below. An access list
// that denies the folder's listing and the file's attributes gives that answer on an ordinary account. An account that
// holds the backup privilege reads past the list (GitHub's elevated Windows runners do), so there the row cannot build
// its condition and is skipped rather than passing on a stat that answered.
// By its full path, so no icacls.exe in the working folder is started instead (class 10).
const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe")

async function denyHeartbeat(lock: string) {
  const heartbeat = path.join(lock, "heartbeat")
  await runProgram([icacls, lock, "/deny", "*S-1-1-0:(RD)"])
  await runProgram([icacls, heartbeat, "/deny", "*S-1-1-0:(RA)"])
  const answer = await fs.stat(heartbeat).then(
    () => "read",
    (error: NodeJS.ErrnoException) => String(error.code),
  )
  return {
    answer,
    async restore() {
      await runProgram([icacls, heartbeat, "/remove:d", "*S-1-1-0"])
      await runProgram([icacls, lock, "/remove:d", "*S-1-1-0"])
    },
  }
}

const deniable =
  process.platform === "win32" &&
  (await (async () => {
    const probe = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-probe-"))
    await fs.writeFile(path.join(probe, "heartbeat"), "")
    const denied = await denyHeartbeat(probe)
    await denied.restore()
    await fs.rm(probe, { recursive: true, force: true })
    return denied.answer === "EPERM"
  })())

describe("Flock.acquire", () => {
  test.skipIf(!deniable)(
    "on Windows a contender whose stat of the held lock's heartbeat answers EPERM waits for the lock instead of failing",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-"))
      const held = await Flock.acquire("key", { dir })
      const denied = await denyHeartbeat(path.join(dir, (await fs.readdir(dir)).find((name) => name.endsWith(".lock"))!))
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
      await denied.restore()
      await held.release()
      await fs.rm(dir, { recursive: true, force: true })
      expect(denied.answer).toBe("EPERM")
      expect(error?.message).toBe("Timed out waiting for lock: key")
      expect(waits.length).toBeGreaterThan(0)
    },
  )
})
