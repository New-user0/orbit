import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { EffectFlock } from "@orbit/util/effect-flock"
import { Flock } from "@orbit/util/flock"
import { Global } from "@orbit/util/global"
import { Hash } from "@orbit/util/hash"

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

// Holds a file open without sharing deletion, as a scanner or a contender reading the lock does, until `ms` have passed;
// it answers once the handle is open. Windows PowerShell by its full path (class 10).
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

async function hold(file: string, ms: number) {
  const child = Bun.spawn(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$f = [System.IO.File]::Open('${file}', 'Open', 'Read', 'ReadWrite'); [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const reader = child.stdout.getReader()
  const first = await reader.read()
  reader.releaseLock()
  if (first.done) throw new Error(`powershell exited before it held ${file}: ${await new Response(child.stderr).text()}`)
  return { exited: child.exited }
}

// A PowerShell that has read the folder's access list and adds the denial `deny` adds (create folders, for everyone)
// as soon as it is told to, which takes milliseconds where starting icacls takes seconds under load.
async function armDenial(dir: string) {
  const child = Bun.spawn(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        `$acl = [System.IO.Directory]::GetAccessControl('${dir}')`,
        "$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')",
        "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'CreateDirectories', 'Deny')",
        "[Console]::Out.WriteLine('armed'); [Console]::Out.Flush()",
        "[void][Console]::In.ReadLine()",
        "$acl.AddAccessRule($rule)",
        `[System.IO.Directory]::SetAccessControl('${dir}', $acl)`,
        "[Console]::Out.WriteLine('denied'); [Console]::Out.Flush()",
      ].join("; "),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const reader = child.stdout.getReader()
  if ((await reader.read()).done) throw new Error(`powershell did not arm: ${await new Response(child.stderr).text()}`)
  return {
    fire: async () => {
      child.stdin.write("go\n")
      await child.stdin.flush()
      const answer = await reader.read()
      reader.releaseLock()
      if (answer.done) throw new Error(`powershell did not deny: ${await new Response(child.stderr).text()}`)
      await child.exited
    },
  }
}

// A lock's folder that a holder left behind an hour ago, with the files a holder writes.
async function staleLock(folder: string, files: number) {
  await fs.mkdir(folder)
  await Bun.write(path.join(folder, "meta.json"), "{}")
  await Promise.all(Array.from({ length: files }, (_, index) => Bun.write(path.join(folder, `f${index}`), "")))
  const old = new Date(Date.now() - 60 * 60_000)
  await fs.utimes(path.join(folder, "meta.json"), old, old)
  await fs.utimes(folder, old, old)
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false)

const deny = (dir: string) => icaclsRun(dir, "/deny", "*S-1-1-0:(AD)")
const restore = (dir: string) => icaclsRun(dir, "/remove:d", "*S-1-1-0")

const effectLayer = LayerNode.compile(EffectFlock.node, {
  replacements: [
    Global.node.replace(
      Global.layerWith({
        home: os.homedir(),
        data: os.tmpdir(),
        cache: os.tmpdir(),
        config: os.tmpdir(),
        state: os.tmpdir(),
        bin: os.tmpdir(),
        log: os.tmpdir(),
      }),
    ),
  ],
})

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

  // Each lock and each folder it makes while the denial lasts: the lock's own folder, and the breaker a contender makes
  // to take over a stale lock's folder (which exists, so its mkdir answers EEXIST and the breaker's mkdir answers EPERM).
  const locks = {
    Flock: (dir: string, timeoutMs: number) =>
      Flock.withLock("key", async () => "ran", { dir, timeoutMs, staleMs: 1_000, baseDelayMs: 20 }),
    EffectFlock: (dir: string, timeoutMs: number) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const flock = yield* EffectFlock.Service
          yield* flock.acquire("key", dir, { timeoutMs, staleMs: 1_000 })
          return "ran"
        }).pipe(Effect.scoped, Effect.provide(effectLayer)),
      ),
  }
  const failed = (error: NodeJS.ErrnoException) => `failed: ${error.code ?? error.message}`
  const stale = async (dir: string) => {
    const folder = path.join(dir, Hash.fast("key") + ".lock")
    await fs.mkdir(folder)
    const old = new Date(Date.now() - 60 * 60_000)
    await fs.utimes(folder, old, old)
  }

  test.skipIf(!deniable).each([
    ["Flock", "the lock's folder", false],
    ["Flock", "the breaker of a stale lock", true],
    ["EffectFlock", "the lock's folder", false],
    ["EffectFlock", "the breaker of a stale lock", true],
  ] as const)(
    "%s waits while the mkdir of %s answers EPERM",
    async (lock, _, breaker) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-mkdir-"))
      try {
        if (breaker) await stale(dir)
        await deny(dir)
        const lifted = Bun.sleep(500).then(() => restore(dir))
        const ran = await locks[lock](dir, 10_000).catch(failed)
        await lifted
        expect(ran).toBe("ran")
      } finally {
        await restore(dir).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test.skipIf(!deniable).each([
    ["Flock", "Timed out waiting for lock: key"],
    ["EffectFlock", "LockTimeoutError"],
  ] as const)("%s gives up on a denial that lasts with the lock's timeout error", async (lock, expected) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-mkdir-"))
    try {
      await deny(dir)
      // EffectFlock's error carries the key as a field rather than in its message.
      const answer = await locks[lock](dir, 300).catch(
        (error: Error) => `${error.name}: ${error.message} ${"key" in error ? `key=${error.key}` : ""}`,
      )
      expect(answer).toContain(expected)
      expect(answer).toMatch(/[ =]key\b/)
    } finally {
      await restore(dir).catch(() => {})
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // Only Windows answers EPERM for a folder whose deletion is pending. Elsewhere a mkdir that answers EPERM is refused for
  // good (a file system that holds no folders), and waiting out the lock's timeout, five minutes by default, would only
  // delay the error. The access list makes the EPERM here while the process reports another platform.
  test.skipIf(!deniable).each(["Flock", "EffectFlock"] as const)(
    "%s fails at once when mkdir answers EPERM on a system other than Windows",
    async (lock) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-mkdir-"))
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!
      try {
        await deny(dir)
        Object.defineProperty(process, "platform", { ...platform, value: "linux" })
        const started = performance.now()
        const answer = await locks[lock](dir, 10_000).catch((error: Error) => `${error.name}: ${error.message}`)
        expect(performance.now() - started).toBeLessThan(5_000)
        // The Effect file system names EPERM's failure Unknown.
        expect(answer).toMatch(/EPERM|Unknown: FileSystem\.makeDirectory/)
        expect(answer).not.toContain("Timed out")
      } finally {
        Object.defineProperty(process, "platform", platform)
        await restore(dir).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  // A stale lock is taken over by removing its folder and making it again. On Windows the new mkdir can answer EPERM
  // because the folder just removed is still pending deletion. The denial is put in place once the breaker exists, while
  // the removal of a folder that holds many files is still under way, so it reaches the second mkdir and not the first.
  test.skipIf(!deniable)(
    "Flock waits while the mkdir that makes a stale lock's folder again answers EPERM",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-mkdir-"))
      const folder = path.join(dir, Hash.fast("key") + ".lock")
      try {
        await staleLock(folder, 20_000)
        // Starting icacls takes longer than the removal, so a PowerShell that is already running puts the same denial in
        // place when it is told to.
        const denial = await armDenial(dir)
        const contender = locks.Flock(dir, 20_000).catch(failed)
        while (!(await exists(folder + ".breaker"))) await Bun.sleep(1)
        await denial.fire()
        // The removal is still running, so the denial reaches the mkdir that follows it.
        expect(await exists(folder)).toBe(true)
        const lifted = Bun.sleep(500).then(() => restore(dir))
        const ran = await contender
        await lifted
        expect(ran).toBe("ran")
      } finally {
        await restore(dir).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  // Removing a folder fails on Windows while another handle holds a file in it without sharing deletion (EBUSY). The
  // holder's release and a takeover of a stale lock both remove the lock's folder, so both wait for the handle.
  test.skipIf(process.platform !== "win32")(
    "Flock's release waits for a handle to a file in the lock's folder and then removes the folder",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-release-"))
      const folder = path.join(dir, Hash.fast("key") + ".lock")
      try {
        let held: { exited: Promise<number> } | undefined
        const ran = await Flock.withLock(
          "key",
          async () => {
            held = await hold(path.join(folder, "meta.json"), 800)
            return "ran"
          },
          { dir, timeoutMs: 10_000 },
        ).catch(failed)
        expect(ran).toBe("ran")
        expect(await held?.exited).toBe(0)
        expect(await exists(folder)).toBe(false)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test.skipIf(process.platform !== "win32")(
    "Flock's release gives up with the removal's error when the handle is never let go",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-release-"))
      const folder = path.join(dir, Hash.fast("key") + ".lock")
      try {
        let held: { exited: Promise<number> } | undefined
        let released = 0
        const ran = await Flock.withLock(
          "key",
          async () => {
            held = await hold(path.join(folder, "meta.json"), Flock.RELEASE_DEADLINE_MS + 3_000)
            released = performance.now()
            return "ran"
          },
          { dir, timeoutMs: 10_000 },
        ).catch(failed)
        expect(ran).toBe("failed: EBUSY")
        expect(performance.now() - released).toBeGreaterThanOrEqual(Flock.RELEASE_DEADLINE_MS - 500)
        await held?.exited
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  test.skipIf(process.platform !== "win32")(
    "Flock takes over a stale lock whose removal a handle to a file in it delays",
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-stale-"))
      const folder = path.join(dir, Hash.fast("key") + ".lock")
      try {
        await staleLock(folder, 0)
        const held = await hold(path.join(folder, "meta.json"), 800)
        expect(await locks.Flock(dir, 10_000).catch(failed)).toBe("ran")
        expect(await held.exited).toBe(0)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  // Only Windows lets a handle delay a removal for a moment; elsewhere a removal that fails is refused for good, and
  // waiting would only delay the error. The process reports another platform while the handle is held.
  test.skipIf(process.platform !== "win32").each(["release", "takeover"] as const)(
    "Flock fails at once when a %s's removal fails on a system other than Windows",
    async (step) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flock-held-"))
      const folder = path.join(dir, Hash.fast("key") + ".lock")
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!
      const holds: { exited: Promise<number> }[] = []
      try {
        if (step === "takeover") {
          await staleLock(folder, 0)
          holds.push(await hold(path.join(folder, "meta.json"), 3_000))
          Object.defineProperty(process, "platform", { ...platform, value: "linux" })
        }
        const started = performance.now()
        const answer = await Flock.withLock(
          "key",
          async () => {
            if (step === "release") {
              holds.push(await hold(path.join(folder, "meta.json"), 3_000))
              Object.defineProperty(process, "platform", { ...platform, value: "linux" })
            }
            return "ran"
          },
          { dir, timeoutMs: 10_000 },
        ).catch(failed)
        Object.defineProperty(process, "platform", platform)
        expect(answer).toBe("failed: EBUSY")
        expect(performance.now() - started).toBeLessThan(2_500)
      } finally {
        Object.defineProperty(process, "platform", platform)
        await Promise.all(holds.map((item) => item.exited))
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
