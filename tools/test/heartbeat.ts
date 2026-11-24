// Preloaded into every file a parallel `bun test` worker runs (tools/test/args.ts passes it, and the runner in
// tools/test/watchdog.ts sets ORBIT_TEST_HEARTBEAT). Each worker appends `<ms> start <file>` when a file loads and
// `<ms> end <file>` when its tests are done, to a file named after its pid in that folder, so the watchdog can tell which
// file a worker is in and since when. The writes are synchronous: a worker that blocks right after has already written
// its line.
import { afterAll } from "bun:test"
import { appendFileSync } from "node:fs"
import path from "node:path"

const log = path.join(process.env.ORBIT_TEST_HEARTBEAT!, String(process.pid))
appendFileSync(log, `${Date.now()} start ${Bun.main}\n`)
afterAll(() => appendFileSync(log, `${Date.now()} end ${Bun.main}\n`))
