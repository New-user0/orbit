// Preloaded into every file a parallel `bun test` worker runs (tools/test/args.ts passes it). Each worker appends
// `<ms> start <file>` when a file loads and `<ms> end <file>` when its tests are done, to a file named after its pid in
// the folder the runner gives in ORBIT_TEST_HEARTBEAT, so the runner's watchdog (tools/test/watchdog.ts) can tell
// which file a worker is in and since when. The writes are synchronous: a worker that blocks right after has already
// written its line.
import { afterAll } from "bun:test"
import { appendFileSync } from "node:fs"
import path from "node:path"

const folder = process.env.ORBIT_TEST_HEARTBEAT
if (folder) {
  const log = path.join(folder, String(process.pid))
  appendFileSync(log, `${Date.now()} start ${Bun.main}\n`)
  afterAll(() => appendFileSync(log, `${Date.now()} end ${Bun.main}\n`))
}
