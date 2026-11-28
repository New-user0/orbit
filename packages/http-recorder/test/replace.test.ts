import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { Interaction } from "../src/cassette/model"
import { REPLACE_DEADLINE_MS, Service } from "../src/cassette/store"
import { readCassette, runFileCassette, seedCassetteDirectory, tempDirectory } from "./support"

// An append writes the whole cassette by renaming a temporary file over it. On Windows that rename fails while another
// handle has the cassette open, so the append waits for the reader and lands; one that never lets go still fails it.
const interaction = (body: string): Interaction => ({
  transport: "http",
  request: { method: "GET", url: "https://example.test", headers: {}, body: "" },
  response: { status: 200, headers: {}, body },
})

const append = (directory: string, body: string) =>
  runFileCassette(
    directory,
    Effect.gen(function* () {
      const cassette = yield* Service
      yield* cassette.append("held", interaction(body))
    }),
  )

describe("appending to a cassette that a reader has open", () => {
  test("waits for the reader and lands", async () => {
    using directory = tempDirectory("http-recorder-held-")
    await seedCassetteDirectory(directory.path, "held", [interaction("first")])
    const file = path.join(directory.path, "held.json")
    const reader = await fs.open(file, "r")
    const released = Bun.sleep(300).then(() => reader.close())
    const answer = await append(directory.path, "second").then(() => "appended", (error) => `failed: ${error}`)
    await released
    expect(answer).toBe("appended")
    expect(readCassette(file).interactions.map((item) => (item.transport === "http" ? item.response.body : ""))).toEqual(["second"])
    expect(await fs.readdir(directory.path)).toEqual(["held.json"])
  }, 30_000)

  test.skipIf(process.platform !== "win32")(
    "gives up with the rename's error when the reader never lets go",
    async () => {
      using directory = tempDirectory("http-recorder-held-")
      await seedCassetteDirectory(directory.path, "held", [interaction("first")])
      const reader = await fs.open(path.join(directory.path, "held.json"), "r")
      try {
        const started = performance.now()
        const answer = await append(directory.path, "second").then(() => "appended", (error) => String(error))
        const elapsed = performance.now() - started
        expect(answer).not.toBe("appended")
        expect(elapsed).toBeGreaterThanOrEqual(REPLACE_DEADLINE_MS - 300)
        expect(elapsed).toBeLessThan(REPLACE_DEADLINE_MS + 2_000)
      } finally {
        await reader.close()
      }
    },
    30_000,
  )

  // Only Windows holds a renamed-over file for its readers; elsewhere the same codes are a lasting refusal.
  test.skipIf(process.platform !== "win32")("fails at once on a system other than Windows", async () => {
    using directory = tempDirectory("http-recorder-held-")
    await seedCassetteDirectory(directory.path, "held", [interaction("first")])
    const reader = await fs.open(path.join(directory.path, "held.json"), "r")
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "linux" })
      const started = performance.now()
      const answer = await append(directory.path, "second").then(() => "appended", (error) => String(error))
      Object.defineProperty(process, "platform", platform)
      expect(answer).not.toBe("appended")
      expect(performance.now() - started).toBeLessThan(1_000)
    } finally {
      Object.defineProperty(process, "platform", platform)
      await reader.close()
    }
  }, 30_000)
})
