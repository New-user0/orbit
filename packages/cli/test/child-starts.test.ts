import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { approval } from "./acp/approval-harness"
import { isolatedEnv } from "./fixture/environment"
import { held, startSlot, takeStartSlot } from "./fixture/start-gate"

// How the cli tests start `orb` children from source. The start gate (fixture/start-gate.ts) limits how many start at
// once. A CI job runs its files in two workers, and two files of the ACP approval matrix in one job used to start twice
// the gate's limit at once, which a 4-core runner could not start within the first answer's deadline. These rows pin
// that the runner's workers share one set of slots, that a slot left by a worker that exited is taken again, that an
// approval row starts its child only once it holds a slot, and that every child shares the run's transpiler cache
// instead of transpiling the source tree again.

const gate = path.join(import.meta.dir, "fixture", "start-gate.ts")

async function slots() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-start-gate-"))
  return { path: folder, [Symbol.asyncDispose]: () => fs.rm(folder, { recursive: true, force: true }) }
}

// Runs `body` with the gate pointed at `folder` and limited to `limit`; the gate reads both when a slot is taken.
async function withGate<T>(folder: string | undefined, limit: number, body: () => Promise<T>) {
  const previous = { folder: process.env.ORBIT_TEST_START_SLOTS, limit: process.env.ORBIT_TEST_STARTS }
  restore("ORBIT_TEST_START_SLOTS", folder)
  process.env.ORBIT_TEST_STARTS = String(limit)
  try {
    return await body()
  } finally {
    restore("ORBIT_TEST_START_SLOTS", previous.folder)
    restore("ORBIT_TEST_STARTS", previous.limit)
  }
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const within = <T>(ms: number, work: Promise<T>) => Promise.race([work, Bun.sleep(ms).then(() => undefined)])

describe("the start gate", () => {
  test(
    "the workers of one run share its slots: two processes together start no more than the limit at once",
    async () => {
      await using folder = await slots()
      const log = path.join(folder.path, "..", `${path.basename(folder.path)}.log`)
      // Each stand-in worker takes six slots at once from the same moment on and holds each for 400 ms.
      const worker = [
        `import { appendFileSync } from "node:fs"`,
        `import { startSlot } from ${JSON.stringify(gate)}`,
        `await Bun.sleep(Number(process.env.GO) - Date.now())`,
        `await Promise.all(Array.from({ length: 6 }, () => startSlot(async () => {`,
        `  appendFileSync(${JSON.stringify(log)}, "+\\n")`,
        `  await Bun.sleep(400)`,
        `  appendFileSync(${JSON.stringify(log)}, "-\\n")`,
        `})))`,
      ].join("\n")
      // The gate's own limit, three, applies when ORBIT_TEST_STARTS is not set.
      const env = { ...process.env, ORBIT_TEST_START_SLOTS: folder.path, ORBIT_TEST_STARTS: undefined, GO: String(Date.now() + 2_000) }
      const codes = await Promise.all(
        [1, 2].map(
          () => Bun.spawn([process.execPath, "-e", worker], { env, stdin: "ignore", stdout: "ignore", stderr: "inherit" }).exited,
        ),
      )
      const lines = (await Bun.file(log).text()).trim().split("\n")
      await fs.rm(log, { force: true })
      expect(codes).toEqual([0, 0])
      expect(lines.filter((line) => line === "+")).toHaveLength(12)
      // The most starts held at once: each worker alone would hold three, so both at once would show six.
      const most = lines.reduce(
        (state, line) => {
          const now = state.now + (line === "+" ? 1 : -1)
          return { now, most: Math.max(state.most, now) }
        },
        { now: 0, most: 0 },
      ).most
      expect(most).toBe(3)
      // Every slot was given back.
      expect(await fs.readdir(folder.path)).toEqual([])
    },
    60_000,
  )

  test("without the runner's folder a process keeps its own count, and a waiter takes the slot given back", async () => {
    const events: string[] = []
    const hold = (name: string) =>
      startSlot(async () => {
        events.push(`+${name}`)
        await Bun.sleep(100)
        events.push(`-${name}`)
      })
    await withGate(undefined, 2, () => Promise.all(["a", "b", "c", "d"].map(hold)))
    // Two at a time: c starts only when a slot is given back, and d after the next.
    expect(events.slice(0, 2)).toEqual(["+a", "+b"])
    expect(events.indexOf("+c")).toBeGreaterThan(events.indexOf("-a"))
    expect(events.indexOf("+d")).toBeGreaterThan(events.indexOf("-b"))
    expect(events).toHaveLength(8)
  })

  test("a slot that exists, or on Windows one whose deletion is pending (EPERM), is held; other errors are not", () => {
    const failure = (code: string) => Object.assign(new Error(code), { code })
    expect(held(failure("EEXIST"))).toBe(true)
    expect(held(failure("EPERM"))).toBe(process.platform === "win32")
    expect(held(failure("ENOENT"))).toBe(false)
    expect(held(failure("EACCES"))).toBe(false)
    expect(held(undefined)).toBe(false)
  })

  test("takes a slot whose holder has exited, and waits while its holder lives", async () => {
    await using folder = await slots()
    const gone = Bun.spawn([process.execPath, "-e", "0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    await gone.exited
    await withGate(folder.path, 1, async () => {
      await Bun.write(path.join(folder.path, "0"), String(gone.pid))
      const release = await within(5_000, takeStartSlot())
      expect(release).toBeFunction()
      expect(await Bun.file(path.join(folder.path, "0")).text()).toBe(String(process.pid))
      release?.()
      expect(await fs.readdir(folder.path)).toEqual([])
      // Control: a slot that a live process holds is not taken until it is given back.
      await Bun.write(path.join(folder.path, "0"), String(process.pid))
      const waiting = takeStartSlot()
      expect(await within(1_000, waiting)).toBeUndefined()
      await fs.rm(path.join(folder.path, "0"))
      const taken = await within(5_000, waiting)
      expect(taken).toBeFunction()
      taken?.()
    })
  })

  test(
    "an ACP approval row starts its `orb acp` child only once it holds a slot",
    async () => {
      await using folder = await slots()
      await withGate(folder.path, 1, async () => {
        // The only slot is held, so the row must wait before it starts its child.
        await Bun.write(path.join(folder.path, "0"), String(process.pid))
        const roots: string[] = []
        const row = approval(
          {
            tool: "Read",
            args: () => ({ filePath: "notes.txt" }),
            setup: async (root) => {
              roots.push(root)
            },
          },
          () => {},
        )
        while (roots.length === 0) await Bun.sleep(50)
        await Bun.sleep(4_000)
        // A started child creates orb's own cache folder (its XDG_CACHE_HOME, `cache`) within a second. Bun's
        // transpiler cache goes to the run's shared ORBIT_TEST_TRANSPILER_CACHE folder, not here.
        expect(await fs.readdir(roots[0]!)).not.toContain("cache")
        // Given the slot, the row starts its child, which answers, refuses the untrusted folder, and gives the slot back.
        await fs.rm(path.join(folder.path, "0"))
        await row
        expect(await fs.readdir(folder.path)).toEqual([])
      })
    },
    120_000,
  )
})

describe("the transpiler cache of an `orb` child", () => {
  test(
    "is the run's shared cache, not one in the child's own cache folder",
    async () => {
      await using root = await slots()
      await using shared = await slots()
      const previous = process.env.ORBIT_TEST_TRANSPILER_CACHE
      process.env.ORBIT_TEST_TRANSPILER_CACHE = shared.path
      const env = isolatedEnv(root.path)
      restore("ORBIT_TEST_TRANSPILER_CACHE", previous)
      const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--version"], {
        cwd: path.join(import.meta.dir, ".."),
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      expect(stdout.trim()).not.toBe("")
      expect((await fs.readdir(shared.path)).length).toBeGreaterThan(0)
      expect(await fs.readdir(path.join(root.path, "cache", "bun")).catch(() => [])).toEqual([])
    },
    60_000,
  )
})
