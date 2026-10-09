// A path that names the project through another spelling of its own folder is decided where it really is: a link in the
// repository below it is followed, the rules see the project's own name, and a share or device spelling is refused before
// any disk is read (class 3, class 4, class 8; task permissions-23).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

const provideProject = (directory: string, trusted: boolean) =>
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node, ProjectTrust.node]), [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ),
      Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
      ...(trusted ? [] : untrustedProjectNodes),
    ]),
  )

// The project with a folder `secret` and a link `docs` to a folder outside, and the other spellings of its folder that
// this machine has: a link to it from outside (every platform) and the system junctions of Windows.
const layout = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const project = path.join(tmp, "project")
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
  const spellings = [{ name: "a link to the project", spelled: path.join(tmp, "alias") }, ...windows]
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

  // A link of the repository whose target is a share is named as the link says and no disk is read for it: the host does
  // not exist, so a connection to it would fail or wait. It needs a clone that makes symlinks (Developer Mode).
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "names a repository link to a share without connecting to it",
    () =>
      Effect.gen(function* () {
        const { project } = yield* layout
        const share = "\\\\orbit-no-such-host.invalid\\share\\dir"
        const linked = yield* Effect.promise(() =>
          fs.symlink(share, path.join(project, "shared"), "dir").then(
            () => true,
            () => false,
          ),
        )
        if (!linked) return
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const trust = yield* ProjectTrust.Service
          const started = Date.now()
          const target = yield* access.resolve({ path: "shared/sub/a.txt" })
          expect(target.place).toBe(AbsolutePath.make(path.join(share, "sub", "a.txt")))
          expect(target.externalDirectory).toMatchObject({
            escaped: true,
            directory: path.join(share, "sub"),
            save: `${(path.join(share, "sub") as string).replaceAll("\\", "/")}/*`,
          })
          expect(yield* trust.escapes(path.join(project, "shared", "a.txt"))).toBe(path.join(share, "a.txt"))
          expect(yield* trust.reachable(path.join(project, "shared", "a.txt"))).toBe(false)
          expect(Date.now() - started).toBeLessThan(1_000)
        }).pipe(provideProject(project, false))
      }),
  )

  // Share and device spellings are refused before any disk is read. `Volume{…}` does not exist: a refusal that read the
  // disk first would fail in another way.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "refuses a share or device spelling with a typed failure, whether or not the project is trusted",
    () =>
      Effect.gen(function* () {
        const { project } = yield* layout
        const drive = project.slice(0, 1)
        const rest = project.slice(3)
        const spellings = [
          `\\\\localhost\\${drive}$\\${rest}\\secret\\key.txt`,
          `\\\\127.0.0.1\\${drive}$\\${rest}`,
          `\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\${rest}\\secret\\key.txt`,
          `\\\\.\\Volume{00000000-0000-0000-0000-000000000000}\\${rest}\\secret\\key.txt`,
          `\\\\?\\UNC\\localhost\\${drive}$\\${rest}`,
          "//localhost/C$/Windows",
        ]
        for (const trusted of [false, true])
          yield* Effect.gen(function* () {
            const access = yield* FileAccess.Service
            for (const spelling of spellings) {
              const failure = yield* access.resolve({ path: spelling }).pipe(Effect.flip)
              expect([spelling, failure]).toMatchObject([spelling, { code: "file.spelling" }])
            }
          }).pipe(provideProject(project, trusted))
      }),
  )
})
