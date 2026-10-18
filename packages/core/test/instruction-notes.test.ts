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
                { projectDirectory: AbsolutePath.make(input.spelled ?? input.root) },
              ),
            ),
          ),
        ),
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

  describe("a new local file", () => {
    const repo = Effect.gen(function* () {
      const where = yield* scratch
      yield* Effect.promise(() => initRepo(where.root))
      return where
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
        }).pipe(Effect.provide(layerFor({ base: where.base, root: real, config: where.config })))
      }),
    )

    it.live("writes the note but no line for a .git file that names another repository, and says so once", () =>
      Effect.gen(function* () {
        const found: Found = yield* folders
        yield* Effect.promise(() => forgeries[0]![1](found))
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
          Effect.provide(layerFor({ base: found.root, root: found.crafted, config: path.join(found.root, "config") })),
          Effect.provide(Logger.layer([logger])),
        )
        expect(yield* read(victim).pipe(Effect.orElseSucceed(() => ""))).toBe(before)
        expect(yield* read(path.join(found.crafted, "ORBIT.local.md"))).toBe("- n\n")
        expect(yield* exists(path.join(found.crafted, "gd", "info"))).toBe(false)
        expect(warnings).toMatchObject([["instruction note not excluded from git", { reason: "unverified git directory" }]])
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
  })
})

describe("InstructionNotes.format", () => {
  test("is pure over the file's text", () => {
    expect(InstructionNotes.format("", "a")).toBe("- a\n")
    expect(InstructionNotes.format("x", "a\nb")).toBe("\n- a\n  b\n")
  })
})
