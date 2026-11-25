import fs from "node:fs"
import path from "node:path"

// Every `orb` child process the tests start runs src/index.ts from source, which costs a few seconds of CPU before it
// answers its first request. Files that start many at once (the ACP approval matrix runs up to --max-concurrency rows
// per file, and a CI job runs two such files in its two workers) leave a small runner with more starting processes than
// cores, so each one takes several times longer and a fixed wait for the first answer runs out although nothing is
// wrong. The gate lets only a few processes start at a time: a caller takes a slot, waits for its child's first answer,
// and releases the slot, so its deadline measures the start and not the queue. It changes no assertion; it only orders
// the starts.
//
// Under the test runner (tools/test/watchdog.ts sets ORBIT_TEST_START_SLOTS to a fresh folder for each run), the slots
// are files in that folder, so every worker of the run shares them and a CI job admits ORBIT_TEST_STARTS (3) starts in
// all. Without the runner each process keeps its own count.
export async function startSlot<T>(run: () => Promise<T>) {
  const release = await takeStartSlot()
  try {
    return await run()
  } finally {
    release()
  }
}

let running = 0
const queue: Array<() => void> = []

/** Waits for a start slot and returns the function that gives it back. */
export async function takeStartSlot() {
  const limit = Math.max(1, Number(process.env.ORBIT_TEST_STARTS) || 3)
  const folder = process.env.ORBIT_TEST_START_SLOTS
  if (folder) return takeShared(folder, limit)
  if (running >= limit) await new Promise<void>((resolve) => queue.push(resolve))
  else running++
  return () => {
    // Hand the slot straight to the next waiter, so `running` stays at the limit while the queue is not empty.
    const next = queue.shift()
    if (next) next()
    else running--
  }
}

async function takeShared(folder: string, limit: number) {
  const slots = Array.from({ length: limit }, (_, index) => path.join(folder, String(index)))
  for (;;) {
    const file = slots.find(claim)
    if (file) return () => fs.rmSync(file, { force: true })
    await Bun.sleep(100)
  }
}

// A slot is a file that names the process holding it, created only if it does not exist yet. A slot whose holder has
// exited (a worker that ended while its start was still waiting) is removed so the next look can take it.
function claim(file: string) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" })
    return true
  } catch (error) {
    if (!held(error)) throw error
    if (holderGone(file)) fs.rmSync(file, { force: true })
    return false
  }
}

/** Whether creating a slot failed because it is held: it exists, or on Windows its holder has removed it while another
 * process still reads it (the deletion is pending, and Windows answers EPERM until the reader closes it). */
export function held(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "EEXIST" || (code === "EPERM" && process.platform === "win32")
}

function holderGone(file: string) {
  const pid = Number(readHolder(file))
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

// The slot may be released, or still being written, while it is read.
function readHolder(file: string) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
