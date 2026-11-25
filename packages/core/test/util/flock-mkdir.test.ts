import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Flock } from "@orbit/util/flock"

// A contender creates the lock's folder with mkdir. On Windows that mkdir answers EPERM while the folder of the lock that
// the last holder just released is still being deleted (another handle to it is open), and withLock then failed instead
// of waiting: the GitHub Windows tui job of run 45534225577 (job 138936745091) failed `opens a background tab` with
// `EPERM: operation not permitted, mkdir '...\locks\<hash>.lock'` at flock.ts line 154, and the 16-process contention
// rows of util.flock and util.effect-flock lost a worker with exit code 1 the same way.
//
// An access list that denies creating folders in the lock directory makes mkdir answer EPERM on an ordinary account,
// and stands in for the folder whose deletion is pending; it is taken away after a moment, as the other handle closes.
// An account that can create folders past the list cannot build the condition, so the row is skipped there rather than
// passing on a mkdir that worked.
// By its full path, so no icacls.exe in the working folder is started instead (class 10).
const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe")

async function icaclsRun(...args: string[]) {
  const child = Bun.spawn([icacls, ...args], { stdout: "ignore", stderr: "pipe" })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`icacls ${args.join(" ")} exited with ${code}: ${stderr}`)
}

const deny = (dir: string) => icaclsRun(dir, "/deny", "*S-1-1-0:(AD)")
const restore = (dir: string) => icaclsRun(dir, "/remove:d", "*S-1-1-0")

const deniable =
  process.platform === "win32" &&
  (await (async () => {
    const probe = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-mkdir-probe-"))
    await deny(probe)
    const answer = await fs.mkdir(path.join(probe, "x.lock")).then(
      () => "made",
      (error: NodeJS.ErrnoException) => String(error.code),
    )
    await restore(probe)
    await fs.rm(probe, { recursive: true, force: true })
    return answer === "EPERM"
  })())

describe("Flock.withLock on Windows", () => {
  test.skipIf(!deniable)(
    "a contender whose mkdir of the lock folder answers EPERM waits for the lock instead of failing",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-mkdir-"))
      try {
        await deny(dir)
        const lifted = Bun.sleep(500).then(() => restore(dir))
        const ran = await Flock.withLock("key", async () => "ran", { dir, timeoutMs: 10_000, baseDelayMs: 20 }).catch(
          (error: NodeJS.ErrnoException) => `failed: ${error.code ?? error.message}`,
        )
        await lifted
        expect(ran).toBe("ran")
      } finally {
        await restore(dir).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test.skipIf(process.platform !== "win32")("the lock is taken when mkdir works: the control for the row above", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-mkdir-"))
    try {
      expect(await Flock.withLock("key", async () => "ran", { dir, timeoutMs: 10_000 })).toBe("ran")
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
