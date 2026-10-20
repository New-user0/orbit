import { describe, expect, test } from "bun:test"
import { realpathSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Git } from "@orbit/core/git"
import { GitLayout } from "@orbit/core/git/layout"
import { AbsolutePath } from "@orbit/core/schema"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { git, repository } from "./fixture/git"
import { type Found, folders, forgeries } from "./fixture/git-forged"
import { searchable, shapes } from "./fixture/git-passed-over"
import { recordedFileSystem, sharesTouched } from "./fixture/recorded-fs"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// The layout of a folder's git directory, read from files (class 1, 3, 4, 5, 6, 7). Git is the oracle where git makes the
// layout (a repository, a linked worktree, a bare repository's worktree): the answer has to be the one `git rev-parse` and
// `git worktree list` give. Where a clone makes the layout, the answer has to say that nothing was verified, and what the clone
// points at is read no further than the pointer and the `commondir` and `gitdir` files of the entry it names.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, Git.node])))

const abs = AbsolutePath.make
const SLOW = 60_000

/** What git says about the folder, in the terms of a layout: where git makes it, the layout has to be this. */
const oracle = (folder: string) =>
  Effect.gen(function* () {
    const service = yield* Git.Service
    const repo = yield* service.repo.discover(abs(folder))
    if (!repo) return yield* Effect.die(new Error(`git finds no repository in ${folder}`))
    const main =
      repo.gitDirectory === repo.commonDirectory ? repo.worktree : (yield* service.worktree.list(repo))[0]?.directory
    return {
      worktree: repo.worktree,
      gitDirectory: repo.gitDirectory,
      commonDirectory: repo.commonDirectory,
      canonical: main ?? repo.worktree,
      verified: true,
    } satisfies GitLayout.Layout
  })

const locate = (folder: string) =>
  Effect.gen(function* () {
    return yield* GitLayout.locate(yield* FSUtil.Service, folder)
  })

// The path as the file system spells it (`native` also expands a short Windows name), which is how git and Orbit spell it.
const real = (file: string) => Effect.sync(() => realpathSync.native(file))

describe("GitLayout.locate, where git makes the layout", () => {
  it.live("reads a repository as git does", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      yield* repository(path.join(root, "repo"))

      const layout = yield* locate(path.join(root, "repo"))

      expect(layout).toEqual(yield* oracle(path.join(root, "repo")))
      expect(layout?.canonical).toBe(layout?.worktree)
    }),
  )

  it.live("reads a linked worktree as git does, with the main checkout as its canonical folder", () =>
    Effect.gen(function* () {
      const found = yield* folders

      const layout = yield* locate(found.linked)

      expect(layout).toEqual(yield* oracle(found.linked))
      expect(layout?.canonical).toBe(found.victim)
      expect(layout?.gitDirectory).not.toBe(layout?.commonDirectory)
    }),
  )

  it.live("reads a worktree of a bare repository, whose canonical folder is the bare repository", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      yield* repository(path.join(root, "source"))
      yield* Effect.promise(async () => {
        await git(root, "clone", "--bare", path.join(root, "source"), path.join(root, "bare.git"))
        await git(path.join(root, "bare.git"), "worktree", "add", "--detach", path.join(root, "checkout"), "HEAD")
      })

      const layout = yield* locate(path.join(root, "checkout"))

      expect(layout).toEqual(yield* oracle(path.join(root, "checkout")))
      expect(path.basename(layout?.canonical ?? "")).toBe("bare.git")
    }),
  )

  // A file of git's own that is spelled another way is still the same file: a pointer that ends in a line break of either
  // kind, one that names the entry by a relative path, and (on Windows) a back-link in another case.
  const respelled: ReadonlyArray<readonly [string, (found: Found) => Promise<void>]> = [
    ["a pointer that ends in a CRLF", async (found) => rewrite(path.join(found.linked, ".git"), (text) => text.replace(/\n$/, "\r\n"))],
    ["a pointer with no line break", async (found) => rewrite(path.join(found.linked, ".git"), (text) => text.replace(/\n$/, ""))],
    [
      "a pointer that names the entry by a relative path",
      async (found) =>
        fs.writeFile(path.join(found.linked, ".git"), `gitdir: ${path.relative(found.linked, found.entry)}\n`),
    ],
    [
      "a back-link in upper case",
      async (found) => (process.platform === "win32" ? rewrite(path.join(found.entry, "gitdir"), (text) => text.toUpperCase()) : undefined),
    ],
  ]
  const rewrite = async (file: string, change: (text: string) => string) =>
    fs.writeFile(file, change(await Bun.file(file).text()))

  for (const [name, change] of respelled)
    it.live(
      `still verifies a linked worktree with ${name}`,
      () =>
        Effect.gen(function* () {
          const found = yield* folders
          yield* Effect.promise(() => change(found))

          expect(yield* locate(found.linked)).toMatchObject({ verified: true, canonical: found.victim })
        }),
      SLOW,
    )

  it.live("finds no repository in a folder without a .git, or whose .git has no HEAD", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(root, "plain"))
        await fs.mkdir(path.join(root, "empty", ".git"), { recursive: true })
        await fs.mkdir(path.join(root, "headless", ".git", "HEAD"), { recursive: true })
      })

      expect(yield* locate(path.join(root, "plain"))).toBeUndefined()
      expect(yield* locate(path.join(root, "empty"))).toBeUndefined()
      expect(yield* locate(path.join(root, "headless"))).toBeUndefined()
      expect(yield* locate(path.join(root, "missing"))).toBeUndefined()
    }),
  )

  // A `HEAD` that git takes in each of its spellings: a detached commit, and a ref after no space or after a tab.
  it.live("reads a repository whose HEAD is detached, or names its ref after no space or a tab, as git does", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const folder = path.join(root, "repo")
      yield* repository(folder)
      const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: folder }).stdout.toString().trim()

      for (const text of [`${commit}\n`, "ref:refs/heads/main\n", "ref:\trefs/heads/main\n"]) {
        yield* Effect.promise(() => fs.writeFile(path.join(folder, ".git", "HEAD"), text))
        expect(yield* locate(folder)).toEqual(yield* oracle(folder))
      }
    }),
  )

  // Where Orbit cannot match what git does, it passes over a `.git` that git might take, so that the folder it names lies
  // above the one git uses and a grant of it covers that one: a `HEAD` past 4 KiB (git reads its first 255 bytes) and a
  // `HEAD` that is a link (git takes one whose target starts with `refs/`). The link row needs an account that can link
  // a file. Mutation: dropping the link check fails the link row, and reading `HEAD` with no limit the long one.
  it.live("passes over a .git whose HEAD is over 4 KiB", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const folder = path.join(root, "repo")
      yield* repository(folder)
      yield* Effect.promise(() => fs.writeFile(path.join(folder, ".git", "HEAD"), `ref: refs/heads/main\n${" ".repeat(5000)}`))

      expect(yield* locate(folder)).toBeUndefined()
    }),
  )

  ;(canLinkFile ? it.live : it.live.skip)("passes over a .git whose HEAD is a link", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const folder = path.join(root, "repo")
      yield* repository(folder)
      yield* Effect.promise(async () => {
        await fs.rename(path.join(folder, ".git", "HEAD"), path.join(root, "HEAD"))
        await fs.symlink(path.join(root, "HEAD"), path.join(folder, ".git", "HEAD"), "file")
      })

      expect(yield* locate(folder)).toBeUndefined()
    }),
  )

  // Git passes over these and looks in the folder above, which here holds no repository (git-passed-over.test.ts has the
  // rows where it does). Mutation: taking any `.git` directory with a `HEAD` file for a repository fails every row.
  for (const [name, fill] of shapes)
    it.live(`finds no repository for ${name}, as git finds none`, () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        const folder = path.join(root, "folder")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(folder, ".git"), { recursive: true })
          await fs.mkdir(path.join(root, "elsewhere"))
          await fill(path.join(folder, ".git"), path.join(root, "elsewhere"))
        })
        yield* searchable(path.join(folder, ".git"))

        expect(Bun.spawnSync(["git", "rev-parse", "--git-dir"], { cwd: folder, stderr: "ignore" }).exitCode).not.toBe(0)
        expect(yield* locate(folder)).toBeUndefined()
      }),
    )
})

// What a clone ships is a layout that no git of the user made. The folder is its own canonical folder in every row, so that
// it never borrows the decision of a repository that it names, and the layout says it was not verified, so that nothing
// is read from the directory it names beyond its `commondir` and `gitdir` files. Git itself still follows some of these (the oracle is not asked, because the answer is the refusal).
describe("GitLayout.locate, where a clone makes the layout", () => {
  for (const [name, make] of forgeries)
    it.live(
      `names the folder itself, verified by nothing, for ${name}`,
      () =>
        Effect.gen(function* () {
          const found = yield* folders
          yield* Effect.promise(() => make(found))

          const layout = yield* locate(found.crafted)

          expect(layout).toMatchObject({ verified: false, worktree: found.crafted, canonical: found.crafted })
          // The git directory it names is its own `.git`, which is never opened, and never the victim's.
          expect(layout?.gitDirectory).toBe(abs(path.join(found.crafted, ".git")))
          expect(layout?.commonDirectory).toBe(abs(path.join(found.crafted, ".git")))
          expect(yield* GitLayout.remote(yield* FSUtil.Service, layout!)).toBeUndefined()
        }),
      SLOW,
    )

  // What is read, pinned for every forgery: the recorder lists each file the layout reads. Only the pointer and the
  // `commondir` and `gitdir` of the entry it names may be read, wherever that entry is, and nothing in the victim's
  // repository but those two files of its own worktree entry. A `.git` directory of the folder's own has its `HEAD` read
  // too. Mutation: `linked` also reading `<target>/HEAD` fails every row whose pointer names an entry.
  for (const [name, make] of forgeries)
    it.live(
      `reads only the pointer and the commondir and gitdir of the entry it names, for ${name}`,
      () =>
        Effect.gen(function* () {
          const found = yield* folders
          yield* Effect.promise(() => make(found))
          const recorder = recordedFileSystem()

          yield* Effect.gen(function* () {
            return yield* GitLayout.locate(yield* FSUtil.Service, found.crafted)
          }).pipe(Effect.provide(recorder.layer))

          const read = recorder.calls
            .flatMap((call) => (call.startsWith("readFileString ") ? [call.slice(15)] : []))
            .filter((file) => file !== path.join(found.crafted, ".git", "HEAD"))
          expect(read.map((file) => path.basename(file)).filter((file) => ![".git", "commondir", "gitdir"].includes(file))).toEqual([])
          const victims = read.filter((file) => !path.relative(found.victim, file).startsWith(".."))
          expect(victims.filter((file) => path.dirname(file) !== found.entry)).toEqual([])
        }),
      SLOW,
    )

  // `git submodule add` and `git clone --separate-git-dir` write a `.git` file that no worktree entry lists. Git follows it, and
  // Orbit does not read what it names until the folder is trusted.
  it.live("does not verify a submodule or a separate git directory, though git makes both", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      yield* repository(path.join(root, "source"), "git@example.test:owner/sub.git")
      yield* repository(path.join(root, "super"))
      yield* Effect.promise(async () => {
        await git(path.join(root, "super"), "-c", "protocol.file.allow=always", "submodule", "add", path.join(root, "source"), "sub")
        await git(root, "clone", "-q", "--separate-git-dir", path.join(root, "elsewhere"), path.join(root, "source"), path.join(root, "separate"))
      })

      for (const folder of [path.join(root, "super", "sub"), path.join(root, "separate")]) {
        const layout = yield* locate(folder)
        expect(layout).toMatchObject({ verified: false, worktree: yield* real(folder) })
        expect(layout?.canonical).toBe(layout?.worktree)
        // Git does find a repository there.
        expect(yield* oracle(folder)).toBeDefined()
        expect(yield* GitLayout.remote(yield* FSUtil.Service, layout!)).toBeUndefined()
      }
    }),
    SLOW,
  )

  const invalid: ReadonlyArray<readonly [string, string]> = [
    ["an empty file", ""],
    ["a file with no gitdir prefix", "../elsewhere\n"],
    ["a file with a second line", "gitdir: ../elsewhere\nsecond\n"],
    ["a file that names nothing", "gitdir: \n"],
    ["a file of 5,000 bytes", `gitdir: ${"a".repeat(5000)}\n`],
  ]
  for (const [name, text] of invalid)
    it.live(
      `finds no repository for ${name}, as git does not`,
      () =>
        Effect.gen(function* () {
          const found = yield* folders
          yield* Effect.promise(() => fs.writeFile(path.join(found.crafted, ".git"), text))

          expect(yield* locate(found.crafted)).toBeUndefined()
        }),
      SLOW,
    )

  // A name that is a share or a device is not looked at: opening it connects to a host that the clone chose. The recorder
  // sees every path that the file system is asked about.
  const shares = ["\\\\evil.test\\share\\x", "//evil.test/share/x", "\\\\?\\UNC\\evil.test\\share\\x", "\\\\.\\pipe\\x"]
  for (const target of shares)
    it.live(
      `never touches a share that a .git file names (${target})`,
      () =>
        Effect.gen(function* () {
          const found = yield* folders
          yield* Effect.promise(() => fs.writeFile(path.join(found.crafted, ".git"), `gitdir: ${target}\n`))
          const recorder = recordedFileSystem()

          const layout = yield* Effect.gen(function* () {
            return yield* GitLayout.locate(yield* FSUtil.Service, found.crafted)
          }).pipe(Effect.provide(recorder.layer))

          expect(layout).toMatchObject({ verified: false, canonical: found.crafted })
          expect(sharesTouched(recorder.touched)).toEqual([])
        }),
      SLOW,
    )

  // A `.git` directory's `commondir` is where git looks for `objects` and `refs`, so it is asked about too. A share is not
  // looked at, and the `.git` counts as not a repository, which is the stricter answer: the folder above is named.
  // Mutation: asking `fs.stat` for `objects` and `refs` past the share check fails every row.
  for (const target of shares)
    it.live(
      `never touches a share that a .git directory's commondir names (${target})`,
      () =>
        Effect.gen(function* () {
          const found = yield* folders
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(found.crafted, ".git"))
            await fs.writeFile(path.join(found.crafted, ".git", "HEAD"), "ref: refs/heads/main\n")
            await fs.writeFile(path.join(found.crafted, ".git", "commondir"), `${target}\n`)
          })
          const recorder = recordedFileSystem()

          const layout = yield* Effect.gen(function* () {
            return yield* GitLayout.locate(yield* FSUtil.Service, found.crafted)
          }).pipe(Effect.provide(recorder.layer))

          expect(layout).toBeUndefined()
          expect(sharesTouched(recorder.touched)).toEqual([])
        }),
      SLOW,
    )
})

describe("GitLayout.remote", () => {
  it.live("reads the origin of a repository and of its linked worktree", () =>
    Effect.gen(function* () {
      const found = yield* folders
      const fsutil = yield* FSUtil.Service

      for (const folder of [found.victim, found.linked]) {
        const layout = yield* locate(folder)
        expect(yield* GitLayout.remote(fsutil, layout!)).toBe("git@example.test:victim/repo.git")
      }
    }),
  )

  it.live("reads another remote by its name, and none for a name that is not there", () =>
    Effect.gen(function* () {
      const found = yield* folders
      yield* Effect.promise(() => git(found.victim, "remote", "add", "upstream", "https://example.test/up/repo.git"))
      const layout = yield* locate(found.victim)
      const fsutil = yield* FSUtil.Service

      expect(yield* GitLayout.remote(fsutil, layout!, "upstream")).toBe("https://example.test/up/repo.git")
      expect(yield* GitLayout.remote(fsutil, layout!, "nothing")).toBeUndefined()
    }),
  )

  it.live("follows no include, which git does", () =>
    Effect.gen(function* () {
      const found = yield* folders
      const included = path.join(found.root, "included.config")
      yield* Effect.promise(async () => {
        await git(found.crafted, "init", "-b", "main")
        await Bun.write(included, '[remote "origin"]\n\turl = https://example.test/included/repo.git\n')
        await git(found.crafted, "config", "include.path", included)
      })
      const layout = yield* locate(found.crafted)

      expect(layout?.verified).toBe(true)
      expect(yield* GitLayout.remote(yield* FSUtil.Service, layout!)).toBeUndefined()
      // Git reads it, so a plain `git remote get-url` finds the URL that the reader does not.
      const service = yield* Git.Service
      const repo = yield* service.repo.discover(abs(found.crafted))
      expect(yield* service.remote.get(repo!)).toBe("https://example.test/included/repo.git")
    }),
  )

  it.live("reads no config past the limit", () =>
    Effect.gen(function* () {
      const found = yield* folders
      yield* Effect.promise(() =>
        fs.appendFile(path.join(found.victim, ".git", "config"), `# ${"x".repeat(1024 * 1024)}\n`),
      )
      const layout = yield* locate(found.victim)

      expect(layout?.verified).toBe(true)
      expect(yield* GitLayout.remote(yield* FSUtil.Service, layout!)).toBeUndefined()
    }),
  )
})

// The text of a config, as git reads it. Each row is a spelling that a hand-edited or tool-written file can hold.
describe("GitLayout.remoteUrl", () => {
  const rows: ReadonlyArray<readonly [string, string, string | undefined, string?]> = [
    ["a tab-indented key", '[remote "origin"]\n\turl = https://example.test/a/b.git\n', "https://example.test/a/b.git"],
    ["spaces", '[remote "origin"]\n    url=https://example.test/a/b.git   \n', "https://example.test/a/b.git"],
    ["CRLF line breaks", '[remote "origin"]\r\n\turl = https://example.test/a/b.git\r\n', "https://example.test/a/b.git"],
    ["a byte order mark", '\u{FEFF}[remote "origin"]\n\turl = https://example.test/a/b.git\n', "https://example.test/a/b.git"],
    ["a key in upper case", '[Remote "origin"]\n\tURL = https://example.test/a/b.git\n', "https://example.test/a/b.git"],
    ["a quoted value", '[remote "origin"]\n\turl = "https://example.test/a b/c.git"\n', "https://example.test/a b/c.git"],
    ["an escaped quote in a value", '[remote "origin"]\n\turl = "https://example.test/\\"q\\".git"\n', 'https://example.test/"q".git'],
    ["a comment after the value", '[remote "origin"]\n\turl = https://example.test/a.git # mirror\n', "https://example.test/a.git"],
    ["a semicolon comment", '[remote "origin"]\n\turl = https://example.test/a.git ; mirror\n', "https://example.test/a.git"],
    ["a comment mark inside quotes", '[remote "origin"]\n\turl = "https://example.test/a#b.git"\n', "https://example.test/a#b.git"],
    ["a key on the line of its header", '[remote "origin"] url = https://example.test/a.git\n', "https://example.test/a.git"],
    ["a value that continues on the next line", '[remote "origin"]\n\turl = https://example.test/\\\n\ta.git\n', "https://example.test/\ta.git"],
    [
      "another remote first",
      '[remote "upstream"]\n\turl = https://example.test/up.git\n[remote "origin"]\n\turl = https://example.test/o.git\n',
      "https://example.test/o.git",
    ],
    [
      "two urls, the first of which counts",
      '[remote "origin"]\n\turl = https://example.test/first.git\n\turl = https://example.test/second.git\n',
      "https://example.test/first.git",
    ],
    [
      "the header twice",
      '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.test/a.git\n',
      "https://example.test/a.git",
    ],
    ["a subsection with an escaped quote", '[remote "or\\"igin"]\n\turl = https://example.test/a.git\n', "https://example.test/a.git", 'or"igin'],
    ["no url", '[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n', undefined],
    ["an empty url", '[remote "origin"]\n\turl =\n', undefined],
    ["a url key with no value", '[remote "origin"]\n\turl\n', undefined],
    ["a url in another section", '[branch "origin"]\n\turl = https://example.test/a.git\n', undefined],
    ["a url under the include section", '[include]\n\turl = https://example.test/a.git\n', undefined],
    ["a url under a url section", '[url "https://example.test/x/"]\n\tinsteadOf = https://example.test/y/\n', undefined],
    [
      "a rewrite rule, which is not applied",
      '[url "git@example.test:"]\n\tinsteadOf = https://example.test/\n[remote "origin"]\n\turl = https://example.test/a/b.git\n',
      "https://example.test/a/b.git",
    ],
    ["the url before any section", "url = https://example.test/a.git\n", undefined],
    ["a header that is not closed", '[remote "origin"\n\turl = https://example.test/a.git\n', undefined],
    ["a commented url", '[remote "origin"]\n\t# url = https://example.test/a.git\n', undefined],
    ["the deprecated header", '[remote.origin]\n\turl = https://example.test/a.git\n', undefined],
    ["a remote of another name", '[remote "mirror"]\n\turl = https://example.test/a.git\n', undefined],
    ["an empty file", "", undefined],
  ]
  for (const [name, config, expected, remote] of rows)
    test(`reads ${name}`, () => {
      expect(GitLayout.remoteUrl(config, remote ?? "origin")).toBe(expected)
    })

  // The parser is a loop over text that a clone writes, and a loop that never ends blocks the event loop, where no test
  // timeout reaches it. So the hostile texts run in a process of their own, with a deadline that kills it.
  test("answers hostile text in bounded time", async () => {
    const module = path.join(import.meta.dir, "../src/git/layout.ts")
    const size = 1024 * 1024
    const hostile = [
      "[".repeat(size),
      '[remote "'.repeat(size / 9),
      "\\\n".repeat(size / 2),
      `[remote "origin"]\nurl = ${'"'.repeat(size)}`,
      `[remote "origin"]\nurl = ${"\\".repeat(size)}`,
      `[${" ".repeat(size)}remote "origin"]`,
      `[remote "origin"]\n${"url\n".repeat(size / 4)}`,
      `[remote "${"\\".repeat(size)}`,
    ]
    const script = `import { GitLayout } from ${JSON.stringify(module)}
const texts = JSON.parse(await Bun.stdin.text())
for (const text of texts) GitLayout.remoteUrl(text)
console.log("done", texts.length)`
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: new Blob([JSON.stringify(hostile)]), stdout: "pipe", stderr: "pipe" })
    const deadline = setTimeout(() => child.kill(), 20_000)
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
    clearTimeout(deadline)
    expect(out.trim()).toBe(`done ${hostile.length}`)
  }, 30_000)
})
