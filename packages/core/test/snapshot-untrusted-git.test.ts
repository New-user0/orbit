import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Snapshot } from "@orbit/core/snapshot"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
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

// The nested repository is left out of an untrusted snapshot, so its folder is not a gitlink in the index. One still can be
// there: a repository that an earlier version wrote holds it, and so does a folder whose exclusion lost a race with a
// `git init` in it. The comparison of the index with the work tree then has to leave the nested repository alone, which
// only `--ignore-submodules=all` ensures: this seeds the gitlink into Orbit's own index so that the rows reach that guard.
// The entry names the commit that the nested repository is at, so that git takes the folder for an unchanged submodule and
// goes inside it to look for what is modified, which is what starts the program of the nested repository.
const seedGitlink = (data: string, root: string, folder: string) =>
  Effect.promise(async () => {
    const snapshots = path.join(data, "snapshot", "untrusted")
    const [name] = await fs.readdir(snapshots)
    const directory = path.join(snapshots, name!)
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: path.join(root, folder) }).stdout.toString().trim()
    await git(directory, "--git-dir=" + directory, "update-index", "--add", "--cacheinfo", `160000,${head},${folder}`)
  })

describe("Snapshot starts no git in the folder's own repository while it is not trusted", () => {
  it.live(
    "works from Orbit's own git directory, and still leaves out what .gitignore names",
    () =>
      Effect.gen(function* () {
        const { value, git } = yield* run(false)

        expect(value.before).toBeDefined()
        expect(value.after).toBeDefined()
        expect(value.files).toEqual(["a.txt"])
        expect(git.length).toBeGreaterThan(0)
        expect(git.filter((command) => !own(command))).toEqual([])
      }),
    SLOW,
  )

  it.live(
    "starts git in the folder's repository when it is trusted (control)",
    () =>
      Effect.gen(function* () {
        const { git } = yield* run(true)

        expect(git.filter((command) => !own(command)).length).toBeGreaterThan(0)
      }),
    SLOW,
  )
})

// Class 1 (round 2): a directory of the folder that is a repository itself is a gitlink in the snapshot index, and git
// starts a status inside it, with the config that repository ships, whenever it compares the index with the work tree.
// Each row plants a key into a nested repository `sub`, and the plain command of the row is the live control.
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
          const layer = AppNodeBuilder.build(Snapshot.node, [
            WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
            Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(outer.root) }))),
            Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
          ])
          const { git } = yield* traced(
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              const first = yield* snapshot.capture()
              yield* seedGitlink(data, outer.root, "sub")
              yield* Effect.promise(() => fs.writeFile(path.join(outer.root, "a.txt"), "three\n"))
              const second = yield* snapshot.capture()
              yield* snapshot.capture()
              if (!first || !second) return expect.unreachable("capture is disabled")
              yield* snapshot.files({ from: first, to: second })
              yield* snapshot.diff({ from: first, to: second })
              yield* snapshot.restore({ files: new Map([[RelativePath.make("a.txt"), first]]) })
            }).pipe(Effect.provide(layer)),
          )

          expect(git.filter((command) => !own(command))).toEqual([])
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

const layerFor = (root: string, data: string, implicit: boolean) =>
  AppNodeBuilder.build(Snapshot.node, [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
    Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
    Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
  ])

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
        const traces = yield* traced(
          Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            yield* seedGitlink(data, root, "sub")
            yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "two\n"))
            const second = yield* snapshot.capture()
            yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            yield* snapshot.files({ from: first, to: second })
            yield* snapshot.diff({ from: first, to: second })
            yield* snapshot.restore({ files: new Map([[RelativePath.make("a.txt"), first]]) })
          }).pipe(Effect.provide(layerFor(root, data, false))),
        )

        expect(traces.git.filter((command) => !own(command))).toEqual([])
        expect(yield* ran()).toBe("")
        yield* Effect.promise(() => git(path.join(root, "sub"), "status").catch(() => undefined))
        expect((yield* ran()).length).toBeGreaterThan(0)
      }),
    SLOW,
  )
})

// Class 6 (round 4): git looks inside every untracked folder for a `.git` entry, and a `.git` file naming a share, or a
// `.git` folder whose `commondir` names one, makes it open that share. While the folder is not trusted nothing of the
// kind may be reached. The oracle is the Windows DNS client cache: a name that something tried to open is cached, but
// only for a few seconds, so a watcher polls the cache for the whole run. The control is a plain open of a second unique
// name by this process, which the watcher must also see. Other systems have no such share syntax, so there the rows check
// only what is recorded.
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

describe("Snapshot reaches no share named by a nested .git entry in an untrusted folder", () => {
  const pointer = (name: string) => async (folder: string, host: string) => {
    await Bun.write(path.join(folder, name), `gitdir: \\\\${host}\\share\\repo\n`)
  }
  const rows: ReadonlyArray<{
    name: string
    plant: (folder: string, host: string) => Promise<void>
    nested: string
    /** A .gitignore (path from the root, text) that tries to bring the nested folder back. */
    negate?: readonly [string, string]
  }> = [
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
    // A .gitignore of the clone ranks above the snapshot repository's info/exclude, so a negation there re-includes the
    // folder unless the exclusion is also given on the command line.
    { name: "root .gitignore !/sub/", nested: "sub", plant: pointer(".git"), negate: [".gitignore", "!/sub/\n"] },
    { name: "root .gitignore !sub", nested: "sub", plant: pointer(".git"), negate: [".gitignore", "!sub\n"] },
    { name: "root .gitignore !*", nested: "sub", plant: pointer(".git"), negate: [".gitignore", "!*\n"] },
    {
      name: "a nested .gitignore !sub/",
      nested: path.join("a", "b", "sub"),
      plant: pointer(".git"),
      negate: [path.join("a", "b", ".gitignore"), "!sub/\n"],
    },
  ]

  for (const row of rows)
    it.live(
      row.name,
      () =>
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
          })
          const data = (yield* tmpdirScoped()).path
          const stop = windows ? yield* Effect.promise(watch) : undefined
          const files = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const first = yield* snapshot.capture()
            // The nested file changes as well, so that what is recorded shows whether the folder was walked.
            yield* Effect.promise(async () => {
              await fs.appendFile(path.join(root, "top.txt"), "more\n")
              await fs.appendFile(path.join(folder, "inner.txt"), "more\n")
            })
            const second = yield* snapshot.capture()
            if (!first || !second) return expect.unreachable("capture is disabled")
            return (yield* snapshot.files({ from: first, to: second })).map(String)
          }).pipe(Effect.provide(layerFor(root, data, false)))
          yield* Effect.promise(() => fs.stat(`\\\\${control}\\share\\x`).catch(() => undefined))
          const names = stop ? yield* Effect.promise(stop) : undefined

          // The nested folder is left out; the rest of the folder is still recorded.
          expect(files).toEqual(["top.txt"])
          if (!names) return
          expect(names.has(control)).toBe(true)
          expect(names.has(host)).toBe(false)
        }),
      SLOW,
    )
})
