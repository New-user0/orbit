import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import path from "path"
import { CompatNames } from "@orbit/compat/names"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigInstructionPlugin } from "@orbit/core/config/plugin/instruction"
import { Environment } from "@orbit/core/environment/index"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { FileMutation } from "@orbit/core/file-mutation"
import { Git } from "@orbit/core/git"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { InstructionNotes } from "@orbit/core/instruction-notes"
import { Location } from "@orbit/core/location"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { Plugin } from "@orbit/core/plugin"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Document, Info } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyManagedNode } from "./fixture/config-nodes"
import { git, initRepo } from "./fixture/git"
import { type Found, folders, forgeries } from "./fixture/git-forged"
import { inner, opened, outer, shapes } from "./fixture/git-passed-over"
import { traced } from "./fixture/git-trace"
import { location } from "./fixture/location"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)

// The note writer under the loader as a server runs it, with no watcher event ever sent: whatever a test sees in the list
// came from the explicit rescan.
type Setup = {
  readonly base?: string
  readonly root: string
  readonly config: string
  readonly directory?: string
  readonly trusted?: boolean
  readonly compat?: boolean
  readonly project?: boolean
  readonly global?: boolean
  readonly excludes?: readonly string[]
  readonly spelled?: string
  readonly vcs?: "git" | "hg"
  readonly filesystem?: Layer.Layer<FSUtil.Service>
}

const layerFor = (input: Setup) => {
  const config = Config.testLayer(
    input.excludes ? [new Document({ type: "document", scope: "user", info: new Info({ instructions_exclude: [...input.excludes] }) })] : [],
    { enabled: input.compat ?? false, roots: [] },
  )
  const watcher = Watcher.testLayer
  return Layer.mergeAll(
    config,
    AppNodeBuilder.build(
      LayerNode.group([
        InstructionNotes.node,
        InstructionDiscovery.node,
        Bus.node,
        FSUtil.node,
        Global.node,
        Location.node,
        ProjectTrust.node,
        WorkspaceTrust.node,
        Watcher.node,
        ManagedSettings.node,
        FileMutation.node,
        Git.node,
      ]),
      [
        Config.node.replace(config),
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: input.trusted ?? true })),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: input.project, global: input.global })),
        Global.node.replace(Global.layerWith({ config: input.config, home: path.join(input.config, "..", "home") })),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location(
                { directory: AbsolutePath.make(input.directory ?? input.root) },
                {
                  projectDirectory: AbsolutePath.make(input.spelled ?? input.root),
                  vcs: input.vcs ? { type: input.vcs, store: AbsolutePath.make(path.join(input.root, input.vcs === "git" ? ".git" : ".hg")) } : undefined,
                },
              ),
            ),
          ),
        ),
        ...(input.filesystem ? [FSUtil.node.replace(input.filesystem)] : []),
        Watcher.node.replace(watcher),
        ManagedSettings.node.replace(emptyManagedNode),
        Environment.node.replace(Layer.mock(Environment.Service, { files: {} as never, spawner: {} as never })),
        // The plugin that registers the rescan is started by the test itself, so there is nothing to wait for.
        Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
      ],
    ),
    watcher,
  )
}

const start = Effect.gen(function* () {
  yield* ConfigInstructionPlugin.Plugin.effect(host())
  return { notes: yield* InstructionNotes.Service, discovery: yield* InstructionDiscovery.Service }
})

const scratch = Effect.gen(function* () {
  const base = (yield* tmpdirScoped()).path
  const root = path.join(base, "project")
  const config = path.join(base, "config")
  yield* Effect.promise(() => fs.mkdir(root, { recursive: true }))
  return { base, root, config }
})

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const write = (file: string, content: string) => Effect.promise(() => fs.writeFile(file, content))
const exists = (file: string) => Effect.promise(() => fs.access(file).then(() => true, () => false))
const texts = (discovery: InstructionDiscovery.Interface) =>
  discovery.list().pipe(Effect.map((files) => (Array.isArray(files) ? files.map((file) => [file.path, file.content] as const) : files)))
const contents = (discovery: InstructionDiscovery.Interface) =>
  texts(discovery).pipe(Effect.map((files) => (Array.isArray(files) ? files.map((file) => file[1]).join("\n") : "")))

// The error a call fails with, as its reason, or "ok".
const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) => Effect.succeed(error instanceof InstructionNotes.TargetError ? error.reason : "failed")),
  )

describe("InstructionNotes.add", () => {
  it.live("appends to an existing root file, which is listed at once and is not created", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      yield* write(path.join(where.root, "ORBIT.md"), "# Rules\nBe brief.\n")
      yield* Effect.gen(function* () {
        const { notes, discovery } = yield* start
        const added = yield* notes.add({ scope: "project", text: "use bun" })
        expect(added).toMatchObject({ scope: "project", path: path.join(where.root, "ORBIT.md"), created: false, loaded: true })
        expect(yield* read(path.join(where.root, "ORBIT.md"))).toBe("# Rules\nBe brief.\n- use bun\n")
        expect(yield* contents(discovery)).toContain("use bun")
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("creates AGENTS.md at the root when there is no instruction file, and never ORBIT.md", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      yield* Effect.gen(function* () {
        const { notes, discovery } = yield* start
        const added = yield* notes.add({ scope: "project", text: "first" })
        expect(added).toMatchObject({ path: path.join(where.root, "AGENTS.md"), created: true, loaded: true })
        expect(yield* read(path.join(where.root, "AGENTS.md"))).toBe("- first\n")
        expect(yield* exists(path.join(where.root, "ORBIT.md"))).toBe(false)
        expect(yield* contents(discovery)).toContain("first")
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("goes to the first file the loader reads, and leaves the others byte for byte", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      const agents = path.join(where.root, "AGENTS.md")
      const orbit = path.join(where.root, "ORBIT.md")
      yield* write(agents, "agents\r\nline")
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        // Only AGENTS.md is there: it takes the note.
        yield* notes.add({ scope: "project", text: "a" })
        expect(yield* read(agents)).toBe("agents\r\nline\r\n- a\r\n")
        // Both are there: ORBIT.md is first in name order.
        yield* write(orbit, "orbit\n")
        const before = yield* read(agents)
        yield* notes.add({ scope: "project", text: "b" })
        expect(yield* read(orbit)).toBe("orbit\n- b\n")
        expect(yield* read(agents)).toBe(before)
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("writes to the vendor-named file only when compatibility makes it the loader's choice", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      const vendor = path.join(where.root, CompatNames.vendor.instructions)
      yield* write(vendor, "vendor\n")
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        expect((yield* notes.add({ scope: "project", text: "on" })).path).toBe(vendor)
        expect(yield* read(vendor)).toBe("vendor\n- on\n")
      }).pipe(Effect.provide(layerFor({ ...where, compat: true })))

      const other = yield* scratch
      const vendorOff = path.join(other.root, CompatNames.vendor.instructions)
      yield* write(vendorOff, "vendor\n")
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        const added = yield* notes.add({ scope: "project", text: "off" })
        expect(added).toMatchObject({ path: path.join(other.root, "AGENTS.md"), created: true })
        expect(yield* read(vendorOff)).toBe("vendor\n")
      }).pipe(Effect.provide(layerFor({ ...other, compat: false })))
    }),
  )

  it.live("writes the user scope into a missing config folder and loads it", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      yield* Effect.gen(function* () {
        const { notes, discovery } = yield* start
        const added = yield* notes.add({ scope: "user", text: "mine" })
        expect(added).toMatchObject({ path: path.join(where.config, "ORBIT.md"), created: true, loaded: true })
        expect(yield* contents(discovery)).toContain("mine")
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  const formats: ReadonlyArray<readonly [string, string, string, string]> = [
    ["multi-line text is indented under its bullet and empty lines stay empty", "", "one\ntwo\n\nthree", "- one\n  two\n\n  three\n"],
    ["a file with no final line break gets one before the bullet", "# T", "x", "# T\n- x\n"],
    ["a CRLF file stays CRLF, including the note's own breaks", "a\r\nb\r\n", "x\ny", "a\r\nb\r\n- x\r\n  y\r\n"],
    ["a file with a byte order mark keeps exactly one", "﻿a\n", "x", "﻿a\n- x\n"],
    ["an empty file gets the bullet alone", "", "x", "- x\n"],
  ]
  for (const [name, existing, note, expected] of formats)
    it.live(`formats a note: ${name}`, () =>
      Effect.gen(function* () {
        const where = yield* scratch
        const file = path.join(where.root, "ORBIT.md")
        yield* write(file, existing)
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          yield* notes.add({ scope: "project", text: note })
          const bytes = yield* Effect.promise(() => fs.readFile(file, "utf8"))
          expect(bytes).toBe(expected)
          expect(bytes.startsWith("﻿﻿")).toBe(false)
        }).pipe(Effect.provide(layerFor(where)))
      }),
    )

  it.live("keeps the existing bytes as a prefix across two notes in a row", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      const file = path.join(where.root, "ORBIT.md")
      yield* write(file, "keep\n")
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        yield* notes.add({ scope: "project", text: "one" })
        yield* notes.add({ scope: "project", text: "two" })
        expect(yield* read(file)).toBe("keep\n- one\n- two\n")
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("serialises with an edit of the same file, so both changes are present", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      const file = path.join(where.root, "ORBIT.md")
      yield* write(file, "base\n")
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        const mutation = yield* FileMutation.Service
        // The edit holds the file's lock, reads, waits, and writes the whole file back, as the edit tool does.
        const edit = mutation.withLock([file])(
          Effect.gen(function* () {
            const before = yield* read(file)
            yield* Effect.sleep("150 millis")
            yield* write(file, before.replace("base", "edited"))
          }),
        )
        yield* Effect.all([edit, Effect.sleep("30 millis").pipe(Effect.andThen(notes.add({ scope: "project", text: "note" })))], {
          concurrency: 2,
        })
        expect(yield* read(file)).toBe("edited\n- note\n")
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  describe("excluded files", () => {
    it.live("refuses an existing file that instructions_exclude drops, writes nothing and creates no second file", () =>
      Effect.gen(function* () {
        const where = yield* scratch
        const file = path.join(where.root, "ORBIT.md")
        yield* write(file, "x\n")
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("excluded")
          expect(yield* read(file)).toBe("x\n")
          expect(yield* exists(path.join(where.root, "AGENTS.md"))).toBe(false)
        }).pipe(Effect.provide(layerFor({ ...where, excludes: [path.join(where.root, "ORBIT.md").replaceAll("\\", "/")] })))
      }),
    )

    it.live("goes to the next name when the first is excluded, as the loader does", () =>
      Effect.gen(function* () {
        const where = yield* scratch
        yield* write(path.join(where.root, "ORBIT.md"), "x\n")
        yield* write(path.join(where.root, "AGENTS.md"), "y\n")
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          const added = yield* notes.add({ scope: "project", text: "n" })
          expect(added.path).toBe(path.join(where.root, "AGENTS.md"))
          expect(yield* read(path.join(where.root, "ORBIT.md"))).toBe("x\n")
          expect(yield* read(path.join(where.root, "AGENTS.md"))).toBe("y\n- n\n")
        }).pipe(Effect.provide(layerFor({ ...where, excludes: [path.join(where.root, "ORBIT.md").replaceAll("\\", "/")] })))
      }),
    )

    it.live("creates a missing default that a pattern matches, and reports it as not loaded", () =>
      Effect.gen(function* () {
        const where = yield* scratch
        yield* Effect.gen(function* () {
          const { notes, discovery } = yield* start
          const added = yield* notes.add({ scope: "project", text: "n" })
          expect(added).toMatchObject({ created: true, loaded: false })
          expect(yield* contents(discovery)).not.toContain("n")
        }).pipe(Effect.provide(layerFor({ ...where, excludes: [path.join(where.root, "AGENTS.md").replaceAll("\\", "/")] })))
      }),
    )
  })

  it.live("appends to an empty file and one holding only a comment, which then load", () =>
    Effect.gen(function* () {
      const cases = [
        ["", "- n\n"],
        ["<!-- nothing -->\n", "<!-- nothing -->\n- n\n"],
      ] as const
      for (const [existing, expected] of cases) {
        const where = yield* scratch
        const file = path.join(where.root, "ORBIT.md")
        yield* write(file, existing)
        yield* Effect.gen(function* () {
          const { notes, discovery } = yield* start
          const added = yield* notes.add({ scope: "project", text: "n" })
          expect(added).toMatchObject({ created: false, loaded: true })
          expect(yield* read(file)).toBe(expected)
          expect(yield* contents(discovery)).toContain("- n")
        }).pipe(Effect.provide(layerFor(where)))
      }
    }),
  )

  it.live("refuses as unavailable when a source could not be read, and writes nothing", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      yield* Effect.gen(function* () {
        const { notes, discovery } = yield* start
        yield* discovery.transform((editor) => editor.unavailable())
        expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("unavailable")
        expect(yield* exists(path.join(where.root, "AGENTS.md"))).toBe(false)
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("refuses every scope as disabled when instruction files are off, and says so in targets", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        for (const scope of ["user", "project", "local"] as const) {
          expect(yield* outcome(notes.add({ scope, text: "n" }))).toBe("disabled")
        }
        expect((yield* notes.targets()).map((item) => [item.scope, item.enabled])).toEqual([
          ["user", false],
          ["project", false],
          ["local", false],
        ])
        expect(yield* exists(path.join(where.root, "AGENTS.md"))).toBe(false)
        expect(yield* exists(path.join(where.config, "ORBIT.md"))).toBe(false)
      }).pipe(Effect.provide(layerFor({ ...where, project: false, global: false })))
    }),
  )

  it.live("refuses project and local for a location outside the project root, while user still works", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      const away = path.join(where.base, "away")
      yield* Effect.promise(() => fs.mkdir(away))
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("disabled")
        expect(yield* outcome(notes.add({ scope: "local", text: "n" }))).toBe("disabled")
        expect(yield* outcome(notes.add({ scope: "user", text: "n" }))).toBe("ok")
      }).pipe(Effect.provide(layerFor({ ...where, directory: away })))
    }),
  )

  it.live("fails with WriteError and creates nothing when the file's place holds a directory", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      yield* Effect.promise(() => fs.mkdir(path.join(where.root, "AGENTS.md")))
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        const error = yield* notes.add({ scope: "project", text: "n" }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(InstructionNotes.WriteError)
        expect(yield* Effect.promise(() => fs.readdir(where.root))).toEqual(["AGENTS.md"])
        expect(yield* Effect.promise(() => fs.readdir(path.join(where.root, "AGENTS.md")))).toEqual([])
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("treats the project's file as disabled when the project root is the config folder and global files are off", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      yield* write(path.join(where.root, "AGENTS.md"), "x\n")
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        expect((yield* notes.targets())[1]?.enabled).toBe(false)
        expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("disabled")
        expect(yield* read(path.join(where.root, "AGENTS.md"))).toBe("x\n")
      }).pipe(Effect.provide(layerFor({ ...where, config: where.root, global: false })))
    }),
  )

  it.live("reports each scope's file in the order user, project, local, current after an edit with no watcher event", () =>
    Effect.gen(function* () {
      const where = yield* scratch
      const file = path.join(where.root, "ORBIT.md")
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        const before = yield* notes.targets()
        expect(before.map((item) => [item.scope, item.path, item.exists, item.enabled, item.loaded])).toEqual([
          ["user", path.join(where.config, "ORBIT.md"), false, true, false],
          ["project", path.join(where.root, "AGENTS.md"), false, true, false],
          ["local", path.join(where.root, "ORBIT.local.md"), false, true, false],
        ])
        yield* write(file, "out of band\n")
        expect((yield* notes.targets()).map((item) => [item.scope, item.path, item.exists, item.loaded])[1]).toEqual([
          "project",
          file,
          true,
          true,
        ])
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("matches a loaded file whose location is spelled with a lower-case drive letter", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const where = yield* scratch
      yield* write(path.join(where.root, "ORBIT.md"), "x\n")
      const lower = where.root.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
      yield* Effect.gen(function* () {
        const { notes } = yield* start
        expect((yield* notes.add({ scope: "project", text: "n" })).loaded).toBe(true)
        expect((yield* notes.targets())[1]?.loaded).toBe(true)
      }).pipe(Effect.provide(layerFor({ ...where, directory: lower, spelled: lower })))
    }),
  )

  describe("an untrusted project", () => {
    const outsideFile = (where: { readonly base: string }) => path.join(where.base, "outside.md")

    it.live("refuses a root file that is a link to a file outside, leaves the outside file alone, and writes through it once trusted", () =>
      Effect.gen(function* () {
        if (!canLinkFile) return
        const where = yield* scratch
        const outside = outsideFile(where)
        yield* write(outside, "secret\n")
        yield* Effect.promise(() => fs.symlink(outside, path.join(where.root, "AGENTS.md")))
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("outside")
          expect(yield* read(outside)).toBe("secret\n")
        }).pipe(Effect.provide(layerFor({ ...where, trusted: false })))
        // The control: a trusted project follows its own link, and the note loads.
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("ok")
          expect(yield* read(outside)).toBe("secret\n- n\n")
        }).pipe(Effect.provide(layerFor({ ...where, trusted: true })))
      }),
    )

    it.live("lists a root file that is a link to a file outside as the spelled file and not enabled, and a trusted project as enabled", () =>
      Effect.gen(function* () {
        if (!canLinkFile) return
        const where = yield* scratch
        yield* write(outsideFile(where), "secret\n")
        const link = path.join(where.root, "AGENTS.md")
        yield* Effect.promise(() => fs.symlink(outsideFile(where), link))
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect((yield* notes.targets())[1]).toMatchObject({ path: link, exists: true, enabled: false })
        }).pipe(Effect.provide(layerFor({ ...where, trusted: false })))
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect((yield* notes.targets())[1]).toMatchObject({ path: link, enabled: true })
        }).pipe(Effect.provide(layerFor({ ...where, trusted: true })))
      }),
    )

    it.live("lists a file that instructions_exclude drops as not enabled", () =>
      Effect.gen(function* () {
        const where = yield* scratch
        yield* write(path.join(where.root, "AGENTS.md"), "x\n")
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect((yield* notes.targets())[1]).toMatchObject({ exists: true, enabled: false })
        }).pipe(Effect.provide(layerFor({ ...where, excludes: [path.join(where.root, "AGENTS.md").replaceAll("\\", "/")] })))
      }),
    )

    it.live("refuses a dangling link and creates nothing at the place it leads to", () =>
      Effect.gen(function* () {
        if (!canLinkFile) return
        const where = yield* scratch
        const outside = outsideFile(where)
        yield* Effect.promise(() => fs.symlink(outside, path.join(where.root, "AGENTS.md")))
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("outside")
          expect(yield* exists(outside)).toBe(false)
        }).pipe(Effect.provide(layerFor({ ...where, trusted: false })))
      }),
    )

    // A place the file system cannot follow is a refusal and not a failure of the request, whichever way it fails: a loop of
    // links (where the system reports it) or a `resolve` that dies after the link check found no share. The second row
    // runs everywhere, since the first meets it only where the system reports the loop itself.
    const names = [
      { scope: "project", name: "AGENTS.md", index: 1 },
      { scope: "local", name: "ORBIT.local.md", index: 2 },
    ] as const
    for (const item of names)
      for (const trusted of [false, true]) {
        const label = `${item.scope} scope, ${trusted ? "trusted" : "untrusted"}`
        it.live(`${label}: a file whose place cannot be resolved is listed as there and not enabled, and a note is refused as outside`, () =>
          Effect.gen(function* () {
            const where = yield* scratch
            const place = path.join(where.root, item.name)
            yield* write(place, "x")
            // Armed once the loader has started, so that the request is what meets the failure.
            const armed = { on: false }
            const failing = Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((real) =>
                  FSUtil.Service.of({
                    ...real,
                    resolve: (target) => (armed.on && path.relative(place, target) === "" ? Effect.die("cannot follow the link") : real.resolve(target)),
                  }),
                ),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
            yield* Effect.gen(function* () {
              const { notes } = yield* start
              armed.on = true
              expect((yield* notes.targets())[item.index]).toMatchObject({ exists: true, enabled: false, loaded: false })
              // The refusal is "outside" when the note meets the failure itself, and "unavailable" when the rescan it starts does.
              expect(["outside", "unavailable"]).toContain(yield* outcome(notes.add({ scope: item.scope, text: "n" })))
              expect(yield* read(place)).toBe("x")
            }).pipe(Effect.provide(layerFor({ ...where, trusted, filesystem: failing })))
          }),
        )
        ;(canLinkFile && process.platform !== "win32" ? it.live : it.live.skip)(
          `${label}: a file that links to itself or to a loop of links is listed as not enabled, and a note is refused as outside`,
          () =>
            Effect.gen(function* () {
              const where = yield* scratch
              const place = path.join(where.root, item.name)
              const other = path.join(where.root, "other.md")
              yield* Effect.promise(() => fs.symlink(item.scope === "project" ? place : other, place))
              yield* Effect.promise(() => fs.symlink(place, other).catch(() => undefined))
              yield* Effect.gen(function* () {
                const { notes } = yield* start
                expect((yield* notes.targets())[item.index]).toMatchObject({ exists: true, enabled: false })
                expect(yield* outcome(notes.add({ scope: item.scope, text: "n" }))).toBe("outside")
              }).pipe(Effect.provide(layerFor({ ...where, trusted })))
            }),
        )
      }

    it.live("writes a note that holds an import token, and the import gate keeps the imported file out of the list", () =>
      Effect.gen(function* () {
        const where = yield* scratch
        const secret = path.join(where.base, "home-secret.md")
        yield* write(secret, "HOME SECRET MARKER\n")
        yield* Effect.gen(function* () {
          const { notes, discovery } = yield* start
          yield* notes.add({ scope: "project", text: `@${secret.replaceAll("\\", "/")}` })
          expect(yield* read(path.join(where.root, "AGENTS.md"))).toContain("home-secret.md")
          expect(yield* contents(discovery)).not.toContain("HOME SECRET MARKER")
        }).pipe(Effect.provide(layerFor({ ...where, trusted: false })))
      }),
    )
  })

  // Class 3: the project is the home folder and the session started in a folder below it. The loader does not read a project
  // file there that is a link leading out of the folder the session started in, so no note may be written to it either: the
  // list says it is not enabled, and add refuses it without touching what the link leads to. A plain file is the control.
  describe("a project at the home folder", () => {
    const linked = canLinkFile ? it.live : it.live.skip
    for (const trusted of [true, false])
      for (const mode of ["link", "plain"] as const)
        (mode === "link" ? linked : it.live)(`${mode === "link" ? "refuses" : "writes to"} a ${mode} AGENTS.md, ${trusted ? "trusted" : "not trusted"}`, () =>
          Effect.gen(function* () {
            const where = yield* scratch
            const home = path.join(where.base, "home")
            const directory = path.join(home, "Downloads", "x")
            const target = path.join(home, "dotfiles", "AGENTS.md")
            yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
            yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
            yield* write(target, "DOTFILES MARKER\n")
            if (mode === "link") yield* Effect.promise(() => fs.symlink(target, path.join(home, "AGENTS.md"), "file"))
            else yield* write(path.join(home, "AGENTS.md"), "PLAIN MARKER\n")
            yield* Effect.gen(function* () {
              const { notes } = yield* start
              const item = (yield* notes.targets()).find((entry) => entry.scope === "project")
              expect(item).toMatchObject({ enabled: mode === "plain", loaded: mode === "plain" })
              expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe(mode === "link" ? "outside" : "ok")
              expect(yield* read(target)).toBe("DOTFILES MARKER\n")
              if (mode === "plain") expect(yield* read(path.join(home, "AGENTS.md"))).toContain("- n")
            }).pipe(Effect.provide(layerFor({ ...where, root: home, directory, trusted })))
          }),
        )
  })

  describe("a link to a network share", () => {
    // The real file system, except that a call which would open the link (resolve, stat, read) is recorded and answered
    // without touching it, so that a regression fails at once and never connects to a host.
    const guarded = (opened: string[], link: (target: string) => boolean) =>
      Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          // Every call that names the link fails at once and is recorded, except reading the link itself, which opens nothing.
          Effect.map((real) =>
            FSUtil.Service.of(
              Object.fromEntries(
                Object.entries(real).map(([name, value]) => [
                  name,
                  typeof value !== "function" || name === "readLink" || name === "lstat"
                    ? value
                    : (...args: unknown[]) =>
                        args.some((arg) => typeof arg === "string" && link(arg))
                          ? (opened.push(name), Effect.die(`opened the link: ${name}`))
                          : (value as (...input: unknown[]) => unknown)(...args),
                ]),
              ) as unknown as FSUtil.Interface,
            ),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

    const cases = [
      { scope: "project", name: "AGENTS.md", index: 1 },
      { scope: "local", name: "ORBIT.local.md", index: 2 },
    ] as const
    for (const item of cases)
      for (const trusted of [false, true])
        it.live(`${item.scope} scope, ${trusted ? "trusted" : "untrusted"}: is listed as there and not enabled, refused as outside, and never opened`, () =>
          Effect.gen(function* () {
            if (!canLinkFile || process.platform !== "win32") return
            const where = yield* scratch
            const link = path.join(where.root, item.name)
            yield* Effect.promise(() => fs.symlink("\\\\192.0.2.1\\share\\x.md", link, "file"))
            const opened: string[] = []
            yield* Effect.gen(function* () {
              const { notes } = yield* start
              expect((yield* notes.targets())[item.index]).toMatchObject({ path: link, exists: true, enabled: false, loaded: false })
              expect(yield* outcome(notes.add({ scope: item.scope, text: "n" }))).toBe("outside")
            }).pipe(
              Effect.provide(
                layerFor({ ...where, trusted, filesystem: guarded(opened, (target) => path.relative(link, target) === "") }),
              ),
            )
            expect(opened).toEqual([])
          }),
        )
  })

  describe("a new local file", () => {
    const repo = Effect.gen(function* () {
      const where = yield* scratch
      yield* Effect.promise(() => initRepo(where.root))
      return { ...where, vcs: "git" as const }
    })
    const exclude = (root: string) => read(path.join(root, ".git", "info", "exclude")).pipe(Effect.orElseSucceed(() => ""))
    const lines = (text: string) => text.split(/\r?\n/).filter((line) => line === "/ORBIT.local.md")

    it.live("is created, loads, and is kept out of git by one anchored line that a second note does not repeat", () =>
      Effect.gen(function* () {
        const where = yield* repo
        yield* Effect.gen(function* () {
          const { notes, discovery } = yield* start
          const added = yield* notes.add({ scope: "local", text: "private" })
          expect(added).toMatchObject({ path: path.join(where.root, "ORBIT.local.md"), created: true, loaded: true })
          expect(yield* contents(discovery)).toContain("private")
          expect(lines(yield* exclude(where.root))).toHaveLength(1)
          const status = yield* Effect.promise(() => $`git status --porcelain`.cwd(where.root).quiet().text())
          expect(status.trim()).toBe("")
          yield* notes.add({ scope: "local", text: "again" })
          expect(lines(yield* exclude(where.root))).toHaveLength(1)
          expect((yield* read(path.join(where.root, "ORBIT.local.md")))).toBe("- private\n- again\n")
        }).pipe(Effect.provide(layerFor(where)))
      }),
    )

    // Untrusted, so the "already ignored" question is not asked and only the exclude file's own text can stop a second line.
    it.live("does not repeat the line when the file is created again", () =>
      Effect.gen(function* () {
        const where = yield* repo
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          yield* notes.add({ scope: "local", text: "one" })
          yield* Effect.promise(() => fs.rm(path.join(where.root, "ORBIT.local.md")))
          expect((yield* notes.add({ scope: "local", text: "two" })).created).toBe(true)
          expect(lines(yield* exclude(where.root))).toHaveLength(1)
        }).pipe(Effect.provide(layerFor({ ...where, trusted: false })))
      }),
    )

    // A Mercurial project that sits inside a git repository has no exclude step, and the repository above it is not its own.
    it.live("leaves the outer git repository alone for a Mercurial project inside it, and starts no git process", () =>
      Effect.gen(function* () {
        for (const trusted of [false, true]) {
          const where = yield* scratch
          yield* Effect.promise(() => initRepo(where.root))
          const inner = path.join(where.root, "sub")
          yield* Effect.promise(() => fs.mkdir(path.join(inner, ".hg"), { recursive: true }))
          const before = yield* exclude(where.root)
          const result = yield* traced(
            Effect.gen(function* () {
              const { notes } = yield* start
              expect((yield* notes.add({ scope: "local", text: "n" })).created).toBe(true)
            }).pipe(Effect.provide(layerFor({ base: where.base, root: inner, config: where.config, trusted, vcs: "hg" }))),
          )
          expect(result.git).toEqual([])
          expect(yield* exclude(where.root)).toBe(before)
          expect(yield* read(path.join(inner, "ORBIT.local.md"))).toBe("- n\n")
        }
      }),
    )

    it.live("leaves info/exclude alone when a .gitignore already ignores the file", () =>
      Effect.gen(function* () {
        const where = yield* repo
        yield* write(path.join(where.root, ".gitignore"), "ORBIT.local.md\n")
        const before = yield* exclude(where.root)
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          yield* notes.add({ scope: "local", text: "n" })
          expect(yield* exclude(where.root)).toBe(before)
        }).pipe(Effect.provide(layerFor(where)))
      }),
    )

    it.live("puts the line in a linked worktree's common directory, not in the worktree's entry", () =>
      Effect.gen(function* () {
        const where = yield* repo
        const linked = path.join(where.base, "linked")
        yield* Effect.promise(() => git(where.root, "worktree", "add", "--detach", linked))
        const real = yield* Effect.promise(() => fs.realpath(linked))
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          yield* notes.add({ scope: "local", text: "n" })
          expect(lines(yield* exclude(where.root))).toHaveLength(1)
          const entry = path.join(where.root, ".git", "worktrees", "linked", "info", "exclude")
          expect(yield* exists(entry)).toBe(false)
        }).pipe(Effect.provide(layerFor({ base: where.base, root: real, config: where.config, vcs: "git" })))
      }),
    )

    for (const [name, forge] of forgeries)
    it.live(`writes the note but no line for ${name}, and says so at most once`, () =>
      Effect.gen(function* () {
        const found: Found = yield* folders
        yield* Effect.promise(() => forge(found))
        const victim = path.join(found.victim, ".git", "info", "exclude")
        const before = yield* read(victim).pipe(Effect.orElseSucceed(() => ""))
        const warnings: unknown[] = []
        const logger = Logger.make((entry) => {
          const message = Array.isArray(entry.message) ? entry.message[0] : entry.message
          if (message === "instruction note not excluded from git") warnings.push(entry.message)
        })
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect((yield* notes.add({ scope: "local", text: "n" })).created).toBe(true)
        }).pipe(
          Effect.provide(layerFor({ base: found.root, root: found.crafted, config: path.join(found.root, "config"), vcs: "git" })),
          Effect.provide(Logger.layer([logger])),
        )
        expect(yield* read(victim).pipe(Effect.orElseSucceed(() => ""))).toBe(before)
        expect(yield* read(path.join(found.crafted, "ORBIT.local.md"))).toBe("- n\n")
        expect(yield* exists(path.join(found.crafted, "gd", "info"))).toBe(false)
        // A layout that git would not take for a repository gets no step at all; one it might take is named and left alone.
        expect(warnings.length).toBeLessThanOrEqual(1)
        for (const warning of warnings) expect(warning).toMatchObject(["instruction note not excluded from git", { reason: "unverified git directory" }])
      }),
    )

    it.live("starts no git process in an untrusted folder and still writes the line, while a trusted one starts git", () =>
      Effect.gen(function* () {
        const run = (trusted: boolean) =>
          Effect.gen(function* () {
            const where = yield* repo
            const result = yield* traced(
              Effect.gen(function* () {
                const { notes } = yield* start
                yield* notes.add({ scope: "local", text: "n" })
              }).pipe(Effect.provide(layerFor({ ...where, trusted }))),
            )
            return { git: result.git, lines: lines(yield* exclude(where.root)) }
          })
        const untrusted = yield* run(false)
        expect(untrusted.git).toEqual([])
        expect(untrusted.lines).toHaveLength(1)
        const trusted = yield* run(true)
        expect(trusted.git.length).toBeGreaterThan(0)
        expect(trusted.lines).toHaveLength(1)
      }),
    )

    it.live("keeps the note when the exclude step fails", () =>
      Effect.gen(function* () {
        const where = yield* repo
        // A directory where the exclude file should be makes the step fail.
        yield* Effect.promise(async () => {
          await fs.rm(path.join(where.root, ".git", "info", "exclude"), { force: true })
          await fs.mkdir(path.join(where.root, ".git", "info", "exclude"), { recursive: true })
        })
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          expect(yield* notes.add({ scope: "local", text: "n" })).toMatchObject({ created: true, loaded: true })
          expect(yield* read(path.join(where.root, "ORBIT.local.md"))).toBe("- n\n")
        }).pipe(Effect.provide(layerFor(where)))
      }),
    )

    // Class 4: a repository's `.git/info/exclude` that is a link would carry the line to a file outside the git directory, or
    // create one at the place a dangling link names. The step leaves both alone with one warning, and the note stands. A
    // plain exclude file is the control, in both trust states.
    const excludeShapes = [
      { name: "a plain file", link: undefined },
      { name: "a link to a file outside the git directory", link: "file" },
      { name: "a dangling link to a place outside the git directory", link: "dangling" },
    ] as const
    for (const shape of excludeShapes)
      for (const trusted of [true, false])
        (shape.link === undefined || canLinkFile ? it.live : it.live.skip)(
          `${shape.link === undefined ? "writes the line" : "writes the note but no line"} when info/exclude is ${shape.name} (${trusted ? "trusted" : "untrusted"})`,
          () =>
            Effect.gen(function* () {
              const where = yield* repo
              const file = path.join(where.root, ".git", "info", "exclude")
              const target = path.join(where.base, shape.link === "dangling" ? "not-there.txt" : "outside.txt")
              yield* Effect.promise(async () => {
                if (shape.link === undefined) return
                if (shape.link === "file") await fs.writeFile(target, "OUTSIDE\n")
                await fs.rm(file, { force: true })
                await fs.symlink(target, file, "file")
              })
              const warnings: unknown[] = []
              const logger = Logger.make((entry) => {
                const message = Array.isArray(entry.message) ? entry.message[0] : entry.message
                if (message === "instruction note not excluded from git") warnings.push(entry.message)
              })
              yield* Effect.gen(function* () {
                const { notes } = yield* start
                expect(yield* notes.add({ scope: "local", text: "n" })).toMatchObject({ created: true, loaded: true })
              }).pipe(Effect.provide(layerFor({ ...where, trusted })), Effect.provide(Logger.layer([logger])))
              expect(yield* read(path.join(where.root, "ORBIT.local.md"))).toBe("- n\n")
              if (shape.link === undefined) {
                expect(lines(yield* exclude(where.root))).toHaveLength(1)
                expect(warnings).toEqual([])
                return
              }
              if (shape.link === "file") expect(yield* read(target)).toBe("OUTSIDE\n")
              else expect(yield* exists(target)).toBe(false)
              expect(warnings).toMatchObject([["instruction note not excluded from git", { reason: "exclude file is a link" }]])
            }),
        )

    it.live("writes no line when .git/info is a link that leads out of the git directory", () =>
      Effect.gen(function* () {
        const where = yield* repo
        const away = path.join(where.base, "away")
        yield* Effect.promise(async () => {
          await fs.mkdir(away)
          await fs.rm(path.join(where.root, ".git", "info"), { recursive: true, force: true })
          await fs.symlink(away, path.join(where.root, ".git", "info"), "junction")
        })
        yield* Effect.gen(function* () {
          const { notes } = yield* start
          yield* notes.add({ scope: "local", text: "n" })
          expect(yield* Effect.promise(() => fs.readdir(away))).toEqual([])
        }).pipe(Effect.provide(layerFor(where)))
      }),
    )

    // Classes 1 and 3, the rows of `git-passed-over.test.ts` for this surface: a project `sub` whose `.git` git passes over,
    // in an untrusted repository whose config names programs. The Location names `sub` as a git project, as a resolve that
    // took that `.git` for a repository named it, and the person trusts `sub`. The question whether the note is already
    // ignored starts git for `sub` only, and never in the repository above. Mutation: `Git.ceiling` answering `{}`, with
    // `GitLayout.locate` taking any `.git` directory with a `HEAD` file as before, fails the first four rows (the fifth
    // shape's layout is not verified, so it gets no exclude step at all).
    const local = (found: { readonly folder: string; readonly sub: string }) =>
      traced(
        Effect.gen(function* () {
          const trust = yield* ProjectTrust.Service
          yield* trust.grant({ persist: false, via: "test" })
          const { notes } = yield* start
          expect((yield* notes.add({ scope: "local", text: "n" })).created).toBe(true)
        }).pipe(
          Effect.provide(
            layerFor({ base: found.folder, root: found.sub, config: path.join(found.folder, "config"), trusted: false, vcs: "git" }),
          ),
        ),
      )

    for (const [name, fill] of shapes)
      it.live(`starts no git in the untrusted repository above a trusted folder for ${name}`, () =>
        Effect.gen(function* () {
          const found = yield* outer(fill)

          const result = yield* local(found)

          expect(opened(result.worktrees, found.root)).toBe(false)
          expect(yield* found.ran()).toEqual([])
        }),
      )

    it.live("asks git of a trusted folder whose .git git takes, and never the repository above (control)", () =>
      Effect.gen(function* () {
        const found = yield* outer()
        yield* inner(found)

        const result = yield* local(found)

        expect(opened(result.worktrees, found.sub)).toBe(true)
        expect(opened(result.worktrees, found.root)).toBe(false)
      }),
    )
  })
})

describe("InstructionNotes.format", () => {
  test("is pure over the file's text", () => {
    expect(InstructionNotes.format("", "a")).toBe("- a\n")
    expect(InstructionNotes.format("x", "a\nb")).toBe("\n- a\n  b\n")
  })
})

// Class 14: the note target is the file the loader reads, also where two names stand for one slot. At the home folder, a
// started folder below it is bounded, so an ORBIT.md that links to a file elsewhere is not what loads: AGENTS.md is, and that
// is where a note goes. Without the link filter in the choice of target, the note would go to the file that is never read.
describe("InstructionNotes.target in a project at the home folder, with two names for one slot", () => {
  for (const trusted of [true, false])
    (canLinkFile ? it.live : it.live.skip)(`the note goes to the plain file the loader reads, ${trusted ? "trusted" : "not trusted"}`, () =>
      Effect.gen(function* () {
        const where = yield* scratch
        const home = path.join(where.base, "home")
        const directory = path.join(home, "Downloads", "x")
        const target = path.join(home, "dotfiles", "ORBIT.md")
        yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
        yield* write(target, "DOTFILES MARKER")
        yield* Effect.promise(() => fs.symlink(target, path.join(home, "ORBIT.md"), "file"))
        yield* write(path.join(home, "AGENTS.md"), "PLAIN MARKER")
        yield* Effect.gen(function* () {
          const { notes, discovery } = yield* start
          yield* discovery.rescan()
          const loadedText = yield* contents(discovery)
          expect(loadedText).toContain("PLAIN MARKER")
          expect(loadedText).not.toContain("DOTFILES MARKER")
          expect(yield* outcome(notes.add({ scope: "project", text: "n" }))).toBe("ok")
          expect(yield* read(target)).toBe("DOTFILES MARKER")
          expect(yield* read(path.join(home, "AGENTS.md"))).toContain("- n")
        }).pipe(Effect.provide(layerFor({ ...where, root: home, directory, trusted })))
      }),
    )
})
