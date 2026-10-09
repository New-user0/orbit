import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Location } from "@orbit/core/location"
import { FileAccess } from "@orbit/core/file-access"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Global } from "@orbit/util/global"
import { ToolFailure } from "@orbit/ai"
import { shortName } from "./fixture/short-name"
import { tmpdirScoped, withTempDir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"

function provide(directory: string, projectDirectory = directory) {
  return Effect.provide(
    LayerNode.compile(FileAccess.node, {
      replacements: [
        Permission.node.replace(permissionLayer()),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location(
                { directory: AbsolutePath.make(directory) },
                { projectDirectory: AbsolutePath.make(projectDirectory) },
              ),
            ),
          ),
        ),
      ],
    }),
  )
}

describe("FileAccess.resolve", () => {
  it.live("resolves an active relative existing file target", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "hello.txt")
        yield* Effect.promise(() => fs.writeFile(targetPath, "hello"))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "hello.txt" })

        expect(target).toMatchObject({
          absolute: targetPath,
          resource: "hello.txt",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("resolves an active relative prospective file target", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "src")))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: path.join("src", "new.txt") })
        expect(target).toMatchObject({
          absolute: path.join(directory, "src", "new.txt"),
          resource: "src/new.txt",
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("requires external-directory authorization for a relative lexical escape", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "../outside.txt" })
        const root = path.dirname(directory)
        expect(target).toMatchObject({
          absolute: path.join(root, "outside.txt"),
          resource: path.join(root, "outside.txt").replaceAll("\\", "/"),
        })
        expect(target.externalDirectory).toMatchObject({
          directory: root,
          resource: path.join(root, "*").replaceAll("\\", "/"),
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("allows a relative path outside the Location but inside the project worktree", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const active = path.join(directory, "packages", "orbit")
        yield* Effect.promise(() => fs.mkdir(active, { recursive: true }))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "../../README.md" })
        expect(target).toMatchObject({
          absolute: path.join(directory, "README.md"),
          resource: "../../README.md",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(path.join(directory, "packages", "orbit"), directory)),
    ),
  )

  it.live("does not treat a filesystem-root project sentinel as an internal boundary", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "../outside.txt" })
        expect(target.externalDirectory).toBeDefined()
      }).pipe(provide(directory, path.parse(directory).root)),
    ),
  )

  it.live("resolves a prospective target below an external symlink lexically", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        const outside = yield* tmpdirScoped()
        yield* Effect.promise(() => fs.symlink(outside.path, path.join(directory, "escape")))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: path.join("escape", "new.txt") })
        expect(target).toMatchObject({
          absolute: path.join(directory, "escape", "new.txt"),
          resource: "escape/new.txt",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("follows an in-location symlink using ordinary filesystem semantics", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        if (process.platform === "win32") return
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, "actual"))
          await fs.symlink(path.join(directory, "actual"), path.join(directory, "linked"))
        })

        const access = yield* FileAccess.Service
        expect(yield* access.resolve({ path: "linked/new.txt" })).toMatchObject({
          absolute: path.join(directory, "linked", "new.txt"),
          resource: "linked/new.txt",
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("accepts an explicit absolute in-location target without external approval", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const targetPath = path.join(directory, "new.txt")
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: targetPath })
        expect(target).toMatchObject({
          absolute: targetPath,
          resource: "new.txt",
        })
        expect(target.externalDirectory).toBeUndefined()
      }).pipe(provide(directory)),
    ),
  )

  it.live("requires external-directory authorization for an explicit external absolute target", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "new.txt")
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: targetPath })
          const root = outside
          expect(target).toMatchObject({
            absolute: path.join(root, "new.txt"),
            resource: path.join(root, "new.txt").replaceAll("\\", "/"),
          })
          expect(target.externalDirectory).toMatchObject({
            directory: root,
            resource: path.join(root, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("resolves an existing external file target", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "existing.txt")
          yield* Effect.promise(() => fs.writeFile(targetPath, "existing"))
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: targetPath })
          expect(target).toMatchObject({ absolute: targetPath })
          expect(target.externalDirectory?.directory).toBe(AbsolutePath.make(outside))
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("uses an explicit file kind without treating an existing directory as the target boundary", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: outside, kind: "file" })
          expect(target.externalDirectory).toMatchObject({
            directory: path.dirname(outside),
            resource: path.join(path.dirname(outside), "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  it.live("authorizes prospective external descendants at their lexical parent", () =>
    withTempDir(({ path: directory }) =>
      withTempDir(({ path: outside }) =>
        Effect.gen(function* () {
          const targetPath = path.join(outside, "new", "nested", "file.txt")
          const access = yield* FileAccess.Service
          const target = yield* access.resolve({ path: targetPath })
          const parent = path.dirname(targetPath)
          expect(target.externalDirectory).toMatchObject({
            directory: parent,
            resource: path.join(parent, "*").replaceAll("\\", "/"),
          })
        }).pipe(provide(directory)),
      ),
    ),
  )

  test("ignores unknown path input fields", () => {
    expect(Schema.decodeUnknownSync(FileAccess.ResolveInput)({ path: "README.md", reference: "docs" })).toEqual({
      path: "README.md",
    })
  })

  test("expands a leading tilde against the home directory", () => {
    const home = path.resolve("/Users/aiden")
    expect(FileAccess.resolvePath("/project", "~", home)).toBe(home)
    expect(FileAccess.resolvePath("/project", "~/notes.md", home)).toBe(path.resolve(home, "notes.md"))
    expect(FileAccess.resolvePath("/project", "~draft.md", home)).toBe(path.resolve("/project", "~draft.md"))
    expect(FileAccess.resolvePath("/project", "~\\notes.md", home)).toBe(
      process.platform === "win32" ? path.resolve(home, "notes.md") : path.resolve("/project", "~\\notes.md"),
    )
  })

  test.each([
    ["/c/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
    ["/C:/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
    ["/cygdrive/c/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
    ["/mnt/c/Users/aiden/notes.md", "C:/Users/aiden/notes.md"],
  ])("normalizes Windows shell drive path %s before resolution", (input, windows) => {
    expect(FileAccess.resolvePath("/project", input)).toBe(
      process.platform === "win32" ? path.resolve(windows) : path.resolve(input),
    )
  })

  it.live("resolves a tilde path as an external home target", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: "~/notes.md" })
        const absolute = path.resolve(Global.Path.home, "notes.md")
        expect(target).toMatchObject({
          absolute,
          resource: absolute.replaceAll("\\", "/"),
        })
        expect(target.externalDirectory).toMatchObject({
          directory: Global.Path.home,
          resource: path.join(Global.Path.home, "*").replaceAll("\\", "/"),
        })
      }).pipe(provide(directory)),
    ),
  )

  it.live("treats a tilde path as in-location when the location is home", () =>
    Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const target = yield* access.resolve({ path: "~/notes.md" })
      expect(target).toMatchObject({
        absolute: path.resolve(Global.Path.home, "notes.md"),
        resource: "notes.md",
      })
      expect(target.externalDirectory).toBeUndefined()
    }).pipe(provide(Global.Path.home)),
  )
})

// On Windows one file has spellings that a rule written for its name would not see: an NTFS data stream opens the file
// or a stream of it, an 8.3 short name opens the file it stands for, trailing periods and spaces are dropped when a
// shell or ripgrep opens it, and a `\\?\` or `\\.\` prefix names the plain path. A stream is refused; every other
// spelling resolves to the name the rules are written for, so a deny or ask rule for `*.env` or `*.sh` applies to it
// (class 4, class 8). Elsewhere the rows do not run, as these spellings name other files there.
describe.skipIf(process.platform !== "win32")("FileAccess.resolve of Windows spellings", () => {
  const rules = (action: string, pattern: string, effect: Permission.Ruleset[number]["effect"]): Permission.Ruleset => [
    { action: "*", resource: "*", effect: "allow" },
    { action, resource: pattern, effect },
  ]
  const layout = (directory: string) =>
    Effect.promise(async () => {
      await fs.writeFile(path.join(directory, ".env"), "API_KEY=SECRET")
      await fs.writeFile(path.join(directory, "README.md"), "readme")
      await fs.mkdir(path.join(directory, "config folder long"))
      await fs.writeFile(path.join(directory, "config folder long", "deploy.sh"), "echo")
    })

  it.live("resolves every spelling of a file to the name its rules are written for", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        yield* layout(directory)
        const env = shortName(directory, ".env")
        const folder = shortName(directory, "config folder long")
        // The volume of the test folder makes 8.3 names, as the system volume does by default.
        expect([env, folder]).toEqual([expect.stringContaining("~"), expect.stringContaining("~")])
        const access = yield* FileAccess.Service
        const rows: ReadonlyArray<readonly [string, string]> = [
          // Controls: the plain name, and a case and separators that the rules already match.
          [".env", ".env"],
          [".ENV", ".ENV"],
          ["src\\..\\.env", ".env"],
          ["src/../.env", ".env"],
          [env!, ".env"],
          [env!.toLowerCase(), ".env"],
          [".env.", ".env"],
          [".env ", ".env"],
          [".env. .", ".env"],
          ["new.sh.", "new.sh"],
          ["new.sh  ", "new.sh"],
          [`${folder}\\deploy.sh`, "config folder long/deploy.sh"],
          [`${folder}\\deploy.sh.`, "config folder long/deploy.sh"],
          ["config folder long.\\deploy.sh", "config folder long/deploy.sh"],
          [`\\\\?\\${path.join(directory, ".env")}`, ".env"],
          [`\\\\.\\${path.join(directory, ".env")}`, ".env"],
          [`//?/${path.join(directory, ".env").replaceAll("\\", "/")}`, ".env"],
          [`\\\\?\\${path.join(directory, env!)}`, ".env"],
        ]
        for (const [spelling, resource] of rows) {
          const target = yield* access.resolve({ path: spelling })
          expect([spelling, target.resource, target.externalDirectory]).toEqual([spelling, resource, undefined])
          expect(target.place).toBe(target.absolute)
          // A rule for the file decides it, deny and ask alike: reading `*.env` and writing `*.sh`.
          const [action, pattern] = resource.endsWith(".sh") ? ["Edit", "*.sh"] : ["Read", "*.env"]
          for (const effect of ["deny", "ask"] as const)
            expect([
              spelling,
              Permission.evaluate(action, target.resource, rules(action, pattern, effect)).effect,
            ]).toEqual([spelling, effect])
        }
        // And not another file.
        const readme = yield* access.resolve({ path: "README.md" })
        expect(Permission.evaluate("Read", readme.resource, rules("Read", "*.env", "deny")).effect).toBe("allow")
      }).pipe(provide(directory)),
    ),
  )

  it.live("names a file outside the project by its long name", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        const outside = yield* tmpdirScoped()
        yield* layout(outside.path)
        const env = shortName(outside.path, ".env")
        expect(env).toEqual(expect.stringContaining("~"))
        const access = yield* FileAccess.Service
        const target = yield* access.resolve({ path: path.join(outside.path, env!) })
        expect(target.resource).toBe(path.join(outside.path, ".env").replaceAll("\\", "/"))
        expect(target.externalDirectory?.resource).toBe(path.join(outside.path, "*").replaceAll("\\", "/"))
      }).pipe(provide(directory)),
    ),
  )

  it.live("refuses a data stream, or a drive that is not a disk, before any approval", () =>
    withTempDir(({ path: directory }) =>
      Effect.gen(function* () {
        yield* layout(directory)
        const env = shortName(directory, ".env")
        const access = yield* FileAccess.Service
        for (const spelling of [
          ".env::$DATA",
          ".env:secret",
          ".env:secret:$DATA",
          `${env}::$DATA`,
          "new.sh::$DATA",
          "new.sh:payload",
          `${path.join(directory, ".env")}::$DATA`,
          "config folder long::$INDEX_ALLOCATION\\deploy.sh",
          "HKLM:\\Software",
          "FileSystem::C:\\Windows",
        ]) {
          const failure = yield* access.resolve({ path: spelling }).pipe(Effect.flip)
          expect([spelling, failure instanceof ToolFailure, failure]).toMatchObject([
            spelling,
            true,
            { code: "file.spelling" },
          ])
        }
      }).pipe(provide(directory)),
    ),
  )
})
