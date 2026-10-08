import { mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import type { ThemeSource } from "../../src/context/theme"

export const emptyThemeSource: ThemeSource = { discover: () => Promise.resolve({}) }

export async function tmpdir() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "orbit-tui-test-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await remove(directory)
    },
  }
}

// Bun's rm ignores maxRetries, and a SQLite handle that has just closed can hold its file for a moment on Windows.
async function remove(directory: string, retries = 30): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !(error instanceof Error) || !("code" in error) || error.code !== "EBUSY") throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(directory, retries - 1)
  }
}
