import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Ripgrep } from "@orbit/core/ripgrep"
import { RelativePath } from "@orbit/core/schema"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { tempLocationLayer } from "./fixture/location"

const it = testEffect(AppNodeBuilder.build(Ripgrep.node, [Location.node.replace(tempLocationLayer)]))

describe("Ripgrep", () => {
  for (const hidden of [undefined, false, true]) {
    for (const limit of hidden ? [10] : [1, 10]) {
      it.live(`glob honors hidden=${hidden} before limit=${limit}`, () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* Effect.promise(() =>
            Promise.all(
              ["src/visible.ts", ".hidden.ts", "src/.hidden.ts", ".hidden/nested.ts", ".git/config.ts"].map((file) =>
                Bun.write(path.join(tmp.path, file), "needle\n"),
              ),
            ),
          )
          const ripgrep = yield* Ripgrep.Service
          const files = yield* ripgrep.glob({
            cwd: tmp.path,
            pattern: "**/*.ts",
            limit,
            ...(hidden === undefined ? {} : { hidden }),
          })

          expect(files.map((item) => item.path).sort()).toEqual(
            (hidden ? [".hidden.ts", ".hidden/nested.ts", "src/.hidden.ts", "src/visible.ts"] : ["src/visible.ts"]).map(
              (file) => RelativePath.make(file),
            ),
          )
        }),
      )
    }
  }

  it.live("globs files as an array", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "match.ts"), "needle\n"))

          const ripgrep = yield* Ripgrep.Service
          const result = yield* ripgrep.glob({ cwd: tmp.path, pattern: "**/*.ts", limit: 10 })
          expect(result.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("greps files with include filtering", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "match.ts"), "needle\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "skip.txt"), "needle\n"))

          const ripgrep = yield* Ripgrep.Service
          const result = yield* ripgrep.grep({
            cwd: tmp.path,
            pattern: "needle",
            include: "*.ts",
            limit: 10,
          })
          expect(result).toHaveLength(1)
          expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
          expect(result[0]?.submatches[0]?.text).toBe("needle")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const ripgrep = yield* Ripgrep.Service
          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".orbit")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".orbit", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".orbit/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".orbit/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("excludes protected directory trees from catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "Pictures")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "Pictures", "private.jpg"), "private\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "visible.txt"), "visible\n"))

          const ripgrep = yield* Ripgrep.Service
          const files = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "*",
            limit: 10,
            exclude: ["Pictures/**"],
          })

          expect(files.map((item) => item.path)).toContain(RelativePath.make("visible.txt"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("Pictures/private.jpg"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a bounded preview for matches on oversized lines", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "generated.ts"), `Cloudflare${"x".repeat(70 * 1024)}\n`),
          )

          const ripgrep = yield* Ripgrep.Service
          const matches = yield* ripgrep.grep({
            cwd: tmp.path,
            pattern: "Cloudflare",
            limit: 10,
          })

          expect(matches).toHaveLength(1)
          expect(matches[0]?.entry.path).toBe(RelativePath.make("generated.ts"))
          expect(matches[0]?.text).toBe(
            `Cloudflare${"x".repeat(Ripgrep.MAX_LINE_COLUMNS - 10)}… [line truncated: ${10 + 70 * 1024} chars]\n`,
          )
          expect(matches[0]?.submatches).toEqual([{ text: "Cloudflare", start: 0, end: 10 }])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("excludes every version-control folder from grep, glob and find", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all(
          ["ok.ts", ".github/workflow.yml", ".gitignore", ...Ripgrep.VCS_DIRECTORIES.flatMap((dir) => [`${dir}/deep/inner.ts`, `sub/${dir}`])].map((file) =>
            Bun.write(path.join(tmp.path, file), "needle\n"),
          ),
        ),
      )
      const ripgrep = yield* Ripgrep.Service
// A file named like a version-control folder (a worktree's `.git` pointer) is excluded too; .github and .gitignore are not.
      const kept = [".github/workflow.yml", ".gitignore", "ok.ts"].map((file) => RelativePath.make(file))
      expect((yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", limit: 20 })).map((row) => row.entry.path)).toEqual(kept)
      expect((yield* ripgrep.files({ cwd: tmp.path, pattern: "needle", limit: 20 })).toSorted()).toEqual(kept)
      expect((yield* ripgrep.count({ cwd: tmp.path, pattern: "needle", limit: 20 })).map((row) => row.path)).toEqual(kept)
      expect((yield* ripgrep.glob({ cwd: tmp.path, pattern: "**/*", hidden: true, limit: 20 })).map((e) => e.path).toSorted()).toEqual(kept)
      expect((yield* ripgrep.find({ cwd: tmp.path, pattern: "*", hidden: true, limit: 20 })).map((e) => e.path).toSorted()).toEqual(kept)
    }),
  )

  it.live("clips long lines to a window and shifts submatches, converting bytes to characters", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const line = "é".repeat(1_000) + "needle" + "z".repeat(1_000) + "needle"
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "long.txt"), `short needle\n${line}\n`))
      const ripgrep = yield* Ripgrep.Service
      const [short, long] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", limit: 10 })
      // Not clipped: text intact, offsets in characters.
      expect(short!.text).toBe("short needle\n")
      expect(short!.submatches).toEqual([{ text: "needle", start: 6, end: 12 }])
      expect(long!.text.length).toBeLessThan(Ripgrep.MAX_LINE_COLUMNS + 60)
      expect(long!.text).toStartWith("…")
      expect(long!.text).toContain(`[line truncated: ${line.length} chars]`)
      // The second match is outside the window and dropped.
      expect(long!.submatches).toHaveLength(1)
      expect(long!.text.slice(long!.submatches[0]!.start, long!.submatches[0]!.end)).toBe("needle")
    }),
  )

  it.live("reports unclipped submatch offsets in UTF-16 characters, not bytes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.path, "mb.txt"), `${"é".repeat(10)}needle\n${"\u{1F600}".repeat(10)}needle\n`),
      )
      const ripgrep = yield* Ripgrep.Service
      const [two, four] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", limit: 10 })
      expect(two!.submatches).toEqual([{ text: "needle", start: 10, end: 16 }])
      expect(four!.submatches).toEqual([{ text: "needle", start: 20, end: 26 }])
      for (const row of [two!, four!]) {
        const submatch = row.submatches[0]!
        expect(row.text.slice(submatch.start, submatch.end)).toBe("needle")
      }
    }),
  )

  it.live("keeps a single match longer than the window, cut at the window end", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const line = "a".repeat(200) + "S" + "m".repeat(1_000) + "E" + "b".repeat(100)
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "long.txt"), `${line}\n`))
      const ripgrep = yield* Ripgrep.Service
      const [row] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "S.*E", limit: 10 })
      expect(row!.submatches).toHaveLength(1)
      const submatch = row!.submatches[0]!
      // The window starts 100 characters before the match; the lead marker takes one.
      expect(submatch.start).toBe(101)
      expect(submatch.end).toBeGreaterThan(submatch.start + 300)
      expect(submatch.text).toBe(row!.text.slice(submatch.start, submatch.end))
    }),
  )

  for (const [name, prefix, suffix] of [
    ["start edge", "\u{1F600}".repeat(3_000) + "x", "\u{1F600}".repeat(2_000)],
    ["end edge", "a".repeat(200), "x" + "\u{1F600}".repeat(2_000)],
  ] as const) {
    it.live(`never splits a surrogate pair at the ${name} of the window`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(() => Bun.write(path.join(tmp.path, "long.txt"), `${prefix}needle${suffix}\n`))
        const ripgrep = yield* Ripgrep.Service
        const [row] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", limit: 10 })
        expect(row!.text).toContain("[line truncated: ")
        expect(row!.text.isWellFormed()).toBe(true)
        expect(row!.submatches).toHaveLength(1)
        expect(row!.text.slice(row!.submatches[0]!.start, row!.submatches[0]!.end)).toBe("needle")
      }),
    )
  }

  it.live("clips an ASCII line so the first match starts 100 characters into the window", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.path, "long.txt"), `${"a".repeat(800)}needle${"b".repeat(800)}\n`),
      )
      const ripgrep = yield* Ripgrep.Service
      const [row] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", limit: 10 })
      expect(row!.submatches).toEqual([{ text: "needle", start: 101, end: 107 }])
    }),
  )

  it.live("keeps a multiline match of short lines whole", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fields = Array.from({ length: 30 }, (_, index) => `  field_${index}: Some<${"x".repeat(30)}>,`)
      const record = `struct S {\n${fields.join("\n")}\n}\n`
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "s.rs"), `${record}other\n`))
      const ripgrep = yield* Ripgrep.Service
      const [row] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "struct S \\{.*?\\n\\}", multiline: true, limit: 10 })
      expect(record.length).toBeGreaterThan(Ripgrep.MAX_LINE_COLUMNS * 2)
      expect(row!.text).toBe(record)
      expect(row!.submatches).toHaveLength(1)
      expect(row!.text.slice(row!.submatches[0]!.start, row!.submatches[0]!.end)).toBe(record.trimEnd())
    }),
  )

  it.live("clips only the over-long line of a multiline match", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const record = `begin\n${"y".repeat(3_000)}\nmid\nend\n`
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "m.txt"), record))
      const ripgrep = yield* Ripgrep.Service
      const [row] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "begin.*end", multiline: true, limit: 10 })
      const lines = row!.text.split("\n")
      expect(lines[0]).toBe("begin")
      expect(lines[1]).toBe(`${"y".repeat(Ripgrep.MAX_LINE_COLUMNS)}… [line truncated: 3000 chars]`)
      expect(lines.slice(2)).toEqual(["mid", "end", ""])
      const submatch = row!.submatches[0]!
      expect(submatch.start).toBe(0)
      // The match runs into the cut, so it ends there.
      expect(row!.text.slice(submatch.start, submatch.end)).toBe(submatch.text)
      expect(submatch.text).toStartWith("begin\nyyy")
      expect(submatch.text).not.toContain("mid")
    }),
  )

  it.live("keeps one huge multiline match inside the record budget", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(path.join(tmp.path, "big.txt"), `start\n${"line of text\n".repeat(20_000)}end\n`),
      )
      const ripgrep = yield* Ripgrep.Service
      const [row] = yield* ripgrep.grep({ cwd: tmp.path, pattern: "start.*end", multiline: true, limit: 10 })
      expect(row!.text.length).toBeLessThan(Ripgrep.MAX_RECORD_CHARS + 200)
      expect(row!.text).toMatch(/\[match continues for \d+ more lines\]\n$/)
      expect(row!.text.isWellFormed()).toBe(true)
      expect(row!.text.slice(row!.submatches[0]!.start, row!.submatches[0]!.end)).toBe(row!.submatches[0]!.text)
    }),
  )

  it.live("clips a long context row from its start", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "c.txt"), `needle\n${"c".repeat(800)}\n`))
      const ripgrep = yield* Ripgrep.Service
      const rows = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", after: 1, limit: 10 })
      expect(rows).toHaveLength(2)
      expect(rows[1]!.submatches).toEqual([])
      expect(rows[1]!.text).toBe(`${"c".repeat(Ripgrep.MAX_LINE_COLUMNS)}… [line truncated: 800 chars]\n`)
    }),
  )

  it.live("shows lines that are not valid UTF-8 with replacement characters and keeps the rest", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "a-latin.txt"), Buffer.from([...Buffer.from("caf"), 0xe9, 0x0a, ...Buffer.from("ab "), 0xff, ...Buffer.from(" needle\n")])),
          Bun.write(path.join(tmp.path, "b-clean.txt"), "clean needle\n"),
        ]),
      )
      const ripgrep = yield* Ripgrep.Service
      const rows = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", before: 1, limit: 10 })
      expect(rows.map((row) => row.entry.path)).toEqual(["a-latin.txt", "a-latin.txt", "b-clean.txt"].map((file) => RelativePath.make(file)))
      expect(rows[0]!.text).toBe("caf\uFFFD\n")
      expect(rows[0]!.submatches).toEqual([])
      expect(rows[1]!.text).toBe("ab \uFFFD needle\n")
      for (const row of rows.slice(1)) {
        const submatch = row.submatches[0]!
        expect(row.text.slice(submatch.start, submatch.end)).toBe("needle")
        expect(submatch.text).toBe("needle")
      }
      expect(rows[1]!.submatches[0]!.start).toBe(5)
    }),
  )

  it.live("skips a path that is not valid UTF-8 without failing the search", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all([
          fs.writeFile(Buffer.concat([Buffer.from(tmp.path + "/bad-"), Buffer.from([0xff]), Buffer.from(".txt")]), "needle\n"),
          Bun.write(path.join(tmp.path, "good.txt"), "needle\n"),
        ]),
      )
      const ripgrep = yield* Ripgrep.Service
      const rows = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", limit: 10 })
      expect(rows.map((row) => row.entry.path)).toContain(RelativePath.make("good.txt"))
      expect(rows).toHaveLength(2)
    }),
  )
})
