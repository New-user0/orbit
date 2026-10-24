// context-memory-9: the pure parts of memory v2. The index (MEMORY.md) is cut to 200 lines and then to 25,000
// characters with a warning that names the cap that fired; a memory file's front matter is read only through
// ConfigMarkdown (class 11) and its `type` is one of four; `memory.directory` is validated and read only from the user,
// local, flag and managed scopes (class 4, 8); the env switch and `--bare` decide whether memory is on; the scan of the
// folder skips the index and anything a link carries out of the folder (class 4); a memory read more than a day old
// gets a staleness note.
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, Schema } from "effect"
import { Document, Info, type Scope } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { MemoryStore } from "@orbit/core/memory/store"
import { AbsolutePath } from "@orbit/core/schema"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer)))
const decode = Schema.decodeUnknownSync(Info)
const document = (scope: Scope, info: unknown) =>
  new Document({
    type: "document",
    scope,
    path: AbsolutePath.make(path.resolve(`/config/${scope}/orbit.json`)),
    info: decode(info),
  })
const lines = (count: number, width = 10) => Array.from({ length: count }, (_, index) => `${index}`.padEnd(width, "x"))
const linkType = process.platform === "win32" ? "junction" : "dir"

describe("MemoryStore.truncateIndex", () => {
  test("keeps an index under both caps whole, trimmed", () => {
    const result = MemoryStore.truncateIndex(`\n\n${lines(200).join("\n")}\n\n`)
    expect(result.content).toBe(lines(200).join("\n"))
    expect(result).toMatchObject({ lines: 200, lineTruncated: false, characterTruncated: false })
  })

  test("cuts an index of 201 lines to 200 and names the line cap", () => {
    const result = MemoryStore.truncateIndex(lines(201).join("\n"))
    const [kept, warning] = result.content.split("\n\n")
    expect(kept).toBe(lines(200).join("\n"))
    expect(result).toMatchObject({ lines: 201, lineTruncated: true, characterTruncated: false })
    expect(warning).toContain("MEMORY.md")
    expect(warning).toContain("201 lines")
    expect(warning).toContain("200")
    expect(warning).not.toContain("2,210 characters")
  })

  test("cuts an index of long lines at the last line break before 25,000 characters and names the size cap", () => {
    // 50 lines of 999 characters and a line break: 50,000 characters in all, under the line cap.
    const raw = lines(50, 999).join("\n")
    const result = MemoryStore.truncateIndex(raw)
    const kept = result.content.slice(0, result.content.indexOf("\n\n"))
    expect(kept).toBe(lines(25, 999).join("\n"))
    expect(kept.length).toBeLessThanOrEqual(MemoryStore.MAX_INDEX_CHARACTERS)
    expect(result).toMatchObject({ characters: raw.length, lineTruncated: false, characterTruncated: true })
    expect(result.content).toContain("49,999 characters")
    expect(result.content).toContain("25,000")
    expect(result.content).not.toContain("50 lines")
  })

  test("does not keep part of the line that crosses 25,000 characters", () => {
    // Lines of 997 characters and a line break: the 26th line runs from 24,950 to 25,947, so a cut at the cap itself
    // would keep its first 50 characters.
    const result = MemoryStore.truncateIndex(lines(50, 997).join("\n"))
    expect(result.content.slice(0, result.content.indexOf("\n\n"))).toBe(lines(25, 997).join("\n"))
  })

  test("cuts hard at 25,000 characters when no line break comes before the cap", () => {
    const result = MemoryStore.truncateIndex("y".repeat(30_000))
    expect(result.content.startsWith("y".repeat(25_000) + "\n\n")).toBe(true)
    expect(result.content.slice(0, 25_001)).toBe("y".repeat(25_000) + "\n")
    expect(result.characterTruncated).toBe(true)
  })

  // The size check uses the length before the line cut: long lines are what the size cap is for, so the warning must
  // not understate them once the line cut made the rest fit.
  test("names both caps when the index is over both, measured before the line cut", () => {
    const raw = lines(300, 99).join("\n")
    const result = MemoryStore.truncateIndex(raw)
    expect(result).toMatchObject({ lines: 300, characters: 29_999, lineTruncated: true, characterTruncated: true })
    expect(result.content.slice(0, result.content.indexOf("\n\n"))).toBe(lines(200, 99).join("\n"))
    expect(result.content).toContain("300 lines")
    expect(result.content).toContain("29,999 characters")
  })

  test("keeps the exact caps: 200 lines and 25,000 characters", () => {
    expect(MemoryStore.MAX_INDEX_LINES).toBe(200)
    expect(MemoryStore.MAX_INDEX_CHARACTERS).toBe(25_000)
  })
})

describe("MemoryStore.frontMatter", () => {
  test.each(["user", "feedback", "project", "reference"])("reads the type %s", (type) => {
    const parsed = MemoryStore.frontMatter(
      `---\nname: Tests\ndescription: How to run the tests\ntype: ${type}\n---\nbody\n`,
    )
    expect(parsed).toEqual({ name: "Tests", description: "How to run the tests", type })
  })

  test.each([["Feedback"], ["note"], [""], ["7"]])(
    "keeps a file whose type %p is not one of the four, with no type",
    (type) => {
      expect(MemoryStore.frontMatter(`---\nname: n\ndescription: d\ntype: ${type}\n---\n`)).toEqual({
        name: "n",
        description: "d",
      })
    },
  )

  test("reads a file without front matter, or with front matter YAML refuses, as having none", () => {
    expect(MemoryStore.frontMatter("# Just a note\n")).toEqual({})
    expect(MemoryStore.frontMatter("---\nname: [unclosed\n---\nbody")).toEqual({})
  })

  test("keeps only string values of name and description", () => {
    expect(MemoryStore.frontMatter("---\nname: 12\ndescription:\n  - a\ntype: user\n---\n")).toEqual({ type: "user" })
  })

  // Class 11: front matter is data. A `---js` block is never run, whichever spelling opens it.
  for (const language of ["js", "javascript", " js"])
    it.live(`runs no code for front matter opened with ---${language}`, () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const marker = path.join(tmp, "marker")
        const code = `{ name: (require("fs").writeFileSync(${JSON.stringify(marker)}, "ran"), "n"), type: "user" }`
        const parsed = MemoryStore.frontMatter(`---${language}\n${code}\n---\nbody\n`)
        const control = MemoryStore.frontMatter("---\ntype: user\n---\nbody\n")
        expect(control).toEqual({ type: "user" })
        expect(parsed.type).toBeUndefined()
        expect(
          yield* Effect.promise(() =>
            fs.access(marker).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    )
})

describe("MemoryStore.validateDirectory", () => {
  const home = path.resolve(os.homedir())
  const accepted: ReadonlyArray<readonly [string, string, string]> = [
    ["~/ expansion", "~/notes/memory", path.join(home, "notes", "memory")],
    ["a trailing separator, dropped", `${path.join(home, "mem")}${path.sep}${path.sep}`, path.join(home, "mem")],
    ["a `..` inside, normalised", path.join(home, "a", "..", "mem"), path.join(home, "mem")],
    ["a decomposed name, composed to NFC", path.join(home, "cafe\u0301"), path.join(home, "caf\u00e9")],
    ...(process.platform === "win32"
      ? ([
          ["~\\ expansion", "~\\mem", path.join(home, "mem")],
          ["a drive path", "D:\\work\\mem", "D:\\work\\mem"],
        ] as const)
      : ([["a short absolute path", "/ab", "/ab"]] as const)),
  ]
  for (const [name, raw, expected] of accepted)
    test(`accepts ${name}`, () => {
      expect(MemoryStore.validateDirectory(raw, home)).toBe(expected)
    })

  const refused: ReadonlyArray<readonly [string, string | undefined]> = [
    ["nothing", undefined],
    ["an empty string", ""],
    ["a bare ~", "~"],
    ["~/", "~/"],
    ["~/.", "~/."],
    ["~/.., the parent of home", "~/.."],
    ["a remainder that normalises to home", "~/a/.."],
    ["a remainder that normalises above home", "~/a/../.."],
    ["a relative path", "memory"],
    ["a dot-relative path", "./memory"],
    ["a parent-relative path", "../memory"],
    ["the filesystem root", "/"],
    ["a root and one letter", "/a"],
    ["a NUL", `${path.join(home, "mem")}\0x`],
    ["a forward-slash UNC path", "//host/share/memory"],
    ["a UNC path", "\\\\host\\share\\memory"],
    ["a device path", "\\\\?\\C:\\memory"],
    ["a UNC device path", "\\\\?\\UNC\\host\\share\\memory"],
    ...(process.platform === "win32"
      ? ([
          ["a bare drive", "C:"],
          ["a drive root", "C:\\"],
          ["a drive-relative path", "C:memory"],
          ["a root-relative path, which names the current drive", "\\memory"],
          ["a root-relative forward-slash path", "/memory"],
        ] as const)
      : []),
  ]
  for (const [name, raw] of refused)
    test(`refuses ${name}`, () => {
      expect(MemoryStore.validateDirectory(raw, home)).toBeUndefined()
    })
})

// The override names a folder whose writes need no question, so a repository must not choose it: the project scope is
// never read, even when trusted, and neither is the remote one, which a server supplies.
describe("MemoryStore.directorySetting", () => {
  const home = path.resolve(os.homedir())
  const dir = (name: string) => path.join(home, name)
  test.each(["user", "local", "flag", "managed"] as const)("reads memory.directory from the %s scope", (scope) => {
    expect(MemoryStore.directorySetting([document(scope, { memory: { directory: dir(scope) } })], home)).toBe(
      dir(scope),
    )
  })

  test.each(["project", "remote"] as const)("ignores memory.directory from the %s scope", (scope) => {
    expect(MemoryStore.directorySetting([document(scope, { memory: { directory: dir(scope) } })], home)).toBeUndefined()
    // The control: the same value from the user scope is read.
    expect(MemoryStore.directorySetting([document("user", { memory: { directory: dir(scope) } })], home)).toBe(
      dir(scope),
    )
  })

  test("takes the highest of the allowed scopes, and a project entry after it changes nothing", () => {
    const entries = [
      document("user", { memory: { directory: dir("user") } }),
      document("local", { memory: { directory: dir("local") } }),
      document("flag", { memory: { directory: dir("flag") } }),
      document("project", { memory: { directory: dir("project") } }),
    ]
    expect(MemoryStore.directorySetting(entries, home)).toBe(dir("flag"))
    expect(
      MemoryStore.directorySetting([...entries, document("managed", { memory: { directory: dir("managed") } })], home),
    ).toBe(dir("managed"))
  })

  test("reads the directory of an entry that sets only memory.enabled after it as unchanged", () => {
    const entries = [
      document("user", { memory: { directory: dir("user") } }),
      document("local", { memory: { enabled: true } }),
    ]
    expect(MemoryStore.directorySetting(entries, home)).toBe(dir("user"))
  })

  test("falls back to no override when the highest value is invalid, as the reference does", () => {
    const entries = [
      document("user", { memory: { directory: dir("user") } }),
      document("managed", { memory: { directory: "relative" } }),
    ]
    expect(MemoryStore.directorySetting(entries, home)).toBeUndefined()
  })
})

describe("MemoryStore.enabled", () => {
  const off = [document("user", { memory: { enabled: false } })]
  test("is on by default", () => {
    expect(MemoryStore.enabled({}, [])).toBe(true)
  })

  test.each(["1", "true", "TRUE", "yes", "on"])("is off when ORBIT_DISABLE_AUTO_MEMORY is %p", (value) => {
    expect(MemoryStore.enabled({ ORBIT_DISABLE_AUTO_MEMORY: value }, [])).toBe(false)
  })

  test.each(["0", "false", "no", "off"])(
    "is on when ORBIT_DISABLE_AUTO_MEMORY is %p, over --bare and the config",
    (value) => {
      expect(MemoryStore.enabled({ ORBIT_DISABLE_AUTO_MEMORY: value, ORBIT_DISABLE_INSTRUCTIONS: "1" }, off)).toBe(true)
    },
  )

  test("is off under --bare, which sets ORBIT_DISABLE_INSTRUCTIONS", () => {
    expect(MemoryStore.enabled({ ORBIT_DISABLE_INSTRUCTIONS: "1" }, [])).toBe(false)
    expect(MemoryStore.enabled({ ORBIT_DISABLE_AUTO_MEMORY: "maybe" }, [])).toBe(true)
  })

  test("follows memory.enabled, the last scope that sets it deciding, a trusted project's included", () => {
    expect(MemoryStore.enabled({}, off)).toBe(false)
    expect(MemoryStore.enabled({}, [...off, document("project", { memory: { enabled: true } })])).toBe(true)
    expect(
      MemoryStore.enabled({}, [
        document("user", { memory: { enabled: true } }),
        document("project", { memory: { enabled: false } }),
      ]),
    ).toBe(false)
    expect(MemoryStore.enabled({}, [...off, document("local", { memory: { directory: "~/m" } })])).toBe(false)
  })
})

describe("MemoryStore.freshnessNote", () => {
  const now = Date.UTC(2026, 9, 23, 12)
  const day = 86_400_000
  test("counts whole days and clamps a time in the future to 0", () => {
    expect(MemoryStore.ageDays(now - 47 * day - 5_000, now)).toBe(47)
    expect(MemoryStore.ageDays(now - day + 1, now)).toBe(0)
    expect(MemoryStore.ageDays(now + 10 * day, now)).toBe(0)
  })

  test("says nothing of a memory written today or yesterday", () => {
    expect(MemoryStore.freshnessNote(now, now)).toBe("")
    expect(MemoryStore.freshnessNote(now - 47 * 3_600_000, now)).toBe("")
    expect(MemoryStore.freshnessNote(now + day, now)).toBe("")
  })

  test("wraps a note naming the age of an older memory in a reminder envelope", () => {
    const note = MemoryStore.freshnessNote(now - 47 * day, now)
    expect(note.startsWith("<system-reminder>\n")).toBe(true)
    expect(note.endsWith("</system-reminder>\n")).toBe(true)
    expect(note).toContain("47 days")
    expect(MemoryStore.freshnessNote(now - 2 * day, now)).toContain("2 days")
  })
})

describe("MemoryStore.scan", () => {
  const write = async (file: string, text: string, mtime: number) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
    await fs.utimes(file, new Date(mtime), new Date(mtime))
  }
  const typed = (description: string, type = "project") =>
    `---\nname: x\ndescription: ${description}\ntype: ${type}\n---\nbody\n`

  it.live("lists the memory files newest first, below folders too, and leaves the index and other files out", () =>
    Effect.gen(function* () {
      const folder = (yield* tmpdirScoped()).path
      yield* Effect.promise(async () => {
        await write(path.join(folder, "old.md"), typed("old one", "user"), 1_000_000)
        await write(path.join(folder, "topic", "new.md"), typed("new one", "feedback"), 3_000_000)
        await write(path.join(folder, "plain.md"), "# no front matter\n", 2_000_000)
        await write(path.join(folder, "MEMORY.md"), "- [old](old.md)\n", 4_000_000)
        await write(path.join(folder, "topic", "MEMORY.md"), "nested index\n", 4_000_000)
        await write(path.join(folder, "notes.txt"), typed("not markdown"), 5_000_000)
      })
      const headers = yield* MemoryStore.scan(folder)
      expect(headers.map((item) => [item.file, item.description, item.type, item.mtimeMs])).toEqual([
        ["topic/new.md", "new one", "feedback", 3_000_000],
        ["plain.md", undefined, undefined, 2_000_000],
        ["old.md", "old one", "user", 1_000_000],
      ])
      expect(headers[0]?.path).toBe(path.join(folder, "topic", "new.md"))
      expect(MemoryStore.manifest(headers)).toBe(
        [
          `- [feedback] topic/new.md (${new Date(3_000_000).toISOString()}): new one`,
          `- plain.md (${new Date(2_000_000).toISOString()})`,
          `- [user] old.md (${new Date(1_000_000).toISOString()}): old one`,
        ].join("\n"),
      )
    }),
  )

  it.live("keeps the 200 newest of more", () =>
    Effect.gen(function* () {
      const folder = (yield* tmpdirScoped()).path
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 205 }, (_, index) =>
            write(path.join(folder, `m${index}.md`), typed(`n${index}`), 1_000_000 + index * 1000),
          ),
        ),
      )
      const headers = yield* MemoryStore.scan(folder)
      expect(headers).toHaveLength(200)
      expect(headers[0]?.file).toBe("m204.md")
      expect(headers.at(-1)?.file).toBe("m5.md")
    }),
  )

  it.live("reads only the first 30 lines of a file for its front matter", () =>
    Effect.gen(function* () {
      const folder = (yield* tmpdirScoped()).path
      yield* Effect.promise(async () => {
        await write(path.join(folder, "short.md"), typed("in reach"), 2_000_000)
        await write(
          path.join(folder, "long.md"),
          `---\n${"pad: 1\n".repeat(40)}description: out of reach\n---\n`,
          1_000_000,
        )
      })
      const headers = yield* MemoryStore.scan(folder)
      expect(headers.map((item) => [item.file, item.description])).toEqual([
        ["short.md", "in reach"],
        ["long.md", undefined],
      ])
    }),
  )

  it.live("gives an empty list for a folder that is not there", () =>
    Effect.gen(function* () {
      const folder = (yield* tmpdirScoped()).path
      expect(yield* MemoryStore.scan(path.join(folder, "missing"))).toEqual([])
    }),
  )

  // Class 4: a link inside the folder can lead anywhere, so a file is listed only when its real path is in the real
  // folder. The marker is a description that must never reach a manifest; the plain file beside it is the control.
  it.live("leaves out a file that a link in the folder leads to outside it", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const folder = path.join(root, "memory")
      const outside = path.join(root, "outside")
      yield* Effect.promise(async () => {
        await write(path.join(folder, "kept.md"), typed("control"), 1_000_000)
        await write(path.join(outside, "secret.md"), typed("MARKER-OUTSIDE"), 2_000_000)
        await fs.symlink(outside, path.join(folder, "out"), linkType)
        // A link to a file needs a privilege on Windows; Linux runs this half everywhere.
        if (canLinkFile) await fs.symlink(path.join(outside, "secret.md"), path.join(folder, "leak.md"))
      })
      const headers = yield* MemoryStore.scan(folder)
      expect(headers.map((item) => item.file)).toEqual(["kept.md"])
      expect(MemoryStore.manifest(headers)).not.toContain("MARKER-OUTSIDE")
    }),
  )

  // A folder that is itself reached through a link is the person's choice of place: its files are listed.
  it.live("lists the files of a memory folder that is itself a link", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const real = path.join(root, "real")
      yield* Effect.promise(async () => {
        await write(path.join(real, "kept.md"), typed("through the link"), 1_000_000)
        await fs.symlink(real, path.join(root, "linked"), linkType)
      })
      const headers = yield* MemoryStore.scan(path.join(root, "linked"))
      expect(headers.map((item) => [item.file, item.description])).toEqual([["kept.md", "through the link"]])
    }),
  )
})
