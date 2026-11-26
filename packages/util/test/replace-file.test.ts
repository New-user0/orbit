import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { DEADLINE_MS, replaceFile, replaceFileEffect } from "../src/replace-file.js"
import { held } from "../src/replace-file-plain.js"

// On Windows a rename over a file that another handle has open fails until that handle closes, and every reader holds
// one for a moment. tui/test/util/persistence.test.ts pins the session-tabs writer; these rows pin the helper itself and
// that each writer that replaces a file by rename goes through it.
const replacers = {
  replaceFile: (from: string, to: string) => replaceFile(from, to),
  replaceFileEffect: (from: string, to: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* replaceFileEffect(fs, from, to)
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    ),
}

// Another process that opens `file` for reading, says so, and closes it after `ms`.
async function holdElsewhere(file: string, ms: number) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const fs = require("node:fs")
const fd = fs.openSync(${JSON.stringify(file)}, "r")
console.log("held")
setTimeout(() => fs.closeSync(fd), ${ms})`,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  )
  const reader = child.stdout.getReader()
  await reader.read()
  reader.releaseLock()
  return child
}

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-replace-file-"))
  const target = path.join(dir, "target.json")
  const temporary = path.join(dir, "target.json.tmp")
  await fs.writeFile(target, "old")
  await fs.writeFile(temporary, "new")
  return { dir, target, temporary, [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true, force: true }) }
}

const failed = (error: NodeJS.ErrnoException) => `failed: ${error.code ?? error.message}`

describe("replacing a file by rename", () => {
  test.each(Object.keys(replacers) as Array<keyof typeof replacers>)(
    "%s waits for a reader that still has the target open and lands",
    async (name) => {
      await using files = await scratch()
      const reader = await holdElsewhere(files.target, 300)
      const answer = await replacers[name](files.temporary, files.target).then(() => "replaced", failed)
      await reader.exited
      expect(answer).toBe("replaced")
      expect(await fs.readFile(files.target, "utf8")).toBe("new")
      expect(await fs.readdir(files.dir)).toEqual(["target.json"])
    },
    30_000,
  )

  // A reader that never lets go still fails the write, with the rename's own error, once the deadline passes.
  test.skipIf(process.platform !== "win32").each(Object.keys(replacers) as Array<keyof typeof replacers>)(
    "%s gives up with the rename's error when the reader never lets go",
    async (name) => {
      await using files = await scratch()
      const reader = await fs.open(files.target, "r")
      try {
        const started = performance.now()
        const answer = await replacers[name](files.temporary, files.target).then(() => "replaced", (error) =>
          String(error),
        )
        // The Effect file system names EPERM's failure Unknown.
        expect(answer).toMatch(/EPERM|Unknown: FileSystem\.rename/)
        const elapsed = performance.now() - started
        expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 300)
        expect(elapsed).toBeLessThan(DEADLINE_MS + 2_000)
      } finally {
        await reader.close()
      }
    },
    30_000,
  )

  // Only Windows holds a renamed-over file for its readers, so elsewhere the same codes mean a lasting refusal (a folder
  // the account cannot write, a mount point) that waiting would only delay. The refusal is made here by a Windows reader
  // while the process reports another platform: it changes nothing else the helper reads.
  test.skipIf(process.platform !== "win32").each(Object.keys(replacers) as Array<keyof typeof replacers>)(
    "%s fails at once on a refused rename on a system other than Windows",
    async (name) => {
      await using files = await scratch()
      const reader = await fs.open(files.target, "r")
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!
      Object.defineProperty(process, "platform", { ...platform, value: "linux" })
      try {
        const started = performance.now()
        const answer = await replacers[name](files.temporary, files.target).then(() => "replaced", (error) =>
          String(error),
        )
        expect(answer).toMatch(/EPERM|Unknown: FileSystem\.rename/)
        expect(performance.now() - started).toBeLessThan(1_000)
      } finally {
        Object.defineProperty(process, "platform", platform)
        await reader.close()
      }
    },
    30_000,
  )

  // Which refusals a replace waits out. A reader on Windows makes the rename answer EPERM or EACCES, and a handle that
  // is still closing EBUSY; any other error, and any refusal elsewhere, is the answer.
  test.each([
    ["EPERM", true],
    ["EACCES", true],
    ["EBUSY", true],
    ["ENOENT", false],
    ["EEXIST", false],
    [undefined, false],
  ] as const)("a rename refused with %s waits on Windows: %p", (refusal, waits) => {
    expect(held(refusal)).toBe(process.platform === "win32" && waits)
  })

  test.each(Object.keys(replacers) as Array<keyof typeof replacers>)(
    "%s fails at once on an error a reader does not cause",
    async (name) => {
      await using files = await scratch()
      const started = performance.now()
      const answer = await replacers[name](path.join(files.dir, "missing.tmp"), files.target).then(
        () => "replaced",
        (error) => String(error),
      )
      expect(answer).toMatch(/ENOENT|NotFound/)
      expect(performance.now() - started).toBeLessThan(1_000)
    },
  )
})

// Every writer that writes a file whole by renaming a temporary file over it. The background service's registration and
// config are read by clients while they are replaced; the TUI's state files by another TUI; the config files by a
// reload. A rename that is not one of these replaces a running program or a folder: see the notes beside each.
const writers = [
  ["tui/src/util/persistence.ts", "replaceFile("],
  ["cli/src/commands/handlers/plugin/add.ts", "replaceFile("],
  ["cli/src/commands/handlers/plugin/remove.ts", "replaceFile("],
  ["cli/src/config/config.ts", "replaceFileEffect("],
  ["cli/src/config/migrate.ts", "replaceFileEffect("],
  ["cli/src/services/service-config.ts", "replaceFileEffect("],
  ["cli/src/services/service-registration.ts", "replaceFileEffect("],
  ["vscode/src/ide-bridge.ts", "replaceFile("],
] as const

test.each(writers)("%s replaces its file through the helper", async (file, call) => {
  const source = await fs.readFile(path.join(import.meta.dir, "../..", file), "utf8")
  expect(source).toContain(call)
  expect(source).not.toMatch(/(?<![\w.])rename(Sync)?\(|fs\.rename(Sync)?\(/)
})
