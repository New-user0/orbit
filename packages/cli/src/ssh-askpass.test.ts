import { expect, test } from "bun:test"
import { createServer } from "node:net"
import path from "node:path"
import { sharedTranspilerCache } from "../test/fixture/environment"
import { startSlot } from "../test/fixture/start-gate"

// The child runs src/index.ts from source, whose imports load the whole CLI before the askpass branch answers. On a loaded
// runner with no transpiler cache that start alone took longer than the test's 30 s. It now shares the run's transpiler
// cache and takes a start slot like every other `orb` the tests start, and its deadline measures the start, not the queue.
const START_DEADLINE = 60_000

test("the executable askpass branch returns only the response, without CLI output", async () => {
  const requests: string[] = []
  const server = createServer((socket) => {
    socket.once("data", (data: Buffer) => {
      requests.push(data.toString())
      socket.end(JSON.stringify({ value: 'passphrase"with spaces' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing listener")
  try {
    const run = await startSlot(async () => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "index.ts"), "Enter passphrase:"], {
        env: {
          ...process.env,
          ...sharedTranspilerCache(),
          ORBIT_SSH_ASKPASS_PORT: String(address.port),
          ORBIT_SSH_ASKPASS_TOKEN: "fixture",
          SSH_ASKPASS_PROMPT: "confirm",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: START_DEADLINE,
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, code }
    })
    expect(run.stdout).toBe('passphrase"with spaces\n')
    expect(run.code).toBe(0)
    expect(requests.map((request) => JSON.parse(request))).toEqual([
      { token: "fixture", text: "Enter passphrase:", confirm: true },
    ])
    expect(run.stderr).toBe("")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 180_000)
