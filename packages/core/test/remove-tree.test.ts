import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { removeTree } from "./fixture/remove-tree"

// The removal every test cleanup uses (test-cleanup-hygiene.test.ts): Bun's fs.rm ignores retries, and on Windows a
// program the test ran can hold a file in the folder for a moment after it exits.
const powershell = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

// A process that opens `file` without delete sharing, as SQLite opens its database, until `ms` have passed.
async function hold(file: string, ms: number) {
  const child = Bun.spawn(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$h = [System.IO.File]::Open('${file}', 'Open', 'Read', 'None'); Write-Output held; Start-Sleep -Milliseconds ${ms}; $h.Close()`,
    ],
    { stdout: "pipe", stderr: "inherit" },
  )
  const reader = child.stdout.getReader()
  await reader.read()
  reader.releaseLock()
  return child
}

async function folder() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-remove-tree-"))
  await fs.mkdir(path.join(dir, "nested"))
  await Bun.write(path.join(dir, "nested", "orbit.db"), "data")
  return dir
}

test("removes a folder and what it holds", async () => {
  const dir = await folder()
  await removeTree(dir)
  expect(await fs.exists(dir)).toBe(false)
})

test.skipIf(process.platform !== "win32")("waits for a process that holds a file in the folder and then removes it", async () => {
  const dir = await folder()
  const holder = await hold(path.join(dir, "nested", "orbit.db"), 500)
  // The control: a plain removal fails while the file is held.
  expect(await fs.rm(dir, { recursive: true, force: true }).then(() => "removed", (error) => error.code)).toBe("EBUSY")
  await removeTree(dir)
  expect(await fs.exists(dir)).toBe(false)
  await holder.exited
}, 30_000)

test.skipIf(process.platform !== "win32")("fails at its deadline and names the holder that the test started", async () => {
  const dir = await folder()
  const holder = await hold(path.join(dir, "nested", "orbit.db"), 20_000)
  try {
    const error = await removeTree(dir, { deadline: 300, parents: [process.pid] }).then(
      () => undefined,
      (error: Error) => error,
    )
    expect(error?.message).toContain(`${dir} could not be removed within 0.3 s (EBUSY)`)
    expect(error?.message).toContain(`${holder.pid} `)
  } finally {
    holder.kill()
    await holder.exited
    await removeTree(dir)
  }
}, 60_000)
