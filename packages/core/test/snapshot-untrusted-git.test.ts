import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Git } from "@orbit/core/git"
import { Location } from "@orbit/core/location"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Snapshot } from "@orbit/core/snapshot"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { git, repository } from "./fixture/git"
import { keys, live, plain, planted } from "./fixture/git-keys"
import { traced } from "./fixture/git-trace"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Classes 1, 4 and 6 (review of #118, M4 verification rounds 2 to 7): every git command applies config that a clone
// chooses, the folder's own and that of each nested repository git looks into while it walks the work tree, even when the
// command runs from a git directory of Orbit's. That config names programs (`core.fsmonitor`, hooks, the drivers that
// `.gitattributes` picks) and files or shares to open (`include.path`, alternates, a `.git` file naming `\\host\share`).
// Each narrower guard of the earlier rounds left another spelling open, so while a folder is not trusted the undo snapshot
// starts no git at all: its steps get no snapshot, comparing and restoring fail, and one log line says why. The oracle is
// git's own trace of every process it starts (`GIT_TRACE2`), a marker program for each key, and on Windows the DNS client
// cache for a share. Each describe has a trusted control in which the same calls do start git and the planted thing is
// reached.
// Mutations: letting `Snapshot.capture` go on while the folder is not trusted fails every untrusted capture row; taking the
// trust check out of the comparison and the restore fails "fails to compare or restore ..."; dropping the log line fails
// the rows that count it.
const it = testEffect(Layer.empty)
const SLOW = 90_000
const windows = process.platform === "win32"
const notice = "no snapshot while the folder is not trusted: undo is unavailable for these steps"

const fwd = (file: string) => file.replaceAll("\\", "/")

// Git's trace names the work tree of the repository a process works in; Orbit's own is under its data folder.
const own = (command: string) => fwd(command).includes("/snapshot/")

const layerFor = (root: string, data: string, implicit: boolean) =>
  AppNodeBuilder.build(Snapshot.node, [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
    Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
    Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
  ])

/**
 * What the snapshot calls of two session steps do in the folder at `root`: a capture, `change`, a second capture, and when
 * both were taken a comparison and a restore of `file` from the first. It returns the snapshots, the changed files, what git
 * started, the lines the untrusted notice logged and the folders under Orbit's snapshot directory.
 */
const steps = (input: {
  readonly root: string
  readonly data: string
  readonly trusted: boolean
  readonly change: () => Promise<unknown>
  readonly file?: string
}) =>
  Effect.gen(function* () {
    const logged: string[] = []
    const logger = Logger.make((entry) => {
      const [message] = Array.isArray(entry.message) ? entry.message : [entry.message]
      if (message === notice) logged.push(notice)
    })
    const run = yield* traced(
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const first = yield* snapshot.capture()
        yield* Effect.promise(input.change)
        const second = yield* snapshot.capture()
        if (!first || !second) return { first, second, files: [] as string[] }
        const files = (yield* snapshot.files({ from: first, to: second })).map(String)
        yield* snapshot.diff({ from: first, to: second })
        if (input.file) yield* snapshot.restore({ files: new Map([[RelativePath.make(input.file), first]]) })
        return { first, second, files }
      }).pipe(Effect.provide(layerFor(input.root, input.data, input.trusted)), Effect.provide(Logger.layer([logger]))),
    )
    const recorded = yield* Effect.promise(() => fs.readdir(path.join(input.data, "snapshot")).catch(() => []))
    return { ...run.value, git: run.git, logged, recorded }
  })

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8").catch(() => ""))

// The rows of the earlier rule, "works from Orbit's own git directory, and still leaves out what .gitignore names", ran
// git from a directory of Orbit's while the folder was untrusted; under this rule nothing starts until it is trusted.
describe("Snapshot starts no git while the folder is not trusted", () => {
  // The folder's own config names a file system monitor, an include and an alternate object directory, and it ignores
  // `*.log`.
  const armed = Effect.gen(function* () {
    const found = yield* planted(keys.find((key) => key.name === "core.fsmonitor")!)
    yield* Effect.promise(async () => {
      await fs.appendFile(
        path.join(found.root, ".git", "config"),
        `[include]\n\tpath = ${fwd(path.join(found.folder, "shared.cfg"))}\n`,
      )
      await fs.mkdir(path.join(found.root, ".git", "objects", "info"), { recursive: true })
      await fs.writeFile(
        path.join(found.root, ".git", "objects", "info", "alternates"),
        fwd(path.join(found.folder, "elsewhere")) + "\n",
      )
      await fs.writeFile(path.join(found.root, ".gitignore"), "*.log\n")
    })
    return found
  })
  const change = (root: string) => async () => {
    await fs.writeFile(path.join(root, "a.txt"), "three\n")
    await fs.writeFile(path.join(root, "debug.log"), "noise\n")
  }

  it.live(
    "takes no snapshot, starts no git and runs no program of the folder's config, and logs why once",
    () =>
      Effect.gen(function* () {
        expect((yield* live(keys.find((key) => key.name === "core.fsmonitor")!)).length).toBeGreaterThan(0)
        const found = yield* armed
        const data = (yield* tmpdirScoped()).path
        const result = yield* steps({ root: found.root, data, trusted: false, change: change(found.root) })

        expect(result.first).toBeUndefined()
        expect(result.second).toBeUndefined()
        expect(result.git).toEqual([])
        expect(result.recorded).toEqual([])
        expect(result.logged).toEqual([notice])
        expect(yield* found.ran()).toEqual([])
      }),
    SLOW,
  )

  it.live(
    "captures, compares and restores the same folder once it is trusted, and leaves out what .gitignore names (control)",
    () =>
      Effect.gen(function* () {
        const found = yield* armed
        const data = (yield* tmpdirScoped()).path
        const result = yield* steps({
          root: found.root,
          data,
          trusted: true,
          change: change(found.root),
          file: "a.txt",
        })

        expect(result.first).toBeDefined()
        expect(result.files).toEqual(["a.txt"])
        expect(result.logged).toEqual([])
        expect(result.git.filter((command) => !own(command)).length).toBeGreaterThan(0)
        expect(yield* read(path.join(found.root, "a.txt"))).toBe("two\n")
      }),
    SLOW,
  )

  // Snapshots that a session took while the folder was trusted stay in its history when trust is taken away.
  it.live(
    "fails to compare or restore snapshots taken while it was trusted, and starts no git",
    () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        yield* repository(root)
        yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "one\n"))
        const data = (yield* tmpdirScoped()).path
        const taken = yield* Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const first = yield* snapshot.capture()
          yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "two\n"))
          return { first: first!, second: (yield* snapshot.capture())! }
        }).pipe(Effect.provide(layerFor(root, data, true)))
        expect(taken.first).toBeDefined()

        const run = yield* traced(
          Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            return [
              yield* Effect.flip(snapshot.files({ from: taken.first, to: taken.second })),
              yield* Effect.flip(snapshot.diff({ from: taken.first, to: taken.second })),
              yield* Effect.flip(snapshot.restore({ files: new Map([[RelativePath.make("a.txt"), taken.first]]) })),
            ].map((error) => `${error.operation}: ${error.message}`)
          }).pipe(Effect.provide(layerFor(root, data, false))),
        )

        expect(run.value).toEqual(
          ["files", "diff", "restore"].map((operation) => `${operation}: The folder is not trusted`),
        )
        expect(run.git).toEqual([])
        expect(yield* read(path.join(root, "a.txt"))).toBe("two\n")
      }),
    SLOW,
  )
})

// A folder that is a repository of its own is a gitlink in a snapshot index once a trusted folder records it. Git then
// starts a status inside it, with the config that repository ships, whenever it compares the index with the work tree,
// unless the comparison passes `--ignore-submodules=all`. This runs the Git service by itself, with a repository of Orbit's
// over the folder: its first capture records the gitlink, and the later calls compare and restore.
const gitlinkGuard = (root: string) =>
  Effect.gen(function* () {
    const data = (yield* tmpdirScoped()).path
    const git = yield* Git.Service
    const repository = yield* git.repo.create({
      worktree: AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root))),
      gitDirectory: AbsolutePath.make(path.join(data, "snapshot", "own")),
    })
    const scopes = [RelativePath.make(".")]
    const first = yield* git.tree.capture({ repository, scopes })
    yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "three\n"))
    const second = yield* git.tree.capture({ repository, scopes })
    yield* git.tree.capture({ repository, scopes })
    yield* git.tree.files({ repository, from: first, to: second })
    yield* git.tree.diff({ repository, from: first, to: second })
    yield* git.tree.restore({ repository, files: new Map([[RelativePath.make("a.txt"), first]]) })
  }).pipe(Effect.provide(LayerNode.compile(Git.node)))

// Class 1 (round 2): each row plants a key into a nested repository `sub`, and the plain command of the row is the live
// control. While the folder is not trusted no git starts at all. Orbit's own repository, with the folder recorded as a
// gitlink, starts nothing inside it either.
// Mutations: the untrusted capture going on fails the untrusted half of every row; `GitSubmodules.skip` leaving
// `--ignore-submodules=all` off the `diff-files` of `Git.index.refresh` fails the gitlink half.
describe("Snapshot starts no git program of a repository nested in an untrusted folder", () => {
  const rows = ["core.fsmonitor", "core.hooksPath", ".git/hooks"].map((name) => keys.find((key) => key.name === name)!)

  for (const key of rows) {
    it.live(
      `${key.name} in a nested repository`,
      () =>
        Effect.gen(function* () {
          expect((yield* live(key)).length).toBeGreaterThan(0)

          const outer = yield* planted(keys.find((item) => item.name === "core.pager")!)
          const nested = yield* planted(key)
          yield* Effect.promise(async () => {
            await fs.cp(nested.root, path.join(outer.root, "sub"), { recursive: true })
          })
          const data = (yield* tmpdirScoped()).path
          const untrusted = yield* steps({
            root: outer.root,
            data,
            trusted: false,
            change: () => fs.writeFile(path.join(outer.root, "a.txt"), "three\n"),
          })
          const guarded = yield* traced(gitlinkGuard(outer.root))

          expect([untrusted.first, untrusted.second]).toEqual([undefined, undefined])
          expect(untrusted.git).toEqual([])
          expect(guarded.git.length).toBeGreaterThan(0)
          expect(guarded.git.filter((command) => !own(command))).toEqual([])
          expect(yield* nested.ran()).toEqual([])
          // Control: the same program does run when the nested repository is used as a repository.
          yield* Effect.promise(() => plain(path.join(outer.root, "sub"), key.trigger!, key.input))
          expect((yield* nested.ran()).length).toBeGreaterThan(0)
        }),
      SLOW,
    )
  }
})

// Class 14 (round 2 re-check): a clone with submodules keeps each one's repository under `.git/modules/<name>`, and the
// submodule's `.git` is a file that points there. The plain command in the submodule is the control that the key is live.
// Mutations as for the nested rows above.
describe("Snapshot starts nothing of a submodule's repository in an untrusted folder", () => {
  it.live(
    "a .git file pointing into .git/modules, with core.fsmonitor set there",
    () =>
      Effect.gen(function* () {
        const base = (yield* tmpdirScoped()).path
        const root = path.join(base, "clone")
        const marker = path.join(base, "ran.txt")
        const program = path.join(base, "evil.sh")
        const source = path.join(base, "source")
        yield* Effect.promise(async () => {
          await Bun.write(program, `#!/bin/sh\necho "ran $*" >> "${fwd(marker)}"\nexit 1\n`)
          await fs.chmod(program, 0o755)
        })
        yield* repository(root)
        yield* repository(source)
        yield* Effect.promise(async () => {
          await git(root, "-c", "protocol.file.allow=always", "submodule", "add", fwd(source), "sub")
          await git(root, "commit", "-m", "sub")
          await git(path.join(root, ".git", "modules", "sub"), "config", "core.fsmonitor", fwd(program))
        })
        expect((yield* Effect.promise(() => fs.stat(path.join(root, "sub", ".git")))).isFile()).toBe(true)
        const data = (yield* tmpdirScoped()).path
        const untrusted = yield* steps({
          root,
          data,
          trusted: false,
          change: () => fs.writeFile(path.join(root, "a.txt"), "two\n"),
        })
        const guarded = yield* traced(gitlinkGuard(root))

        expect([untrusted.first, untrusted.second]).toEqual([undefined, undefined])
        expect(untrusted.git).toEqual([])
        expect(guarded.git.length).toBeGreaterThan(0)
        expect(guarded.git.filter((command) => !own(command))).toEqual([])
        expect(yield* read(marker)).toBe("")
        yield* Effect.promise(() => git(path.join(root, "sub"), "status").catch(() => undefined))
        expect((yield* read(marker)).length).toBeGreaterThan(0)
      }),
    SLOW,
  )
})

// Class 1 and class 6 (round 3): the folder's `.gitattributes` picks drivers by name and the person's own config says which
// program each is: a clean filter runs on a capture, a textconv program on a comparison, and git-lfs on a restore, which
// asks the host that the folder's `.lfsconfig` names. A trusted folder runs them, which is the control of each row.
const withGlobalConfig = <A, E, R>(file: string, body: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = file
    return body.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
          else process.env.GIT_CONFIG_GLOBAL = previous
        }),
      ),
    )
  })

describe("Snapshot runs no attribute driver of the person's config for an untrusted folder's files", () => {
  const drivers = [
    { name: "a clean filter", section: `filter "probe"`, key: "clean", attribute: "filter=probe" },
    { name: "a textconv program", section: `diff "probe"`, key: "textconv", attribute: "diff=probe" },
  ]

  for (const driver of drivers)
    for (const trusted of [false, true])
      it.live(
        `${driver.name} picked by .gitattributes (${trusted ? "trusted: the control" : "untrusted"})`,
        () =>
          Effect.gen(function* () {
            const base = (yield* tmpdirScoped()).path
            const root = path.join(base, "clone")
            yield* repository(root)
            const marker = path.join(base, "marker.txt")
            const globalConfig = path.join(base, "global.gitconfig")
            yield* Effect.promise(async () => {
              await fs.writeFile(
                globalConfig,
                `[${driver.section}]\n\t${driver.key} = "echo ran >> ${fwd(marker)}; cat"\n`,
              )
              await fs.writeFile(path.join(root, ".gitattributes"), `*.txt ${driver.attribute}\n`)
              await fs.writeFile(path.join(root, "a.txt"), "one\n")
            })
            const data = (yield* tmpdirScoped()).path
            const result = yield* withGlobalConfig(
              globalConfig,
              steps({ root, data, trusted, change: () => fs.writeFile(path.join(root, "a.txt"), "two\n") }),
            )

            if (trusted) return expect((yield* read(marker)).length).toBeGreaterThan(0)
            expect([result.first, result.second]).toEqual([undefined, undefined])
            expect(result.git).toEqual([])
            expect(yield* read(marker)).toBe("")
          }),
        SLOW,
      )

  const lfs = Bun.spawnSync(["git", "lfs", "version"]).exitCode === 0
  for (const trusted of [false, true])
    (lfs ? it.live : it.live.skip)(
      `an LFS pointer with .lfsconfig naming a host (${trusted ? "trusted: the control" : "untrusted"})`,
      () =>
        Effect.gen(function* () {
          const hits: string[] = []
          const server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch(request) {
              hits.push(`${request.method} ${new URL(request.url).pathname}`)
              return new Response("{}", { status: 404, headers: { "content-type": "application/vnd.git-lfs+json" } })
            },
          })
          const base = (yield* tmpdirScoped()).path
          const root = path.join(base, "clone")
          yield* repository(root)
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(root, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
            await fs.writeFile(path.join(root, ".lfsconfig"), `[lfs]\n\turl = http://127.0.0.1:${server.port}/lfs\n`)
            await fs.writeFile(
              path.join(root, "data.bin"),
              "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12\n",
            )
          })
          const data = (yield* tmpdirScoped()).path
          const result = yield* steps({
            root,
            data,
            trusted,
            change: () => fs.writeFile(path.join(root, "data.bin"), "changed\n"),
            file: "data.bin",
          }).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
            Effect.ensuring(Effect.sync(() => server.stop(true))),
          )

          if (trusted) return expect(hits.length).toBeGreaterThan(0)
          expect(hits).toEqual([])
          expect(result?.git).toEqual([])
          expect(yield* read(path.join(root, "data.bin"))).toBe("changed\n")
        }),
      SLOW,
    )
})

// Class 4 and class 6 (rounds 4 to 7): git looks inside every folder it has not recorded for a `.git` entry, and a `.git`
// file naming a share, or a `.git` folder whose `commondir` names one, makes it open that share. Leaving such a folder out
// did not hold: a `.gitignore` negation named it back (round 4), a file beside it whose name git read as a pattern for it
// (`[s]ub`) led `add` there again (round 5), and a scan for such entries left out top-level folders that git does walk,
// such as `git~2`, and outside Windows `.GIT`, `git~1` and `.git.` (round 6). Each row plants one of these shapes. The
// oracle is git's trace, and on Windows also the DNS client cache: a name that something tried to open is cached, but only
// for a few seconds, so a watcher polls the cache for the whole run, and a plain open of a second unique name by this
// process is the control that it sees such lookups.
const unique = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 12)}.example.com`

/** Names under example.com that the DNS client cache held at any moment between `watch()` and `stop()`. */
const watch = async () => {
  const child = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-Command",
      "while ($true) { Get-DnsClientCache | Where-Object { $_.Entry -like '*.example.com' } | ForEach-Object { $_.Entry }; [Console]::Out.Flush() }",
    ],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  )
  const chunks: string[] = []
  const reading = (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) chunks.push(decoder.decode(chunk))
  })()
  // Let the first poll finish, so that the run starts under watch.
  await Bun.sleep(2500)
  return async () => {
    await Bun.sleep(1500)
    child.kill()
    await reading
    return new Set(chunks.join("").split(/\r?\n/).filter(Boolean))
  }
}

describe("Snapshot reaches no share, and starts no git, in an untrusted folder that holds a .git entry naming one", () => {
  const pointer = (name: string) => async (folder: string, host: string) => {
    await Bun.write(path.join(folder, name), `gitdir: \\\\${host}\\share\\repo\n`)
  }
  interface Row {
    readonly name: string
    readonly nested: string
    /** Writes the entry into the nested folder. */
    readonly plant: (folder: string, host: string) => Promise<void>
    /** A .gitignore (path from the root, text) that names the nested folder back. */
    readonly negate?: readonly [string, string]
    /** A file beside the nested folder whose name git would read as a pattern that matches the folder. */
    readonly glob?: string
  }
  const spellings: readonly Row[] = [
    { name: "a .git file in a subfolder", nested: "sub", plant: pointer(".git") },
    { name: "a .git file several folders down", nested: path.join("a", "b", "sub"), plant: pointer(".git") },
    { name: "a .git file with other letter case", nested: "sub", plant: pointer(".GIT") },
    {
      name: "a .git folder whose commondir names a share",
      nested: "sub",
      plant: async (folder, host) => {
        await fs.mkdir(path.join(folder, ".git"), { recursive: true })
        await Bun.write(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n")
        await Bun.write(path.join(folder, ".git", "commondir"), `\\\\${host}\\share\\repo\n`)
      },
    },
    // Top-level folders whose names the round 6 scan took for the folder's own `.git` and did not enter; git walks them.
    // Windows keeps `.GIT` and `.git.` as `.git` and gives `.git` the short name `git~1`.
    ...["git~2", ...(process.platform === "linux" ? [".GIT"] : []), ...(windows ? [] : ["git~1", ".git."])].map(
      (top) => ({
        name: `a .git file below a top-level folder ${top}`,
        nested: path.join(top, "sub"),
        plant: pointer(".git"),
      }),
    ),
  ]
  const negations = [
    { name: "root .gitignore !/sub/", nested: "sub", negate: [".gitignore", "!/sub/\n"] },
    { name: "root .gitignore !sub", nested: "sub", negate: [".gitignore", "!sub\n"] },
    { name: "root .gitignore !*", nested: "sub", negate: [".gitignore", "!*\n"] },
    {
      name: "a nested .gitignore !sub/",
      nested: path.join("a", "b", "sub"),
      negate: [path.join("a", "b", ".gitignore"), "!sub/\n"],
    },
  ] as const
  // Windows allows no `*` in a name.
  const globs = windows ? ["[s]ub"] : ["[s]ub", "*", "s*"]
  const rows: readonly Row[] = [
    ...spellings,
    ...negations.flatMap((row) =>
      globs.map((glob) => ({ ...row, name: `${row.name}, beside a file named ${glob}`, plant: pointer(".git"), glob })),
    ),
  ]

  /** The row's folder, the snapshot calls of two steps in it, and which names were looked up (Windows only). */
  const scene = (row: Row, trusted: boolean) =>
    Effect.gen(function* () {
      const root = path.join((yield* tmpdirScoped()).path, "clone")
      const host = unique("nested")
      const control = unique("control")
      yield* repository(root)
      const folder = path.join(root, row.nested)
      yield* Effect.promise(async () => {
        await fs.mkdir(folder, { recursive: true })
        await row.plant(folder, host)
        await Bun.write(path.join(folder, "inner.txt"), "inner\n")
        await Bun.write(path.join(root, "top.txt"), "top\n")
        if (row.negate) await Bun.write(path.join(root, row.negate[0]), row.negate[1])
        if (row.glob) await Bun.write(path.join(path.dirname(folder), row.glob), "glob\n")
      })
      const data = (yield* tmpdirScoped()).path
      const stop = windows ? yield* Effect.promise(watch) : undefined
      const result = yield* steps({
        root,
        data,
        trusted,
        // The nested file changes as well, so that what is recorded shows whether the folder was walked.
        change: async () => {
          await fs.appendFile(path.join(root, "top.txt"), "more\n")
          await fs.appendFile(path.join(folder, "inner.txt"), "more\n")
        },
        file: "top.txt",
      })
      if (stop) yield* Effect.promise(() => fs.stat(`\\\\${control}\\share\\x`).catch(() => undefined))
      const names = stop ? yield* Effect.promise(stop) : undefined
      return {
        ...result,
        names,
        host,
        control,
        top: yield* read(path.join(root, "top.txt")),
        inner: fwd(path.join(row.nested, "inner.txt")),
      }
    })

  for (const row of rows)
    it.live(
      row.name,
      () =>
        Effect.gen(function* () {
          const result = yield* scene(row, false)

          expect(result.first).toBeUndefined()
          expect(result.second).toBeUndefined()
          expect(result.git).toEqual([])
          expect(result.recorded).toEqual([])
          expect(result.logged).toEqual([notice])
          if (!result.names) return
          expect(result.names.has(result.control)).toBe(true)
          expect(result.names.has(result.host)).toBe(false)
        }),
      SLOW,
    )

  // Control: the same folder is captured and restored once it is trusted, and git then opens the share that the entry
  // names, which shows that the planted entry is live (on Windows, where the oracle can see it).
  for (const row of [
    rows.find((item) => item.glob === "[s]ub" && item.negate?.[1] === "!*\n")!,
    rows.find((item) => item.nested.startsWith("git~2"))!,
  ])
    it.live(
      `captures and restores the folder with ${row.name} when it is trusted, and git then looks the share up (control)`,
      () =>
        Effect.gen(function* () {
          const result = yield* scene(row, true)

          expect(result.first).toBeDefined()
          expect(result.files).toEqual([result.inner, "top.txt"])
          expect(result.top).toBe("top\n")
          expect(result.logged).toEqual([])
          if (!result.names) return
          expect(result.names.has(result.control)).toBe(true)
          expect(result.names.has(result.host)).toBe(true)
        }),
      SLOW,
    )
})

// The first capture of a trusted folder starts from a copy of the folder's index, which tells git which tracked files are
// unchanged. Git believes a file whose size and time match its entry only when the entry is older than the index file;
// an entry from the second the index was written is read again. Each row rewrites a tracked file to the same size and
// sets the times of the file and of the folder's index: an entry and an index of the same second (a write that came
// within the second git last wrote the index), and a rewrite a second later (control). Undo must give back the
// rewritten text. Times are set rather than waited for, so the row is the same on every platform; outside Windows git
// also compares the change time to the second, so the setup is repeated until the rewrite keeps the recorded one.
// Mutations: giving the copy the current time fails the first row on Windows and on Linux; leaving the copy's time to
// the copy fails it on Linux, where a copy is new, but not on Windows, where the copy keeps the time of the file it
// copies. The control passes either way.
describe("Snapshot captures a tracked file rewritten in the second its folder's index was written", () => {
  for (const [name, later] of [
    ["in that second", 0],
    ["a second later (control)", 1],
  ] as const)
    it.live(
      `restores the rewritten text of a file whose new time is ${name}`,
      () =>
        Effect.gen(function* () {
          const root = path.join((yield* tmpdirScoped()).path, "clone")
          yield* repository(root)
          const file = path.join(root, "a.txt")
          // A whole second in the past, which nothing the test writes shares.
          const second = new Date((Math.floor(Date.now() / 1000) - 60) * 1000)
          const rewritten = new Date(second.getTime() + later * 1000)
          yield* Effect.promise(async () => {
            for (let attempt = 0; attempt < 20; attempt++) {
              await fs.writeFile(file, "one\n")
              await fs.utimes(file, second, second)
              const recorded = (await fs.stat(file)).ctimeMs
              await git(root, "add", "a.txt")
              await fs.utimes(path.join(root, ".git", "index"), second, second)
              await fs.writeFile(file, "two\n")
              await fs.utimes(file, rewritten, rewritten)
              if (Math.floor(recorded / 1000) === Math.floor((await fs.stat(file)).ctimeMs / 1000)) return
            }
          })
          const data = (yield* tmpdirScoped()).path
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* Effect.promise(() => fs.writeFile(file, "three\n"))
            const next = yield* snapshot.capture()
            if (!first || !next) return expect.unreachable("capture is disabled")
            yield* snapshot.restore({ files: new Map([[RelativePath.make("a.txt"), first]]) })
          }).pipe(Effect.provide(layerFor(root, data, true)))

          expect(yield* read(file)).toBe("two\n")
        }),
      SLOW,
    )
})

// Every trusted folder: git reads a path as a pattern unless it is told otherwise, and a file or folder can be named like
// one. Each row puts such a name beside a file or folder `sub` that the pattern matches.
// Mutations: `--literal-pathspecs` removed from the restore's `checkout` fails the restore rows, from the comparison's
// `diff` the same rows, from the refresh's `add` the "records no large file" rows, from its `rm` the "keeps a recorded
// file" rows, and from its `ls-files` the "walks no folder sub" row on Windows and the "session started in" rows for `*`
// and `s*` elsewhere.
describe("Snapshot reads a file name that git would take for a pattern as a name", () => {
  // Over the 2 MiB that a capture records of a file it has not recorded before.
  const large = "x".repeat(3 * 1024 * 1024)
  const names = windows ? ["[s]ub"] : ["[s]ub", "*", "s*"]

  const trustedFolder = (files: Readonly<Record<string, string>>) =>
    Effect.gen(function* () {
      const root = path.join((yield* tmpdirScoped()).path, "clone")
      yield* repository(root)
      yield* Effect.promise(() =>
        Promise.all(Object.entries(files).map(([name, text]) => fs.writeFile(path.join(root, name), text))),
      )
      return { root, layer: layerFor(root, (yield* tmpdirScoped()).path, true) }
    })

  for (const name of names) {
    it.live(
      `restores and compares only the file named ${name}`,
      () =>
        Effect.gen(function* () {
          const folder = yield* trustedFolder({ [name]: "one\n", sub: "one\n" })
          const result = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(folder.root, name), "two\n")
              await fs.writeFile(path.join(folder.root, "sub"), "two\n")
            })
            const second = yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            const compared = yield* snapshot.diff({ from: first, to: second, paths: [RelativePath.make(name)] })
            yield* snapshot.restore({ files: new Map([[RelativePath.make(name), first]]) })
            return compared.map((item) => item.file)
          }).pipe(Effect.provide(folder.layer))

          expect(result).toEqual([name])
          expect(yield* read(path.join(folder.root, name))).toBe("one\n")
          expect(yield* read(path.join(folder.root, "sub"))).toBe("two\n")
        }),
      SLOW,
    )

    it.live(
      `records no large file that ${name} would match`,
      () =>
        Effect.gen(function* () {
          const folder = yield* trustedFolder({ "top.txt": "top\n" })
          const files = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(folder.root, name), "small\n")
              await fs.writeFile(path.join(folder.root, "sub"), large)
            })
            const second = yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            return (yield* snapshot.files({ from: first, to: second })).map(String)
          }).pipe(Effect.provide(folder.layer))

          expect(files).toEqual([name])
        }),
      SLOW,
    )

    it.live(
      `keeps a recorded file that ${name} would match when ${name} is too large to record`,
      () =>
        Effect.gen(function* () {
          const folder = yield* trustedFolder({ "top.txt": "top\n", sub: "one\n" })
          const files = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* Effect.promise(() => fs.writeFile(path.join(folder.root, name), large))
            const second = yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            return (yield* snapshot.files({ from: first, to: second })).map(String)
          }).pipe(Effect.provide(folder.layer))

          expect(files).toEqual([])
        }),
      SLOW,
    )

    // A session's snapshot covers the folder it started in. Each folder holds a committed file that changes between the
    // two captures, and gets a file that git does not track; `sub`'s untracked file appears only after the first capture,
    // so that a capture that did walk `sub` shows it as added. Only the session's folder may be recorded.
    it.live(
      `records nothing of a folder sub for a session started in the folder named ${name}, and restores by name`,
      () =>
        Effect.gen(function* () {
          const root = path.join((yield* tmpdirScoped()).path, "clone")
          yield* repository(root)
          const write = (text: string) =>
            Promise.all(
              [name, "sub"].flatMap((folder) => [
                fs.writeFile(path.join(root, folder, "tracked.txt"), text),
                fs.writeFile(path.join(root, folder, "new.txt"), text),
              ]),
            )
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(root, name))
            await fs.mkdir(path.join(root, "sub"))
            await write("one\n")
            await git(root, "--literal-pathspecs", "add", "--", `${name}/tracked.txt`, "sub/tracked.txt")
            await git(root, "commit", "-m", "tracked")
            await fs.rm(path.join(root, "sub", "new.txt"))
          })
          const own = [`${name}/new.txt`, `${name}/tracked.txt`]
          const files = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* Effect.promise(() => write("two\n"))
            const second = yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            const changed = (yield* snapshot.files({ from: first, to: second })).map(String)
            yield* snapshot.restore({ files: new Map(own.map((file) => [RelativePath.make(file), first])) })
            return changed
          }).pipe(Effect.provide(layerFor(path.join(root, name), (yield* tmpdirScoped()).path, true)))

          expect(files.toSorted()).toEqual(own.toSorted())
          for (const file of own) expect(yield* read(path.join(root, file))).toBe("one\n")
          for (const file of ["sub/new.txt", "sub/tracked.txt"])
            expect(yield* read(path.join(root, file))).toBe("two\n")
        }),
      SLOW,
    )
  }

  // A leading `:` is pathspec magic: `:memo` and `:(top)memo` stand for `memo`, and `:(icase)memo` and `:!memo` change how
  // git matches. Only the restore's lookup of a file in the snapshot (`ls-tree`) and the question of which paths are
  // ignored (`check-ignore`) can tell; every other command already reads names. Windows allows no `:` in a file name, so
  // the last row asks `check-ignore` there directly, with paths alone.
  // Mutations (Linux): `--literal-pathspecs` removed from the restore's `ls-tree` fails all six rows (the restore does
  // not find the file and deletes it, or stops). `ignored` handing the paths to `check-ignore` without `./` fails the
  // rows with an ignore rule (the file is left out as if ignored), the `:(icase)memo` and `:!memo` rows (the capture
  // stops), and the direct rows of the four spellings, which fail on Windows as well.
  const colons = [
    [":memo", false],
    [":(top)memo", false],
    [":(icase)memo", false],
    [":!memo", false],
    [":memo", true],
    [":(top)memo", true],
  ] as const
  for (const [name, ignoring] of colons)
    (windows ? it.live.skip : it.live)(
      `captures, lists and restores the file named ${name}${ignoring ? " when memo is ignored" : ""}, with no file memo`,
      () =>
        Effect.gen(function* () {
          const folder = yield* trustedFolder({ [name]: "one\n", ...(ignoring ? { ".gitignore": "memo\n" } : {}) })
          const files = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* Effect.promise(() => fs.writeFile(path.join(folder.root, name), "two\n"))
            const second = yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            const changed = (yield* snapshot.files({ from: first, to: second })).map(String)
            yield* snapshot.restore({ files: new Map([[RelativePath.make(name), first]]) })
            return changed
          }).pipe(Effect.provide(folder.layer))

          expect(files).toEqual([name])
          expect(yield* read(path.join(folder.root, name))).toBe("one\n")
        }),
      SLOW,
    )

  // The plain names are the controls: the same call does report an ignored path.
  const asked = [
    [":memo", false],
    [":(top)memo", false],
    [":(icase)memo", false],
    [":!memo", false],
    ["memo", true],
    ["deep/a.log", true],
    ["kept.txt", false],
  ] as const
  for (const [name, expected] of asked)
    it.live(`asks check-ignore whether ${name} itself is ignored`, () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        yield* repository(root)
        yield* Effect.promise(() => fs.writeFile(path.join(root, ".gitignore"), "memo\n*.log\n"))
        const git = yield* Git.Service.pipe(Effect.provide(AppNodeBuilder.build(Git.node)))
        const found = yield* git.repo.discover(AbsolutePath.make(root))
        if (!found) return expect.unreachable("no repository")
        const ignored = yield* git.index.ignored({ repository: found, paths: [RelativePath.make(name)] })

        expect([...ignored].map(String)).toEqual(expected ? [name] : [])
      }),
    )

  // Windows allows only `[s]ub` of these names, and that pattern stands for no file inside `sub`, so the row above records
  // the same either way there. Git still walks into a folder that the pattern matches, to see whether it is a repository
  // of its own, and reads its `.git`: one that names a share shows the walk in the DNS cache. The trusted control of the
  // share rows above shows that a walk into such a folder does look the host up.
  ;(windows ? it.live : it.live.skip)(
    "walks no folder sub for a session started in the folder named [s]ub",
    () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        const host = unique("walked")
        const control = unique("control")
        yield* repository(root)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(root, "[s]ub"))
          await fs.mkdir(path.join(root, "sub"))
          await Bun.write(path.join(root, "[s]ub", "a.txt"), "one\n")
          await Bun.write(path.join(root, "sub", "inner.txt"), "inner\n")
          await Bun.write(path.join(root, "sub", ".git"), `gitdir: \\\\${host}\\share\\repo\n`)
        })
        const data = (yield* tmpdirScoped()).path
        const stop = yield* Effect.promise(watch)
        const files = yield* Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const first = yield* snapshot.capture()
          yield* Effect.promise(() => fs.writeFile(path.join(root, "[s]ub", "a.txt"), "two\n"))
          const second = yield* snapshot.capture()
          if (!first || !second) return expect.unreachable("capture is disabled")
          return (yield* snapshot.files({ from: first, to: second })).map(String)
        }).pipe(Effect.provide(layerFor(path.join(root, "[s]ub"), data, true)))
        yield* Effect.promise(() => fs.stat(`\\\\${control}\\share\\x`).catch(() => undefined))
        const names = yield* Effect.promise(stop)

        expect(files).toEqual(["[s]ub/a.txt"])
        expect(names.has(control)).toBe(true)
        expect(names.has(host)).toBe(false)
      }),
    SLOW,
  )
})
