import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { RipgrepBinary } from "@orbit/core/ripgrep/binary"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(RipgrepBinary.node))

describe("RipgrepBinary", () => {
  it.live("takes ripgrep from PATH, never from the folder Orbit starts in", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const name = process.platform === "win32" ? "rg.exe" : "rg"
      const here = path.join(tmp.path, "here")
      const bin = path.join(tmp.path, "bin")
      yield* Effect.promise(() =>
        Promise.all(
          [here, bin].map(async (directory) => {
            await fs.mkdir(directory)
            await fs.writeFile(path.join(directory, name), "", { mode: 0o755 })
          }),
        ),
      )
      const binary = yield* RipgrepBinary.Service

      // The path is looked up on first use, from the folder the process is in, so run the lookup there.
      const found = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          const before = { directory: process.cwd(), path: process.env.PATH ?? "" }
          process.chdir(here)
          process.env.PATH = bin
          return before
        }),
        () => binary.filepath,
        (before) =>
          Effect.sync(() => {
            process.chdir(before.directory)
            process.env.PATH = before.path
          }),
      )

      expect(found.toLowerCase()).toBe(path.join(bin, name).toLowerCase())
    }),
  )
})
