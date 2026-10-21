import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Ripgrep } from "@orbit/core/ripgrep"
import { RipgrepBinary } from "@orbit/core/ripgrep/binary"
import { Global } from "@orbit/util/global"
import { which } from "@orbit/util/which"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it, testEffect } from "./lib/effect"

const lookup = testEffect(AppNodeBuilder.build(RipgrepBinary.node))
const executable = process.platform === "win32" ? "rg.exe" : "rg"

describe("RipgrepBinary", () => {
  lookup.live("takes ripgrep from PATH, never from the folder Orbit starts in", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const here = path.join(tmp.path, "here")
      const bin = path.join(tmp.path, "bin")
      yield* Effect.promise(() =>
        Promise.all(
          [here, bin].map(async (directory) => {
            await fs.mkdir(directory)
            await fs.writeFile(path.join(directory, executable), "", { mode: 0o755 })
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

      expect(found.toLowerCase()).toBe(path.join(bin, executable).toLowerCase())
    }),
  )
})

// Each row is one place a host can keep ripgrep. A search either runs the copy it finds or fails with the lookup's own
// message, which says where to put ripgrep; a missing ripgrep is never reported as a bare execution failure.
const hosts: Array<{
  name: string
  // Folders under the row's temporary root that get a copy of the installed ripgrep.
  copies: string[]
  // What PATH lists: folders under the root, or `.` kept relative.
  path: string[]
  quote?: boolean
  found: boolean
}> = [
  { name: "an absolute PATH entry", copies: ["tools"], path: ["tools"], found: true },
  // Package managers on Windows put a shim in one shared folder, and a PATH entry there may be quoted.
  {
    name: "a package manager's shim folder, quoted and with a space",
    copies: ["Program Data/manager/bin"],
    path: ["Program Data/manager/bin"],
    quote: process.platform === "win32",
    found: true,
  },
  { name: "Orbit's own bin folder", copies: ["orbit-bin"], path: ["empty"], found: true },
  { name: "no folder at all", copies: [], path: ["empty"], found: false },
  { name: "only the folder Orbit starts in, named by a relative PATH entry", copies: ["work"], path: ["."], found: false },
]

describe("Ripgrep on each host shape", () => {
  const installed = which(executable)

  for (const host of hosts) {
    it.live(`${host.found ? "runs" : "names the missing"} ripgrep with ${host.name}`, () =>
      Effect.gen(function* () {
        // The rows copy a real ripgrep, so the host running the tests must have one on PATH.
        expect(installed).not.toBeNull()
        const tmp = yield* tmpdirScoped()
        const work = path.join(tmp.path, "work")
        const bin = path.join(tmp.path, "orbit-bin")
        yield* Effect.promise(async () => {
          await Promise.all([work, bin, path.join(tmp.path, "empty")].map((directory) => fs.mkdir(directory)))
          await Bun.write(path.join(work, "notes.txt"), "a needle here\n")
          for (const folder of host.copies) {
            await fs.mkdir(path.join(tmp.path, folder), { recursive: true })
            await fs.copyFile(installed!, path.join(tmp.path, folder, executable))
          }
        })
        const entries = host.path.map((entry) => {
          if (entry === ".") return entry
          const directory = path.join(tmp.path, entry)
          return host.quote ? `"${directory}"` : directory
        })

        // The lookup runs on the first search, from the folder the process is in, so the search runs there.
        const exits = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const before = { directory: process.cwd(), path: process.env.PATH ?? "" }
            process.chdir(work)
            process.env.PATH = entries.join(path.delimiter)
            return before
          }),
          // Every operation the search tools use starts ripgrep the same way, and each must report the same outcome.
          () =>
            Effect.gen(function* () {
              const ripgrep = yield* Ripgrep.Service
              const search = { cwd: work, pattern: "needle", limit: 10 }
              const listing = { cwd: work, pattern: "*.txt", limit: 10 }
              return yield* Effect.all([
                ripgrep.grep(search).pipe(Effect.map((rows) => rows.map((row) => row.entry.path))),
                ripgrep.files(search),
                ripgrep.count(search).pipe(Effect.map((rows) => rows.map((row) => row.path))),
                ripgrep.glob(listing).pipe(Effect.map((rows) => rows.map((row) => row.path))),
                ripgrep.find(listing).pipe(Effect.map((rows) => rows.map((row) => row.path))),
              ].map((operation) => Effect.exit(operation)))
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(Ripgrep.node, [
                  Location.node.replace(tempLocationLayer),
                  Global.node.replace(Global.layerWith({ bin })),
                ]),
              ),
            ),
          (before) =>
            Effect.sync(() => {
              process.chdir(before.directory)
              process.env.PATH = before.path
            }),
        )

        const missing = `ripgrep (${executable}) was not found. Install ripgrep and put it on PATH, or copy it to ${path.join(bin, executable)}.`
        expect(
          exits.map((exit) => {
            if (Exit.isSuccess(exit)) return exit.value.join(", ")
            const error = Cause.squash(exit.cause)
            return error instanceof Ripgrep.Error ? error.message : Cause.pretty(exit.cause)
          }),
        ).toEqual(Array.from({ length: 5 }, () => (host.found ? "notes.txt" : missing)))
      }),
    )
  }
})
