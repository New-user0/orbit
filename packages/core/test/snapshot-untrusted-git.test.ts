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

// Class 1 and class 6 (review of #118): git opens whatever the repository it runs in names, such as `include.path` (a file
// or a share), `core.worktree`, `core.excludesFile` and the chain of `objects/info/alternates`. While a folder is not
// trusted a snapshot therefore starts no git in the folder's own repository: every process it starts works in Orbit's own
// git directory. The oracle is git's trace of the processes it starts, and a trusted folder is the control that the same
// calls do start git in the folder's repository.
const it = testEffect(Layer.empty)
const SLOW = 90_000

const run = (implicit: boolean) =>
  Effect.gen(function* () {
    const found = yield* planted(keys[0]!)
    // What git would open for the folder if it ran there: an include and an alternate object directory.
    yield* Effect.promise(async () => {
      await fs.appendFile(
        path.join(found.root, ".git", "config"),
        `[include]\n\tpath = ${path.join(found.folder, "shared.cfg").replaceAll("\\", "/")}\n`,
      )
      await fs.mkdir(path.join(found.root, ".git", "objects", "info"), { recursive: true })
      await fs.writeFile(
        path.join(found.root, ".git", "objects", "info", "alternates"),
        path.join(found.folder, "elsewhere").replaceAll("\\", "/") + "\n",
      )
      await fs.writeFile(path.join(found.root, ".gitignore"), "*.log\n")
    })
    const data = (yield* tmpdirScoped()).path
    const layer = AppNodeBuilder.build(Snapshot.node, [
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
      Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(found.root) }))),
      Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
    ])
    return yield* traced(
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const before = yield* snapshot.capture()
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(found.root, "a.txt"), "three\n")
          await fs.writeFile(path.join(found.root, "debug.log"), "noise\n")
        })
        const after = yield* snapshot.capture()
        return {
          before,
          after,
          files: before && after ? (yield* snapshot.files({ from: before, to: after })).map(String) : [],
        }
      }).pipe(Effect.provide(layer)),
    )
  })

// Git's trace names the work tree of the repository a process works in; Orbit's own is under its data folder.
const own = (command: string) => command.replaceAll("\\", "/").includes("/snapshot/")

const layerFor = (root: string, data: string, implicit: boolean) =>
  AppNodeBuilder.build(Snapshot.node, [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
    Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
    Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
  ])

/** Two captures of the folder at `root` while it is not trusted, with a change in between, and what git started. */
const untrustedCaptures = (root: string, data: string, change: () => Promise<unknown>) =>
  traced(
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const first = yield* snapshot.capture()
      yield* Effect.promise(change)
      return [first, yield* snapshot.capture()]
    }).pipe(Effect.provide(layerFor(root, data, false))),
  )

// A folder that is a repository of its own is a gitlink in a snapshot index once it is recorded: a trusted folder records
// it, and an untrusted one could if its `.git` appeared after the scan. Git then starts a status inside it, with the config
// that repository ships, whenever it compares the index with the work tree, unless the comparison passes
// `--ignore-submodules=all`. This runs the Git service by itself, with a repository of Orbit's over the folder: its first
// capture records the gitlink, and the later calls compare and restore.
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
// control. While the folder is not trusted it gets no snapshot and starts no git (round 6; the share rows below say why).
// Orbit's own repository, with the folder recorded as a gitlink, starts nothing inside it either.
// Mutations: removing the skip from `Snapshot.capture` fails the untrusted half of every row; removing
// `--ignore-submodules=all` from the `diff-files` of `Git.index.refresh` fails the gitlink half.
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
          const untrusted = yield* untrustedCaptures(outer.root, data, () =>
            fs.writeFile(path.join(outer.root, "a.txt"), "three\n"),
          )
          const guarded = yield* traced(gitlinkGuard(outer.root))

          expect(untrusted.value).toEqual([undefined, undefined])
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

// Class 1 and class 6 (round 3): the folder's `.gitattributes` picks drivers by name and the person's own config says
// which program each is. Orbit's untrusted snapshot repository unsets them, so a capture, a comparison and a restore start
// no program of the person's config for the folder's files and open no host that `.lfsconfig` names.
const fwd = (file: string) => file.replaceAll("\\", "/")

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
  // `reuse` starts from a repository an earlier version made: its index is filled and it has no attributes file.
  const driverRow = (implicit: boolean, reuse: boolean) =>
    it.live(
      `a clean filter picked by .gitattributes (trusted: ${implicit}${reuse ? ", repository of an earlier version" : ""})`,
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
              `[diff "probe"]\n\ttextconv = "echo textconv >> ${fwd(marker)}; cat"\n[filter "probe"]\n\tclean = "echo clean >> ${fwd(marker)}; cat"\n`,
            )
            await fs.writeFile(path.join(root, ".gitattributes"), "*.txt diff=probe filter=probe\n")
            await fs.writeFile(path.join(root, "a.txt"), "one\n")
          })
          const read = () => Effect.promise(() => fs.readFile(marker, "utf8").catch(() => ""))
          const data = (yield* tmpdirScoped()).path
          const compare = (trusted: boolean) =>
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              const before = yield* snapshot.capture()
              yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "two\n"))
              const after = yield* snapshot.capture()
              if (!before || !after) return expect.unreachable("capture is disabled")
              yield* snapshot.diff({ from: before, to: after })
            }).pipe(Effect.provide(layerFor(root, data, trusted)))
          yield* withGlobalConfig(
            globalConfig,
            Effect.gen(function* () {
              if (reuse) {
                // Make the earlier version's repository: capture once, then take the attributes file away.
                yield* compare(false)
                yield* Effect.promise(async () => {
                  const parent = path.join(data, "snapshot", "untrusted")
                  await Promise.all(
                    (await fs.readdir(parent)).map((name) =>
                      fs.rm(path.join(parent, name, "info", "attributes"), { force: true }),
                    ),
                  )
                  await fs.rm(marker, { force: true })
                  await fs.writeFile(path.join(root, "a.txt"), "one\n")
                })
              }
              yield* compare(implicit)
            }),
          )

          // Trusted control: the filter is live, so an empty marker above is not a vacuous pass.
          if (implicit) expect(yield* read()).toContain("clean")
          else expect(yield* read()).toBe("")
        }),
      SLOW,
    )

  driverRow(false, false)
  driverRow(false, true)
  driverRow(true, false)

  // The textconv program is run by the comparison itself, so it gets its own row; the control is the plain command in
  // the folder. The comparison of a trusted folder keeps its textconv programs (the next rows).
  it.live(
    "a textconv program picked by .gitattributes",
    () =>
      Effect.gen(function* () {
        const base = (yield* tmpdirScoped()).path
        const root = path.join(base, "clone")
        yield* repository(root)
        const marker = path.join(base, "marker.txt")
        const globalConfig = path.join(base, "global.gitconfig")
        yield* Effect.promise(async () => {
          await fs.writeFile(globalConfig, `[diff "probe"]\n\ttextconv = "echo textconv >> ${fwd(marker)}; cat"\n`)
          await fs.writeFile(path.join(root, ".gitattributes"), "*.txt diff=probe\n")
          await fs.writeFile(path.join(root, "a.txt"), "one\n")
        })
        const data = (yield* tmpdirScoped()).path
        yield* withGlobalConfig(
          globalConfig,
          Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "two\n"))
            const after = yield* snapshot.capture()
            if (!before || !after) return expect.unreachable("capture is disabled")
            yield* snapshot.diff({ from: before, to: after })
            yield* snapshot.files({ from: before, to: after })
          }).pipe(Effect.provide(layerFor(root, data, false))),
        )
        const read = () => Effect.promise(() => fs.readFile(marker, "utf8").catch(() => ""))
        expect(yield* read()).toBe("")
        yield* withGlobalConfig(
          globalConfig,
          Effect.promise(async () => {
            await git(root, "add", "a.txt")
            await git(root, "commit", "-m", "two")
            await fs.writeFile(path.join(root, "a.txt"), "three\n")
            await git(root, "diff").catch(() => undefined)
          }),
        )
        expect((yield* read()).length).toBeGreaterThan(0)
      }),
    SLOW,
  )

  // Class 14 (M4 round 3 re-check): a repository that an earlier version made has no `info/attributes`, and its index may
  // hold entries that a clean filter of the person's config rewrote. Capturing an unchanged file keeps such an entry, and a
  // restore would write the cleaned text over the person's file, so the index is dropped when the file is written. The row
  // above builds its earlier repository with the current code, so its index holds no cleaned entry and it cannot see this.
  // Mutation: the `fs.remove(index)` line deleted in `Snapshot` gives "CLEANED\n" here.
  it.live(
    "gives back the person's bytes on a restore from a repository of an earlier version whose index holds cleaned entries",
    () =>
      Effect.gen(function* () {
        const base = (yield* tmpdirScoped()).path
        const root = path.join(base, "clone")
        yield* repository(root)
        const globalConfig = path.join(base, "global.gitconfig")
        yield* Effect.promise(async () => {
          await fs.writeFile(globalConfig, `[filter "probe"]\n\tclean = "sed s/one/CLEANED/"\n`)
          await fs.writeFile(path.join(root, ".gitattributes"), "*.txt filter=probe\n")
          await fs.writeFile(path.join(root, "b.txt"), "one\n")
        })
        const data = (yield* tmpdirScoped()).path

        const restored = yield* withGlobalConfig(
          globalConfig,
          Effect.gen(function* () {
            // The repository as the current code makes it, then made to look like an earlier version's: no attributes file,
            // and an index filled by `git add` under the clean filter.
            yield* Effect.gen(function* () {
              yield* (yield* Snapshot.Service).capture()
            }).pipe(Effect.provide(layerFor(root, data, false)))
            const parent = path.join(data, "snapshot", "untrusted")
            const [name] = yield* Effect.promise(() => fs.readdir(parent))
            const gitDirectory = path.join(parent, name!)
            yield* Effect.promise(async () => {
              await fs.rm(path.join(gitDirectory, "info", "attributes"), { force: true })
              await fs.rm(path.join(gitDirectory, "index"), { force: true })
              // An old modification time, so that a later capture trusts the index entry of the unchanged file.
              const old = new Date(Date.now() - 60_000)
              await fs.utimes(path.join(root, "b.txt"), old, old)
              await git(root, "--git-dir", gitDirectory, "--work-tree", root, "add", "--all")
              await new Promise((resolve) => setTimeout(resolve, 1100))
            })
            // The upgraded code: capture, change the file, restore.
            return yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              const first = yield* snapshot.capture()
              yield* Effect.promise(() => fs.writeFile(path.join(root, "b.txt"), "edited\n"))
              if (!first) return expect.unreachable("capture is disabled")
              yield* snapshot.restore({ files: new Map([[RelativePath.make("b.txt"), first]]) })
              return yield* Effect.promise(() => fs.readFile(path.join(root, "b.txt"), "utf8"))
            }).pipe(Effect.provide(layerFor(root, data, false)))
          }),
        )

        expect(restored).toBe("one\n")
      }),
    SLOW,
  )

  // The attributes file unsets every `diff` driver, so a textconv program is out of reach already; `--no-textconv` is the
  // second line, and the untrusted row takes the first away by writing the folder's driver into the attributes file of the
  // snapshot repository after it was made. A trusted folder compares as it did before this round and shows the converted
  // text, which is the control.
  // Mutation: `--no-textconv` taken out of the comparison fails the untrusted row; passing it for a trusted folder as well
  // fails the control.
  for (const implicit of [false, true])
    it.live(
      implicit
        ? "compares a trusted folder with the textconv program its attributes name (control)"
        : "runs no textconv program for a comparison even when the snapshot repository's attributes name one",
      () =>
        Effect.gen(function* () {
          const base = (yield* tmpdirScoped()).path
          const root = path.join(base, "clone")
          yield* repository(root)
          const marker = path.join(base, "marker.txt")
          const globalConfig = path.join(base, "global.gitconfig")
          yield* Effect.promise(async () => {
            await fs.writeFile(globalConfig, `[diff "probe"]\n\ttextconv = "echo textconv >> ${fwd(marker)}; cat"\n`)
            await fs.writeFile(path.join(root, ".gitattributes"), "*.txt diff=probe\n")
            await fs.writeFile(path.join(root, "a.txt"), "one\n")
          })
          const data = (yield* tmpdirScoped()).path

          const files = yield* withGlobalConfig(
            globalConfig,
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              const before = yield* snapshot.capture()
              if (!implicit) {
                const parent = path.join(data, "snapshot", "untrusted")
                const [name] = yield* Effect.promise(() => fs.readdir(parent))
                yield* Effect.promise(() =>
                  fs.writeFile(path.join(parent, name!, "info", "attributes"), "*.txt diff=probe\n"),
                )
              }
              yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "two\n"))
              const after = yield* snapshot.capture()
              if (!before || !after) return expect.unreachable("capture is disabled")
              return (yield* snapshot.diff({ from: before, to: after })).map((item) => item.file)
            }).pipe(Effect.provide(layerFor(root, data, implicit))),
          )

          const ran = yield* Effect.promise(() => fs.readFile(marker, "utf8").catch(() => ""))
          expect(files).toContain("a.txt")
          if (implicit) expect(ran).not.toBe("")
          else expect(ran).toBe("")
        }),
      SLOW,
    )

  const lfs = Bun.spawnSync(["git", "lfs", "version"]).exitCode === 0
  for (const implicit of [false, true])
    (lfs ? it.live : it.live.skip)(
      `an LFS pointer with .lfsconfig naming a host (trusted: ${implicit})`,
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
          const restored = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* Effect.promise(() => fs.writeFile(path.join(root, "data.bin"), "changed\n"))
            const second = yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            return yield* snapshot
              .restore({ files: new Map([[RelativePath.make("data.bin"), first]]) })
              .pipe(Effect.as("ok"), Effect.catchCause(() => Effect.succeed("failed")))
          }).pipe(Effect.provide(layerFor(root, data, implicit)), Effect.ensuring(Effect.sync(() => server.stop(true))))

          if (implicit) return expect(hits.length).toBeGreaterThan(0)
          expect(hits).toEqual([])
          expect(restored).toBe("ok")
          expect(yield* Effect.promise(() => fs.readFile(path.join(root, "data.bin"), "utf8"))).toContain("git-lfs")
        }),
      SLOW,
    )
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
        const ran = () =>
          Effect.promise(async () => ((await Bun.file(marker).exists()) ? await Bun.file(marker).text() : ""))
        const data = (yield* tmpdirScoped()).path
        const untrusted = yield* untrustedCaptures(root, data, () => fs.writeFile(path.join(root, "a.txt"), "two\n"))
        const guarded = yield* traced(gitlinkGuard(root))

        expect(untrusted.value).toEqual([undefined, undefined])
        expect(untrusted.git).toEqual([])
        expect(guarded.git.length).toBeGreaterThan(0)
        expect(guarded.git.filter((command) => !own(command))).toEqual([])
        expect(yield* ran()).toBe("")
        yield* Effect.promise(() => git(path.join(root, "sub"), "status").catch(() => undefined))
        expect((yield* ran()).length).toBeGreaterThan(0)
      }),
    SLOW,
  )
})

// Class 6 (rounds 4 to 6): git looks inside every folder it has not recorded for a `.git` entry, and a `.git` file naming
// a share, or a `.git` folder whose `commondir` names one, makes it open that share. Leaving such a folder out did not hold:
// a `.gitignore` negation named it back (round 4), and then a file beside it whose name git read as a pattern for it
// (`[s]ub`) led `add` there again (round 5). So while the folder is not trusted a capture whose scope holds such an entry is
// skipped before any git starts. The oracle is the Windows DNS client cache: a name that something tried to open is cached,
// but only for a few seconds, so a watcher polls the cache for the whole run. The control is a plain open of a second
// unique name by this process, which the watcher must also see. Other systems have no such share syntax, so there the rows
// check that no git started and nothing was recorded.
const windows = process.platform === "win32"

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

describe("Snapshot takes no snapshot, and reaches no share, in an untrusted folder that holds a nested .git entry", () => {
  const pointer = (name: string) => async (folder: string, host: string) => {
    await Bun.write(path.join(folder, name), `gitdir: \\\\${host}\\share\\repo\n`)
  }
  interface Row {
    readonly name: string
    readonly nested: string
    /** Writes the entry into the nested folder; none leaves the folder a plain one. */
    readonly plant?: (folder: string, host: string) => Promise<void>
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
  ]
  const negations: readonly Row[] = [
    { name: "root .gitignore !/sub/", nested: "sub", negate: [".gitignore", "!/sub/\n"] },
    { name: "root .gitignore !sub", nested: "sub", negate: [".gitignore", "!sub\n"] },
    { name: "root .gitignore !*", nested: "sub", negate: [".gitignore", "!*\n"] },
    {
      name: "a nested .gitignore !sub/",
      nested: path.join("a", "b", "sub"),
      negate: [path.join("a", "b", ".gitignore"), "!sub/\n"],
    },
  ]
  // Windows allows no `*` in a name.
  const globs = windows ? ["[s]ub"] : ["[s]ub", "*", "s*"]
  const rows: readonly Row[] = [
    ...spellings,
    ...negations.flatMap((row) =>
      globs.map((glob) => ({ ...row, name: `${row.name}, beside a file named ${glob}`, plant: pointer(".git"), glob })),
    ),
  ]

  /**
   * The row's folder, the captures of it, what git started, the folders that the skip logged and which names were looked
   * up (Windows only).
   */
  const scene = (row: Row, implicit: boolean) =>
    Effect.gen(function* () {
      const logged: string[] = []
      const logger = Logger.make((entry) => {
        const [message, fields] = Array.isArray(entry.message) ? entry.message : [entry.message]
        if (message !== "no snapshot: the folder is not trusted and holds a nested git repository") return
        logged.push(typeof fields === "object" && fields !== null && "folder" in fields ? String(fields.folder) : "")
      })
      const root = path.join((yield* tmpdirScoped()).path, "clone")
      const host = unique("nested")
      const control = unique("control")
      yield* repository(root)
      const folder = path.join(root, row.nested)
      yield* Effect.promise(async () => {
        await fs.mkdir(folder, { recursive: true })
        await row.plant?.(folder, host)
        await Bun.write(path.join(folder, "inner.txt"), "inner\n")
        await Bun.write(path.join(root, "top.txt"), "top\n")
        if (row.negate) await Bun.write(path.join(root, row.negate[0]), row.negate[1])
        if (row.glob) await Bun.write(path.join(path.dirname(folder), row.glob), "glob\n")
      })
      const data = (yield* tmpdirScoped()).path
      const stop = windows && row.plant ? yield* Effect.promise(watch) : undefined
      const run = yield* traced(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const first = yield* snapshot.capture()
          // The nested file changes as well, so that what is recorded shows whether the folder was walked.
          yield* Effect.promise(async () => {
            await fs.appendFile(path.join(root, "top.txt"), "more\n")
            await fs.appendFile(path.join(folder, "inner.txt"), "more\n")
          })
          const second = yield* snapshot.capture()
          const files = first && second ? (yield* snapshot.files({ from: first, to: second })).map(String) : []
          return { first, second, files }
        }).pipe(Effect.provide(layerFor(root, data, implicit)), Effect.provide(Logger.layer([logger]))),
      )
      if (stop) yield* Effect.promise(() => fs.stat(`\\\\${control}\\share\\x`).catch(() => undefined))
      const names = stop ? yield* Effect.promise(stop) : undefined
      const recorded = yield* Effect.promise(() => fs.readdir(path.join(data, "snapshot")).catch(() => []))
      // A logged folder is the nested one when no path leads from one to the other (any letter case on Windows).
      const real = yield* Effect.promise(() => fs.realpath(folder))
      return {
        ...run.value,
        git: run.git,
        recorded,
        logged: logged.map((item) => (item && path.relative(real, item) === "" ? "nested" : item)),
        names,
        host,
        control,
        inner: fwd(path.join(row.nested, "inner.txt")),
      }
    })

  // Mutations: removing the skip from `Snapshot.capture` fails every row (a capture is taken and git starts), and so does
  // removing its log line.
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
          // One line for each skipped step, naming the nested folder.
          expect(result.logged).toEqual(["nested", "nested"])
          if (!result.names) return
          expect(result.names.has(result.control)).toBe(true)
          expect(result.names.has(result.host)).toBe(false)
        }),
      SLOW,
    )

  // Control: the same folder is captured once it is trusted, and git then opens the share that the entry names, which shows
  // that the planted entry is live (on Windows, where the oracle can see it).
  it.live(
    "captures the same folder when it is trusted, and git then looks the share up (control)",
    () =>
      Effect.gen(function* () {
        const row = rows.find((item) => item.glob === "[s]ub" && item.negate?.[1] === "!*\n")!
        const result = yield* scene(row, true)

        expect(result.first).toBeDefined()
        expect(result.files).toEqual([result.inner, "top.txt"])
        expect(result.logged).toEqual([])
        if (!result.names) return
        expect(result.names.has(result.control)).toBe(true)
        expect(result.names.has(result.host)).toBe(true)
      }),
    SLOW,
  )

  // Control: an untrusted folder with the same negation and the same file names, but no `.git` entry in the folder, is
  // captured as before, from Orbit's own git directory, and its nested folder is recorded.
  it.live(
    "captures an untrusted folder that holds no nested .git entry (control)",
    () =>
      Effect.gen(function* () {
        const result = yield* scene(
          { name: "plain", nested: "sub", negate: [".gitignore", "!*\n"], glob: "[s]ub" },
          false,
        )

        expect(result.first).toBeDefined()
        expect(result.files).toEqual([result.inner, "top.txt"])
        expect(result.logged).toEqual([])
        expect(result.git.length).toBeGreaterThan(0)
        expect(result.git.filter((command) => !own(command))).toEqual([])
      }),
    SLOW,
  )
})

// Every folder: git reads a path as a pattern unless it is told otherwise, and a file can be named like one. Each row puts
// such a file beside a file `sub` that the pattern matches, in a trusted folder.
// Mutations: `--literal-pathspecs` removed from the restore's `checkout` fails the restore rows, from the comparison's
// `diff` the same rows, from the refresh's `add` the "records no large file" rows, and from its `rm` the "keeps a recorded
// file" rows.
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
          expect(yield* Effect.promise(() => fs.readFile(path.join(folder.root, name), "utf8"))).toBe("one\n")
          expect(yield* Effect.promise(() => fs.readFile(path.join(folder.root, "sub"), "utf8"))).toBe("two\n")
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
  }
})
