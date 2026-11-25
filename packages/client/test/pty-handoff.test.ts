import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PtyHandoff } from "../src/pty-handoff"
import { DEADLINE_MS } from "../src/replace-file"

// The ticket a replacement leaves for the next service is written by renaming a temporary file over the sidecar, while
// every contender reads that sidecar. On Windows the rename fails as long as a reader has the sidecar open, so the
// write waits for the reader and lands; a reader that never lets go still fails it with the rename's error.
//
// A service that answers 404 to the hand-off and shutdown routes is one that cannot hand terminals off, and `prepare`
// then publishes a ticket with no hand-off for it.
async function scenario() {
  const server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-pty-handoff-"))
  const file = path.join(dir, "service.json")
  const info = { id: "next", pid: 1, url: `http://127.0.0.1:${server.port}` }
  // A ticket an earlier replacement left for another service, which `prepare` writes over.
  await Bun.write(
    file + ".pty-handoff",
    JSON.stringify({ source: { id: "earlier", pid: 2, url: info.url }, handoff: null, expiresAt: Date.now() + 60_000 }),
  )
  return {
    file,
    info,
    dir,
    [Symbol.asyncDispose]: async () => {
      server.stop(true)
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

const sidecar = async (file: string) => JSON.parse(await fs.readFile(file + ".pty-handoff", "utf8"))
const quiet = <A>(run: () => Promise<A>) => {
  const warn = console.warn
  console.warn = () => {}
  return run().finally(() => {
    console.warn = warn
  })
}

describe("PtyHandoff.prepare writing the ticket over one a reader has open", () => {
  test("waits for the reader and lands", async () => {
    await using setup = await scenario()
    const reader = await fs.open(setup.file + ".pty-handoff", "r")
    const released = Bun.sleep(300).then(() => reader.close())
    const answer = await quiet(() => PtyHandoff.prepare(setup.file, setup.info, 5_000)).then(
      () => "written",
      (error: Error) => `failed: ${error.message}`,
    )
    await released
    expect(answer).toBe("written")
    expect((await sidecar(setup.file)).source.id).toBe("next")
    expect(await fs.readdir(setup.dir)).toEqual(["service.json.pty-handoff"])
  }, 30_000)

  test.skipIf(process.platform !== "win32")(
    "gives up with the rename's error when the reader never lets go",
    async () => {
      await using setup = await scenario()
      const reader = await fs.open(setup.file + ".pty-handoff", "r")
      try {
        const started = performance.now()
        const answer = await quiet(() => PtyHandoff.prepare(setup.file, setup.info, 5_000)).then(
          () => "written",
          (error: NodeJS.ErrnoException) => `failed: ${error.code}`,
        )
        const elapsed = performance.now() - started
        expect(answer).toBe("failed: EPERM")
        expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 300)
        expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000)
      } finally {
        await reader.close()
      }
    },
    30_000,
  )

  // Only Windows holds a renamed-over file for its readers; elsewhere the same codes are a lasting refusal.
  test.skipIf(process.platform !== "win32")("fails at once on a system other than Windows", async () => {
    await using setup = await scenario()
    const reader = await fs.open(setup.file + ".pty-handoff", "r")
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" })
      const started = performance.now()
      const answer = await quiet(() => PtyHandoff.prepare(setup.file, setup.info, 5_000)).then(
        () => "written",
        (error: NodeJS.ErrnoException) => `failed: ${error.code}`,
      )
      Object.defineProperty(process, "platform", platform)
      expect(answer).toBe("failed: EPERM")
      expect(performance.now() - started).toBeLessThan(1_000)
    } finally {
      Object.defineProperty(process, "platform", platform)
      await reader.close()
    }
  }, 30_000)
})
