import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeJsonAtomic } from "../../src/util/persistence"

// writeJsonAtomic writes a temporary file and renames it over the target. On Windows a rename over a file that any other
// handle has open answers EPERM, and every reader opens one: another TUI loading tabs.json, a reload, a test polling it.
// The write then failed: the GitHub Windows tui jobs of PR #156 and of `durable-reminders` run 40101696021 failed
// `stores session tabs for the current working directory by default` with EPERM on rename. A reader that lets go a
// moment later must not cost the write.
test("a write over a file that a reader still has open waits for the reader and lands", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tui-persistence-"))
  try {
    const file = path.join(dir, "tabs.json")
    await fs.writeFile(file, JSON.stringify({ tabs: ["old"] }))
    const reader = await fs.open(file, "r")
    const released = Bun.sleep(300).then(() => reader.close())
    const written = await writeJsonAtomic(file, { tabs: ["new"] }).then(
      () => "written",
      (error: NodeJS.ErrnoException) => `failed: ${error.code ?? error.message}`,
    )
    await released
    expect(written).toBe("written")
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ tabs: ["new"] })
    // Nothing is left behind: the temporary file was renamed, not abandoned.
    expect(await fs.readdir(dir)).toEqual(["tabs.json"])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a write with no reader lands at once: the control for the row above", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tui-persistence-"))
  try {
    const file = path.join(dir, "tabs.json")
    await fs.writeFile(file, JSON.stringify({ tabs: ["old"] }))
    await writeJsonAtomic(file, { tabs: ["new"] })
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ tabs: ["new"] })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
