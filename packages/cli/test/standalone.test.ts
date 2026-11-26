import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Standalone } from "../src/services/standalone"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

test("standalone server exits when its owner is killed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-cli-standalone-"))
  const owner = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/standalone-owner.ts")], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { ORBIT_SERVER_USERNAME: "custom" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const line = await Promise.race([
    readLine(owner.stdout, "STANDALONE_READY "),
    Bun.sleep(10_000).then(() => undefined),
  ])
  const [, rawPID, url, status] = line?.split(" ") ?? []
  const pid = Number(rawPID)

  try {
    expect(pid).toBeGreaterThan(0)
    expect(url).toStartWith("http://127.0.0.1:")
    expect(status).toBe("200")
    expect(running(pid)).toBe(true)

    owner.kill("SIGKILL")
    await owner.exited

    expect(await waitForExit(pid)).toBe(true)
  } finally {
    owner.kill("SIGKILL")
    await owner.exited
    if (running(pid)) process.kill(pid, "SIGKILL")
    await fs.rm(root, { recursive: true, force: true })
  }
})

// A server that exits before it is ready, for example because orbit.db is still locked, says why on stderr: the error
// carries its exit code and the end of that output, escaped, so the cause reaches the person (class 13), not only
// "exited before reporting readiness".
test.each([
  ["says why", `console.error("Error: database is locked"); process.exit(3)`, "with code 3", "database is locked"],
  ["writes an escape sequence", `console.error("\\x1b[2Jcleared"); process.exit(4)`, "with code 4", "\\x1b[2Jcleared"],
  ["says nothing", `process.exit(5)`, "with code 5", "readiness"],
  // Only the end of a long output is kept: the cause is written last, and the message stays short.
  [
    "writes much before it says why",
    `console.error("x".repeat(5000)); console.error("Error: database is locked"); process.exit(6)`,
    "with code 6",
    "database is locked",
  ],
])(
  "the error of a standalone server that exits before it is ready and %s names its exit and output",
  async (_, script, exit, output) => {
    const error = await Effect.runPromise(
      Standalone.start({ command: [process.execPath, "-e", script] }).pipe(Effect.scoped, Effect.flip),
    )
    expect(error.message).toStartWith(`Standalone server exited ${exit} before reporting readiness`)
    expect(error.message).toEndWith(output)
    expect(error.message).not.toContain("\x1b")
    expect(error.message.length).toBeLessThan(2_100)
  },
  30_000,
)

// The end of a command stops its private server, which keeps running until then, so the reason a server gives for an
// early exit is neither needed nor waited for. That wait held the end of every `orb` command that starts a private server
// for six seconds, and Windows CI run 45762896450 stopped cli 5/6 when trust-doors.test.ts ran past three times its
// usual length. The servers here run until they are stopped, so the wait would last its whole five seconds.
const forever = "setInterval(() => {}, 1_000_000)"
test.each([
  [
    "once it is ready",
    `console.log(JSON.stringify({ url: "http://127.0.0.1:9" })); ${forever}`,
    (start: ReturnType<typeof Standalone.start>) => start.pipe(Effect.scoped, Effect.asVoid),
  ],
  [
    "before it is ready",
    forever,
    (start: ReturnType<typeof Standalone.start>) =>
      start.pipe(Effect.scoped, Effect.timeoutOption("300 millis"), Effect.asVoid),
  ],
])(
  "a command that stops its private server %s ends without waiting for the server's exit",
  async (_, script, run) => {
    const started = Date.now()
    await Effect.runPromise(run(Standalone.start({ command: [process.execPath, "-e", script] })))
    expect(Date.now() - started).toBeLessThan(5_000)
  },
  30_000,
)

async function readLine(stream: ReadableStream<Uint8Array>, prefix: string) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(decoder.decode(result.value, { stream: true }))
    const output = chunks.join("")
    const line = output.split("\n").find((line) => line.startsWith(prefix))
    if (line) {
      reader.releaseLock()
      return line
    }
  }
  reader.releaseLock()
  return (chunks.join("") + decoder.decode()).split("\n").find((line) => line.startsWith(prefix))
}

async function waitForExit(pid: number, attempts = 100): Promise<boolean> {
  if (!running(pid)) return true
  if (attempts === 0) return false
  await Bun.sleep(50)
  return waitForExit(pid, attempts - 1)
}

function running(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
