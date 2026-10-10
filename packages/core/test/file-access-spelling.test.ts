// A path that names the project through another spelling of its own folder is decided where it really is: a link in the
// repository below it is followed, the rules see the project's own name, and a share or device spelling is refused before
// any disk is read (class 3, class 4, class 8; task permissions-23).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { spawnSync } from "child_process"
import { Effect, Layer } from "effect"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { recordedFileSystem, sharesTouched } from "./fixture/recorded-fs"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

const provideProject = (directory: string, trusted: boolean, recorded?: ReturnType<typeof recordedFileSystem>) =>
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node, ProjectTrust.node]), [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      ...(trusted ? [] : untrustedProjectNodes),
      ...(recorded === undefined ? [] : [FSUtil.node.replace(recorded.layer)]),
    ]),
  )

// The project with a folder `secret` and a link `docs` to a folder outside, and the other spellings of its folder that
// this machine has: a link to it from outside (every platform) and the system junctions of Windows.
const layout = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const project = path.join(tmp, "workspace-project")
  const outside = path.join(tmp, "outside")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(project, "secret"), { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(path.join(project, "secret", "key.txt"), "key")
    await fs.writeFile(path.join(outside, "notes.md"), "outside")
    await fs.symlink(outside, path.join(project, "docs"), "junction")
    await fs.symlink(project, path.join(tmp, "alias"), "junction")
  })
  const windows = [
    {
      name: "Documents and Settings",
      spelled: project.replace(/^[A-Za-z]:\\Users\\/i, "C:\\Documents and Settings\\"),
    },
    {
      name: "Local Settings",
      spelled: project.replace(/^(.*?\\Users\\[^\\]+)\\AppData\\Local\\/i, "$1\\Local Settings\\"),
    },
  ].filter((item) => process.platform === "win32" && item.spelled !== project)
  // The 8.3 short names of the project's folder, and of it and the folders above it. Only where the volume makes them.
  const shortened = process.platform === "win32" ? shortPath(project) : project
  const short =
    shortened === project
      ? []
      : [
          { name: "the short name of the project's folder", spelled: path.join(tmp, path.basename(shortened)) },
          { name: "the short name of the project's folder and the ones above it", spelled: shortened },
        ]
  const spellings = [{ name: "a link to the project", spelled: path.join(tmp, "alias") }, ...windows, ...short]
  const existing = yield* Effect.promise(() =>
    Promise.all(
      spellings.map((item) =>
        fs.stat(item.spelled).then(
          () => [item],
          () => [],
        ),
      ),
    ),
  )
  return { project, outside, spellings: existing.flat() }
})

function shortPath(file: string) {
  const result = spawnSync("cmd", ["/d", "/c", `for %I in ("${file}") do @echo %~sI`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  })
  return result.stdout.trim() || file
}

describe("FileAccess for another spelling of the project's folder", () => {
  it.live("decides every spelling as the project's own name, and follows a repository link below it", () =>
    Effect.gen(function* () {
      const { project, outside, spellings } = yield* layout
      yield* Effect.gen(function* () {
        const access = yield* FileAccess.Service
        for (const spelling of spellings) {
          const key = yield* access.resolve({ path: path.join(spelling.spelled, "secret", "key.txt") })
          expect([spelling.name, key.absolute, key.resource, key.externalDirectory]).toEqual([
            spelling.name,
            AbsolutePath.make(path.join(project, "secret", "key.txt")),
            "secret/key.txt",
            undefined,
          ])
          // A file that is not there yet, in a folder that is not either.
          const created = yield* access.resolve({ path: path.join(spelling.spelled, "secret", "new", "a.txt") })
          expect([spelling.name, created.resource]).toEqual([spelling.name, "secret/new/a.txt"])
          // The link of the repository leads out, as it does for the plain spelling.
          for (const name of ["notes.md", "new.md"]) {
            const through = yield* access.resolve({ path: path.join(spelling.spelled, "docs", name) })
            expect([spelling.name, through.place, through.externalDirectory?.escaped]).toEqual([
              spelling.name,
              AbsolutePath.make(path.join(outside, name)),
              true,
            ])
            expect(through.absolute).toBe(AbsolutePath.make(path.join(project, "docs", name)))
          }
        }
      }).pipe(provideProject(project, false))
    }),
  )

  // Fails visibly on a Windows volume that makes no 8.3 names, rather than passing without a check of them.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "has 8.3 short-name spellings of the project to decide",
    () =>
      Effect.gen(function* () {
        const { spellings } = yield* layout
        expect(spellings.filter((item) => item.name.includes("short name")).length).toBe(2)
      }),
  )

  it.live("follows the link of a trusted project as for the plain spelling, with no folder question", () =>
    Effect.gen(function* () {
      const { project, spellings } = yield* layout
      yield* Effect.gen(function* () {
        const access = yield* FileAccess.Service
        for (const spelling of spellings) {
          const through = yield* access.resolve({ path: path.join(spelling.spelled, "docs", "notes.md") })
          expect([spelling.name, through.resource, through.externalDirectory]).toEqual([
            spelling.name,
            "docs/notes.md",
            undefined,
          ])
        }
      }).pipe(provideProject(project, true))
    }),
  )

  it.live("meets a person's deny and ask rules under the project's own name for every spelling", () =>
    Effect.gen(function* () {
      const { project, spellings } = yield* layout
      const rules = [
        { action: "Read", resource: "*", effect: "allow" },
        { action: "Read", resource: "secret/*", effect: "deny" },
        { action: "Read", resource: "secret/new/*", effect: "ask" },
      ] satisfies Permission.Ruleset
      yield* Effect.gen(function* () {
        const access = yield* FileAccess.Service
        for (const spelling of spellings)
          for (const [file, effect] of [
            ["secret/key.txt", "deny"],
            ["secret/new/a.txt", "ask"],
          ] as const) {
            const target = yield* access.resolve({ path: path.join(spelling.spelled, file) })
            expect([spelling.name, file, Permission.evaluate("Read", target.resource, rules).effect]).toEqual([
              spelling.name,
              file,
              effect,
            ])
          }
      }).pipe(provideProject(project, false))
    }),
  )

  // A link of the repository whose target is a share, in any spelling, is refused as a share given directly is, before
  // anything is asked: the person's rules name a folder as a drive path, so a question about the share's spelling would turn
  // their deny into an ask, and approving it would connect to the host. The test layer records every path the file system
  // is called with, so the rows pin that no share was touched, not how fast the answer came. It needs a clone that makes
  // symlinks (Developer Mode), and fails visibly without one.
  const shareLinks = (project: string, outside: string) => {
    const drive = project.slice(0, 1)
    const rest = outside.slice(3)
    return [
      { name: "a localhost admin share", target: `\\\\localhost\\${drive}$\\${rest}`, share: true },
      { name: "a 127.0.0.1 admin share", target: `\\\\127.0.0.1\\${drive}$\\${rest}`, share: true },
      { name: "a \\\\?\\UNC admin share", target: `\\\\?\\UNC\\localhost\\${drive}$\\${rest}`, share: true },
      {
        name: "a \\\\?\\Volume path",
        target: `\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\${rest}`,
        share: true,
      },
      {
        name: "a \\\\.\\Volume path",
        target: `\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\${rest}`,
        share: true,
      },
      {
        name: "a share host",
        target: `\\\\orbit-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.invalid\\share\\dir`,
        share: true,
      },
    ]
  }
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "refuses a repository link to a share, in every spelling, with a typed failure and touches no share",
    () =>
      Effect.gen(function* () {
        const { project, outside } = yield* layout
        const links = shareLinks(project, outside)
        // The spelling a link reads back as: the system may write a target as a drive path, which is then no share.
        const reads = yield* Effect.promise(async () =>
          Promise.all(
            links.map(async (link, index) => {
              await fs.symlink(link.target, path.join(project, `shared${index}`), "dir")
              const read = await fs.readlink(path.join(project, `shared${index}`))
              return read.startsWith("\\\\") || read.startsWith("\\??\\")
            }),
          ),
        )
        // Every row reads back as a share (`\\host`, or the NT form `\??\` of a device path), so the table cannot pass
        // without checking one.
        expect(reads).toEqual(links.map(() => true))
        const recorded = recordedFileSystem()
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          for (const [index, link] of links.entries()) {
            if (!reads[index]) continue
            recorded.touched.length = 0
            recorded.calls.length = 0
            // Every tool resolves a path through `resolve`; a shell command's plain words through `escaped`.
            for (const below of [
              `shared${index}`,
              `shared${index}/a.txt`,
              `shared${index}/sub/a.txt`,
              `shared${index}/AB~1/a.txt`,
              `shared${index}/sub/AB~1/a.txt`,
              `shared${index}/PROJEC~1`,
            ]) {
              for (const kind of [undefined, "file", "directory"] as const) {
                const failure = yield* access.resolve({ path: below, kind }).pipe(Effect.flip)
                expect([link.name, below, kind, failure]).toMatchObject([
                  link.name,
                  below,
                  kind,
                  { code: "file.spelling" },
                ])
              }
            }
            const word = yield* access.escaped([path.join(project, `shared${index}`, "a.txt")]).pipe(Effect.flip)
            expect([link.name, word]).toMatchObject([link.name, { code: "file.spelling" }])
            expect([link.name, sharesTouched(recorded.touched)]).toEqual([link.name, []])
            // A call on the link's own path follows the link and opens the share, which `sharesTouched` cannot see
            // (its path is a drive path), so only `readLink` may name the link or a path below it.
            const at = path.join(project, `shared${index}`).toLowerCase()
            expect([
              link.name,
              recorded.calls.filter((call) => {
                const [method, ...rest] = call.split(" ")
                const file = rest.join(" ").toLowerCase()
                return method !== "readLink" && (file === at || file.startsWith(at + path.sep))
              }),
            ]).toEqual([link.name, []])
          }
        }).pipe(provideProject(project, false, recorded))
      }),
  )

  // The same link under the person's deny of the folder it names, and the control through a junction to that folder.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "refuses a repository link to a share that names the person's denied folder, where a junction to it is denied",
    () =>
      Effect.gen(function* () {
        const { project, outside } = yield* layout
        const rules = [
          { action: "external_directory", resource: "*", effect: "ask" },
          { action: "external_directory", resource: `${outside.replaceAll("\\", "/")}/*`, effect: "deny" },
        ] satisfies Permission.Ruleset
        const target = `\\\\localhost\\${project.slice(0, 1)}$\\${outside.slice(3)}`
        yield* Effect.promise(() => fs.symlink(target, path.join(project, "shared"), "dir"))
        const recorded = recordedFileSystem()
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const junction = yield* access.resolve({ path: "docs/notes.md" })
          expect(junction.externalDirectory?.escaped).toBe(true)
          expect(Permission.evaluate("external_directory", junction.externalDirectory!.resource, rules).effect).toBe(
            "deny",
          )
          recorded.touched.length = 0
          recorded.calls.length = 0
          const failure = yield* access.resolve({ path: "shared/notes.md" }).pipe(Effect.flip)
          expect(failure).toMatchObject({ code: "file.spelling" })
          expect(sharesTouched(recorded.touched)).toEqual([])
          // Only `readLink` may name the link or a path below it: any other call follows it and opens the share.
          const at = path.join(project, "shared").toLowerCase()
          expect(
            recorded.calls.filter((call) => {
              const [method, ...rest] = call.split(" ")
              const file = rest.join(" ").toLowerCase()
              return method !== "readLink" && (file === at || file.startsWith(at + path.sep))
            }),
          ).toEqual([])
        }).pipe(provideProject(project, false, recorded))
        // The owner trusted the folder: its link is its own, and nothing is refused.
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const through = yield* access.resolve({ path: "shared/notes.md" })
          expect([through.resource, through.externalDirectory]).toEqual(["shared/notes.md", undefined])
        }).pipe(provideProject(project, true))
      }),
  )

  // Share and device spellings are refused before any disk is read. `Volume{…}` does not exist, and the hosts are of
  // their own to each run: the recorded paths show that none was stat'ed, opened or read.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "refuses a share or device spelling with a typed failure, whether or not the project is trusted, and touches no share",
    () =>
      Effect.gen(function* () {
        const { project } = yield* layout
        const drive = project.slice(0, 1)
        const rest = project.slice(3)
        const host = `orbit-probe-${Date.now()}-${Math.random().toString(36).slice(2)}.invalid`
        const spellings = [
          `\\\\localhost\\${drive}$\\${rest}\\secret\\key.txt`,
          `\\\\127.0.0.1\\${drive}$\\${rest}`,
          `\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\${rest}\\secret\\key.txt`,
          `\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\${rest}\\secret\\key.txt`,
          `\\\\?\\UNC\\localhost\\${drive}$\\${rest}`,
          "//localhost/C$/Windows",
          `\\\\${host}\\share\\a.txt`,
          `//${host}/share/a.txt`,
          `\\\\?\\UNC\\${host}\\share\\a.txt`,
        ]
        for (const trusted of [false, true]) {
          const recorded = recordedFileSystem()
          yield* Effect.gen(function* () {
            const access = yield* FileAccess.Service
            recorded.touched.length = 0
            for (const spelling of spellings) {
              const failure = yield* access.resolve({ path: spelling }).pipe(Effect.flip)
              expect([spelling, failure]).toMatchObject([spelling, { code: "file.spelling" }])
            }
            // A command's plain word that is a share is asked about as the shell asks, and read by nobody.
            expect(
              yield* access.escaped(spellings.map((spelling) => FileAccess.resolvePath(project, spelling))),
            ).toEqual([])
            expect(sharesTouched(recorded.touched)).toEqual([])
          }).pipe(provideProject(project, trusted, recorded))
        }
      }),
  )

  it.live(
    "finds a shell word through every spelling that a repository link leads out of, as for the plain spelling",
    () =>
      Effect.gen(function* () {
        const { project, outside, spellings } = yield* layout
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const plain = yield* access.escaped([path.join(project, "docs", "notes.md")])
          expect(plain.map((item) => item.place)).toEqual([AbsolutePath.make(path.join(outside, "notes.md"))])
          for (const spelling of spellings) {
            const found = yield* access.escaped([
              path.join(spelling.spelled, "docs", "notes.md"),
              path.join(spelling.spelled, "docs", "new.md"),
            ])
            expect([
              spelling.name,
              found.map((item) => item.place),
              found.map((item) => item.externalDirectory?.escaped),
            ]).toEqual([
              spelling.name,
              [AbsolutePath.make(path.join(outside, "notes.md")), AbsolutePath.make(path.join(outside, "new.md"))],
              [true, true],
            ])
            // A word that stays in the project, or is not in it at all, is not asked about.
            expect(yield* access.escaped([path.join(spelling.spelled, "secret", "key.txt"), outside])).toEqual([])
          }
        }).pipe(provideProject(project, false))
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          for (const spelling of spellings)
            expect(yield* access.escaped([path.join(spelling.spelled, "docs", "notes.md")])).toEqual([])
        }).pipe(provideProject(project, true))
      }),
  )

  // A drive made from the project's folder is the project: the root is the first part that is asked about.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "decides a drive made from the project's folder as the project",
    () =>
      Effect.gen(function* () {
        const { project, outside } = yield* layout
        const free = yield* Effect.promise(async () => {
          for (const letter of "QRSTUVWXYZ") {
            if (
              await fs.stat(`${letter}:\\`).then(
                () => false,
                () => true,
              )
            )
              return letter
          }
          return undefined
        })
        if (free === undefined) return yield* Effect.die("no free drive letter for subst")
        const drive = `${free}:`
        expect(Bun.spawnSync(["subst", drive, project]).exitCode).toBe(0)
        yield* Effect.addFinalizer(() => Effect.sync(() => void Bun.spawnSync(["subst", drive, "/D"])))
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const key = yield* access.resolve({ path: `${drive}\\secret\\key.txt` })
          expect([key.absolute, key.resource, key.externalDirectory]).toEqual([
            AbsolutePath.make(path.join(project, "secret", "key.txt")),
            "secret/key.txt",
            undefined,
          ])
          const through = yield* access.resolve({ path: `${drive}\\docs\\notes.md` })
          expect([through.place, through.externalDirectory?.escaped]).toEqual([
            AbsolutePath.make(path.join(outside, "notes.md")),
            true,
          ])
        }).pipe(provideProject(project, false))
      }).pipe(Effect.scoped),
  )
})
