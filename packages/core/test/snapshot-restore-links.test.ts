import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Global } from "@orbit/util/global"
import { Location } from "@orbit/core/location"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Snapshot } from "@orbit/core/snapshot"
import { canLinkFile } from "./fixture/symlink"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// clients-ux-5: a code restore writes and deletes files in the project from a checkpoint taken earlier. Between the
// checkpoint and the restore, a folder on the way to a file can have become a link (a junction on Windows, which needs no
// privilege) that leads out of the project. A restore decides each file on its real path at the moment it writes it
// (class 4): a file with a link on the way is skipped with one log line, and nothing is written, deleted or replaced
// through it; the other files of the same restore still go back (class 7). A deletion removes only a file or a link,
// never a folder with what is in it. Every row plants a marker outside the project and has a plain file in the same
// restore as its control.

const it = testEffect(Layer.empty)
const linkType = process.platform === "win32" ? "junction" : "dir"

type Fixture = {
  readonly root: string
  readonly project: string
  readonly outside: string
}

const withProject = <A, E>(body: (fixture: Fixture) => Effect.Effect<A, E, Snapshot.Service>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir("orbit-restore-links-")),
    (tmp) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => fs.realpath(tmp.path))
        const fixture = { root, project: path.join(root, "project"), outside: path.join(root, "outside") }
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(fixture.project, "sub"), { recursive: true })
          await fs.mkdir(fixture.outside, { recursive: true })
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe one\n")
          await fs.writeFile(path.join(fixture.project, "sub", "keep.txt"), "keep one\n")
          await $`git init -q`.cwd(fixture.project).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(fixture.project).quiet()
        })
        return yield* body(fixture).pipe(
          Effect.provide(
            AppNodeBuilder.build(Snapshot.node, [
              Location.node.replace(
                Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(fixture.project) })),
              ),
              Global.node.replace(
                Global.layerWith({ data: path.join(root, "data"), config: path.join(root, "config") }),
              ),
            ]),
          ),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const capture = Effect.gen(function* () {
  const snapshot = yield* Snapshot.Service
  const tree = yield* snapshot.capture()
  if (!tree) throw new Error("snapshot missing")
  return tree
})

const text = (file: string) => Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
const isLink = (file: string) =>
  Effect.promise(() =>
    fs.lstat(file).then(
      (info) => info.isSymbolicLink(),
      () => false,
    ),
  )
const exists = (file: string) =>
  Effect.promise(() =>
    fs.stat(file).then(
      () => true,
      () => false,
    ),
  )
const restore = (files: ReadonlyArray<readonly [string, Snapshot.ID]>) =>
  Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    yield* snapshot.restore({ files: new Map(files.map(([file, tree]) => [RelativePath.make(file), tree])) })
  })

describe("Snapshot.restore through a link made after the checkpoint", () => {
  it.live("does not delete a file outside the project through a folder link, and restores the control", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.outside, "victim.txt"), "outside\n")
          await fs.symlink(fixture.outside, path.join(fixture.project, "linked"), linkType)
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        // `linked/victim.txt` is absent from the checkpoint, so a restore that followed the link would delete it.
        yield* restore([
          ["linked/victim.txt", tree],
          ["safe.txt", tree],
        ])
        expect({
          victim: yield* text(path.join(fixture.outside, "victim.txt")),
          link: yield* isLink(path.join(fixture.project, "linked")),
          safe: yield* text(path.join(fixture.project, "safe.txt")),
        }).toEqual({ victim: "outside\n", link: true, safe: "safe one\n" })
      }),
    ),
  )

  it.live("does not write through, or replace, a folder that became a link after the checkpoint", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.rename(path.join(fixture.project, "sub"), path.join(fixture.root, "moved-sub"))
          await fs.symlink(fixture.outside, path.join(fixture.project, "sub"), linkType)
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        yield* restore([
          ["sub/keep.txt", tree],
          ["safe.txt", tree],
        ])
        expect({
          written: yield* exists(path.join(fixture.outside, "keep.txt")),
          link: yield* isLink(path.join(fixture.project, "sub")),
          safe: yield* text(path.join(fixture.project, "safe.txt")),
        }).toEqual({ written: false, link: true, safe: "safe one\n" })
      }),
    ),
  )

  // A link to a folder above it inside the project stays in the project, but it still carries the write to another
  // file than the one named: `sub/keep.txt` would land as `keep.txt` in the project's own folder.
  it.live("does not write through a folder that became a link to the project itself", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.rename(path.join(fixture.project, "sub"), path.join(fixture.root, "moved-sub"))
          await fs.symlink(fixture.project, path.join(fixture.project, "sub"), linkType)
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        yield* restore([
          ["sub/keep.txt", tree],
          ["safe.txt", tree],
        ])
        expect({
          written: yield* exists(path.join(fixture.project, "keep.txt")),
          link: yield* isLink(path.join(fixture.project, "sub")),
          safe: yield* text(path.join(fixture.project, "safe.txt")),
        }).toEqual({ written: false, link: true, safe: "safe one\n" })
      }),
    ),
  )

  it.live("does not make the folder a dangling link points at, and leaves the link", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        const later = path.join(fixture.outside, "later")
        yield* Effect.promise(async () => {
          await fs.rename(path.join(fixture.project, "sub"), path.join(fixture.root, "moved-sub"))
          await fs.symlink(later, path.join(fixture.project, "sub"), linkType)
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        yield* restore([
          ["sub/keep.txt", tree],
          ["safe.txt", tree],
        ])
        expect({
          made: yield* exists(later),
          link: yield* isLink(path.join(fixture.project, "sub")),
          safe: yield* text(path.join(fixture.project, "safe.txt")),
        }).toEqual({ made: false, link: true, safe: "safe one\n" })
      }),
    ),
  )

  it.live("removes no folder, and nothing in it, where the checkpoint had no file", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(fixture.project, "grown"))
          await fs.writeFile(path.join(fixture.project, "grown", "inner.txt"), "inner\n")
          await fs.writeFile(path.join(fixture.project, "created.txt"), "created\n")
        })
        // `grown` is a folder now and absent from the checkpoint; `created.txt` is the file control, which goes.
        yield* restore([
          ["grown", tree],
          ["created.txt", tree],
        ])
        expect({
          inner: yield* text(path.join(fixture.project, "grown", "inner.txt")),
          created: yield* exists(path.join(fixture.project, "created.txt")),
        }).toEqual({ inner: "inner\n", created: false })
      }),
    ),
  )

  // The file's own name can become the link. Git writes a file there by removing what stands in its way, and on Windows
  // it takes a junction for a folder and removes the files it leads to; elsewhere it would replace the link.
  it.live("does not write over, or through, a file whose name became a link to an outside folder", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.outside, "victim.txt"), "outside\n")
          await fs.rm(path.join(fixture.project, "safe.txt"))
          await fs.symlink(fixture.outside, path.join(fixture.project, "safe.txt"), linkType)
          await fs.writeFile(path.join(fixture.project, "sub", "keep.txt"), "keep two\n")
        })
        yield* restore([
          ["safe.txt", tree],
          ["sub/keep.txt", tree],
        ])
        expect({
          victim: yield* text(path.join(fixture.outside, "victim.txt")),
          link: yield* isLink(path.join(fixture.project, "safe.txt")),
          keep: yield* text(path.join(fixture.project, "sub", "keep.txt")),
        }).toEqual({ victim: "outside\n", link: true, keep: "keep one\n" })
      }),
    ),
  )

  // Git checks a file out over a folder by removing the folder with what it holds; the person's file in it stays.
  it.live("does not replace a folder that now stands where the checkpoint had a file", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.rm(path.join(fixture.project, "safe.txt"))
          await fs.mkdir(path.join(fixture.project, "safe.txt"))
          await fs.writeFile(path.join(fixture.project, "safe.txt", "mine.txt"), "mine\n")
          await fs.writeFile(path.join(fixture.project, "sub", "keep.txt"), "keep two\n")
        })
        yield* restore([
          ["safe.txt", tree],
          ["sub/keep.txt", tree],
        ])
        expect({
          mine: yield* text(path.join(fixture.project, "safe.txt", "mine.txt")),
          keep: yield* text(path.join(fixture.project, "sub", "keep.txt")),
        }).toEqual({ mine: "mine\n", keep: "keep one\n" })
      }),
    ),
  )

  // Git makes a missing folder by removing a file that stands at its name. Where the checkpoint had the folder `sub` and
  // the person has since put a file of their own there, the restore leaves that file, and the dry run does not list it.
  it.live("does not remove a file that now stands where the checkpoint had a folder", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.rm(path.join(fixture.project, "sub"), { recursive: true })
          await fs.writeFile(path.join(fixture.project, "sub"), "mine\n")
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        const restorable = yield* snapshot.restorable([
          RelativePath.make("sub/keep.txt"),
          RelativePath.make("safe.txt"),
        ])
        yield* restore([
          ["sub/keep.txt", tree],
          ["safe.txt", tree],
        ])
        expect({
          restorable,
          mine: yield* text(path.join(fixture.project, "sub")),
          safe: yield* text(path.join(fixture.project, "safe.txt")),
        }).toEqual({ restorable: [RelativePath.make("safe.txt")], mine: "mine\n", safe: "safe one\n" })
      }),
    ),
  )

  // A file that git cannot put back (here its checkpoint is a tree the repository does not hold) costs only itself: the
  // control after it still goes back, and the restore then fails, so its caller knows it was partial (class 7).
  it.live("restores the other files when one file fails, and then fails", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
          await fs.writeFile(path.join(fixture.project, "sub", "keep.txt"), "keep two\n")
        })
        const result = yield* restore([
          ["safe.txt", Snapshot.ID.make("0".repeat(40))],
          ["sub/keep.txt", tree],
        ]).pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "succeeded" }))
        expect({
          result,
          safe: yield* text(path.join(fixture.project, "safe.txt")),
          keep: yield* text(path.join(fixture.project, "sub", "keep.txt")),
        }).toEqual({ result: "Snapshot.Error", safe: "safe two\n", keep: "keep one\n" })
      }),
    ),
  )

  // A stored path (a staged revert keeps the names it restored) that names the work tree itself would make git check
  // out every file of the tree, and one that climbs out of it would delete a file elsewhere; each is skipped alone.
  it.live("skips a path that names the work tree itself or leaves it, and restores the control", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.outside, "victim.txt"), "outside\n")
          await fs.writeFile(path.join(fixture.project, "sub", "keep.txt"), "keep two\n")
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        yield* restore([
          [".", tree],
          ["../outside/victim.txt", tree],
          ["safe.txt", tree],
        ])
        expect({
          victim: yield* text(path.join(fixture.outside, "victim.txt")),
          keep: yield* text(path.join(fixture.project, "sub", "keep.txt")),
          safe: yield* text(path.join(fixture.project, "safe.txt")),
        }).toEqual({ victim: "outside\n", keep: "keep two\n", safe: "safe one\n" })
      }),
    ),
  )

  // The work tree is the real folder found when the snapshot repository was opened. If that folder itself is moved away
  // and a link to another folder takes its name, every folder below it is still a plain folder, so only the real place of
  // the file's folder shows that the write would land outside the project.
  it.live("does not write through the project folder when its name became a link after the checkpoint", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(fixture.outside, "sub"), { recursive: true })
          await fs.writeFile(path.join(fixture.outside, "sub", "keep.txt"), "outside keep\n")
          await fs.writeFile(path.join(fixture.outside, "safe.txt"), "outside safe\n")
          await fs.rename(fixture.project, path.join(fixture.root, "moved-project"))
          await fs.symlink(fixture.outside, fixture.project, linkType)
        })
        yield* restore([
          ["sub/keep.txt", tree],
          ["safe.txt", tree],
        ]).pipe(Effect.ignore)
        expect({
          keep: yield* text(path.join(fixture.outside, "sub", "keep.txt")),
          safe: yield* text(path.join(fixture.outside, "safe.txt")),
          moved: yield* text(path.join(fixture.root, "moved-project", "safe.txt")),
        }).toEqual({ keep: "outside keep\n", safe: "outside safe\n", moved: "safe one\n" })
      }),
    ),
  )

  // A link to a network share is decided by the share it names, without opening it. Windows needs the privilege to link
  // to one (CI's runner has it), and the share must answer, or a restore that followed the link would delete nothing.
  const share = process.platform === "win32" && canLinkFile ? it.live : it.live.skip
  share("does not delete a file on a share that a folder link leads to", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const unc = `\\\\localhost\\${fixture.outside[0]}$${fixture.outside.slice(2)}`
        if (!(yield* exists(unc))) return
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.outside, "victim.txt"), "outside\n")
          await fs.symlink(unc, path.join(fixture.project, "share"), "dir")
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        yield* restore([
          ["share/victim.txt", tree],
          ["safe.txt", tree],
        ])
        expect({
          victim: yield* text(path.join(fixture.outside, "victim.txt")),
          safe: yield* text(path.join(fixture.project, "safe.txt")),
        }).toEqual({ victim: "outside\n", safe: "safe one\n" })
      }),
    ),
  )

  // Control, not a mutation target: a folder whose name changed case is the same folder on Windows and macOS, so its
  // files are not taken for files behind a link and still go back.
  const caseless = process.platform === "win32" || process.platform === "darwin" ? it.live : it.live.skip
  caseless("restores a file in a folder whose name changed case after the checkpoint", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const tree = yield* capture
        yield* Effect.promise(async () => {
          await fs.rename(path.join(fixture.project, "sub"), path.join(fixture.project, "Sub-renaming"))
          await fs.rename(path.join(fixture.project, "Sub-renaming"), path.join(fixture.project, "Sub"))
          await fs.writeFile(path.join(fixture.project, "Sub", "keep.txt"), "keep two\n")
        })
        yield* restore([["sub/keep.txt", tree]])
        expect(yield* text(path.join(fixture.project, "Sub", "keep.txt"))).toBe("keep one\n")
      }),
    ),
  )
})

// A rewind compares the checkpoint with a capture taken now. Git refuses to check or add a path beyond a link, so a
// tracked folder that became a link would fail every capture of the folder, and the rewind would answer that snapshots
// are unavailable. The tracked file behind the link leaves the capture instead, and the capture still records the
// folder's other changes (the control).
describe("Snapshot.capture after a tracked folder became a link", () => {
  it.live("takes the capture without the files behind the link, and records the control", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const before = yield* capture
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.outside, "keep.txt"), "outside\n")
          await fs.rename(path.join(fixture.project, "sub"), path.join(fixture.root, "moved-sub"))
          await fs.symlink(fixture.outside, path.join(fixture.project, "sub"), linkType)
          await fs.writeFile(path.join(fixture.project, "safe.txt"), "safe two\n")
        })
        const after = yield* capture
        const changed = yield* snapshot.diff({
          from: before,
          to: after,
          paths: [RelativePath.make("sub/keep.txt"), RelativePath.make("safe.txt")],
        })
        expect(changed.map((file) => [file.file, file.status])).toEqual([
          ["safe.txt", "modified"],
          ["sub/keep.txt", "deleted"],
        ])
      }),
    ),
  )

  // On Windows git lists the files inside a junction as untracked files of the work tree, and adds them when asked to
  // add the junction: their contents, which lie outside the project, would be stored in the snapshot and shown in diffs.
  it.live("does not capture the files a link leads to", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const before = yield* capture
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(fixture.outside, "victim.txt"), "outside\n")
          await fs.rm(path.join(fixture.project, "safe.txt"))
          await fs.symlink(fixture.outside, path.join(fixture.project, "safe.txt"), linkType)
        })
        expect(yield* snapshot.files({ from: before, to: yield* capture })).toEqual([RelativePath.make("safe.txt")])
      }),
    ),
  )
})

// A dry run of a rewind lists the files that a restore would write, by the same per-path decision as the restore.
describe("Snapshot.restorable", () => {
  it.live("drops a path with a link on the way or a link or folder at its name, and keeps the control", () =>
    withProject((fixture) =>
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        yield* Effect.promise(async () => {
          await fs.symlink(fixture.outside, path.join(fixture.project, "linked"), linkType)
          await fs.symlink(fixture.outside, path.join(fixture.project, "leaf"), linkType)
          await fs.mkdir(path.join(fixture.project, "folder"))
        })
        const names = ["linked/victim.txt", "leaf", "folder", "../outside/x.txt", "safe.txt", "gone.txt"]
        expect(yield* snapshot.restorable(names.map((name) => RelativePath.make(name)))).toEqual([
          RelativePath.make("safe.txt"),
          RelativePath.make("gone.txt"),
        ])
      }),
    ),
  )
})

// A checkpoint ID comes from a session's stored steps, and an imported session's steps are whatever its file says (class
// 5). Git reads a value that starts with `-` as an option, and `--output=<file>` makes `git diff` write that file, so a
// value that is not a tree ID is refused before git starts, by every operation that takes one. The marker is the file
// that git would write; a real tree in the same call is the control that the operation still works.
describe("Snapshot with a checkpoint ID that is not a tree", () => {
  const operations = [
    ["files", (from: Snapshot.ID, to: Snapshot.ID) => Effect.flatMap(Snapshot.Service, (s) => s.files({ from, to }))],
    ["diff", (from: Snapshot.ID, to: Snapshot.ID) => Effect.flatMap(Snapshot.Service, (s) => s.diff({ from, to }))],
    [
      "restore",
      (from: Snapshot.ID, _to: Snapshot.ID) =>
        Effect.flatMap(Snapshot.Service, (s) => s.restore({ files: new Map([[RelativePath.make("safe.txt"), from]]) })),
    ],
  ] as const

  for (const [name, operation] of operations)
    it.live(`${name} refuses an option-shaped ID and writes no file`, () =>
      withProject((fixture) =>
        Effect.gen(function* () {
          const tree = yield* capture
          const marker = path.join(fixture.root, `${name}.marker`)
          const forged = Snapshot.ID.make(`--output=${marker}`)
          // The refusal names the ID check, not a git failure: git never sees the forged value.
          const refused = yield* operation(forged, tree).pipe(
            Effect.match({ onFailure: (error) => `${error._tag}: ${error.message}`, onSuccess: () => "succeeded" }),
          )
          expect({ refused, marker: yield* exists(marker) }).toEqual({
            refused: "Snapshot.Error: The checkpoint is not a snapshot tree",
            marker: false,
          })
          // The control: a real tree goes through the same operation.
          yield* operation(tree, tree)
        }),
      ),
    )
})
