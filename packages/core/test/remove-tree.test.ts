import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { currentDirectoryOnPath, plant } from "./fixture/decoy"
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
    // The holder's parent is this process, which is whom a removal names when the caller does not say.
    const error = await removeTree(dir, { deadline: 300 }).then(
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

// The cause, kept as a row: Bun's rm takes `maxRetries` and does not retry, so it fails at once while a handle is open.
// The options are built apart from the call on purpose: test-cleanup-hygiene.test.ts refuses them in any other cleanup.
test.skipIf(process.platform !== "win32")(
  "Bun's rm fails at once on a file that is still held, whatever maxRetries says (Windows)",
  async () => {
    const dir = await folder()
    const holder = await hold(path.join(dir, "nested", "orbit.db"), 3_000)
    const ignored = { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }
    const started = Date.now()
    const error = await fs.rm(dir, ignored).then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    )
    expect({ code: error?.code, quick: Date.now() - started < 1_000 }).toEqual({ code: "EBUSY", quick: true })
    await holder.exited
    await removeTree(dir)
  },
  60_000,
)

// Class 10: the holder list starts PowerShell by its full path. A bare name is looked up, and a working folder that
// PATH names (or, for a program that Windows itself looks up, any working folder) would supply its own powershell.exe,
// which would run instead and leave the list empty. Bun.spawn looks a bare name up on PATH only, so this row puts the
// working folder first on PATH.
test.skipIf(process.platform !== "win32")(
  "listing what holds the folder starts no powershell.exe from the working folder, even when PATH names it (Windows)",
  async () => {
    const dir = await folder()
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-remove-tree-decoy-"))
    using _ = currentDirectoryOnPath()
    const ran = await plant(work, "powershell")
    const holder = await hold(path.join(dir, "nested", "orbit.db"), 30_000)
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { removeTree } from ${JSON.stringify(path.join(import.meta.dir, "fixture", "remove-tree.ts"))}
const error = await removeTree(${JSON.stringify(dir)}, { deadline: 500, parents: [${process.pid}] }).then(() => undefined, (error) => error)
console.log(error?.message ?? "removed")`,
      ],
      {
        cwd: work,
        // Windows spells the variable as it likes (`Path`), so the one that is there is replaced.
        env: { ...process.env, [pathKey]: `${work}${path.delimiter}${process.env[pathKey] ?? ""}` },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
      },
    )
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    holder.kill()
    await holder.exited
    const started = await ran()
    await removeTree(dir)
    await removeTree(work)
    expect(code).toBe(0)
    expect(started).toEqual([])
    expect(output).toContain(`${dir} could not be removed within 0.5 s (EBUSY)`)
    expect(output).toContain(`${holder.pid} `)
  },
  90_000,
)

test("an error that no holder causes fails at once", async () => {
  const started = Date.now()
  const error = await removeTree(path.join(os.tmpdir(), "bad\0name"), { deadline: 20_000 }).then(
    () => undefined,
    (error: Error) => error,
  )
  expect(error?.message).toContain("could not be removed")
  expect(Date.now() - started).toBeLessThan(5_000)
})
