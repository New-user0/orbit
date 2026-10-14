import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Info } from "@orbit/schema/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Fingerprint } from "@orbit/core/config/fingerprint"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Class 1, 4 and 6: what a folder names must not make the fingerprints read anything outside it, before the folder is
// trusted or after. Every row plants something outside, and asserts two things about the digest: it does not look at
// the outside content (changing it moves nothing), and no call of the file system touched the outside path.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))
const decode = Schema.decodeUnknownSync(Info)

const skill = (command: string) =>
  `---\nname: demo\ndescription: d\nhooks:\n  PreToolUse:\n    - command: ${command}\n---\nbody\n`

/** A file system that records every path that is handed to it. */
const watched = (files: FSUtil.Interface) => {
  const seen: string[] = []
  // Links are read to find a share, which follows a link to where it points, so they are kept apart from `seen`.
  const links: string[] = []
  const note = <A extends (path: string, ...rest: never[]) => unknown>(fn: A) =>
    ((target: string, ...rest: never[]) => {
      seen.push(target)
      return fn(target, ...rest)
    }) as A
  const view: FSUtil.Interface = {
    ...files,
    exists: note(files.exists),
    isDir: note(files.isDir),
    isFile: note(files.isFile),
    readFile: note(files.readFile),
    readFileString: note(files.readFileString),
    readDirectoryEntries: note(files.readDirectoryEntries),
    readLink: (target) => {
      links.push(target)
      return files.readLink(target)
    },
    resolve: note(files.resolve),
    scan: (pattern, options) => {
      seen.push(options?.cwd ?? "")
      return files.scan(pattern, options)
    },
  }
  return { view, seen, links }
}

const layout = Effect.gen(function* () {
  const base = (yield* tmpdirScoped()).path
  const folder = path.join(base, "project", ".orbit")
  const outside = path.join(base, "outside")
  yield* Effect.promise(async () => {
    await fs.mkdir(folder, { recursive: true })
    await fs.mkdir(path.join(outside, "demo"), { recursive: true })
    await fs.writeFile(path.join(outside, "demo", "SKILL.md"), skill("echo outside-one"))
    await fs.writeFile(path.join(outside, "agent.md"), "---\ndescription: a\nhooks:\n  Stop:\n    - command: echo one\n---\nbody\n")
    await fs.writeFile(path.join(outside, "plugin.ts"), "export default 1\n")
  })
  return { base, project: path.join(base, "project"), folder, outside }
})

// Moves what is outside. Nothing the folder digests may follow it.
const changeOutside = (outside: string) =>
  Effect.promise(async () => {
    await fs.writeFile(path.join(outside, "demo", "SKILL.md"), skill("echo outside-two"))
    await fs.writeFile(path.join(outside, "agent.md"), "---\ndescription: a\nhooks:\n  Stop:\n    - command: echo two\n---\nbody\n")
    await fs.writeFile(path.join(outside, "plugin.ts"), "export default 2\n")
  })

const touched = (seen: readonly string[], outside: string) =>
  seen.filter((item) => item !== "" && FSUtil.contains(outside, path.resolve(item)))

describe("Fingerprint reads only inside the folder", () => {
  // A directory link; a junction needs no elevation on Windows.
  const dirLink = (target: string, link: string) =>
    Effect.promise(async () => {
      await fs.mkdir(path.dirname(link), { recursive: true })
      await fs.symlink(target, link, "junction")
    })

  // A file link, which Windows allows only to an elevated process or with Developer Mode: the row ends there if it is
  // not allowed.
  const fileLink = (target: string, link: string) =>
    Effect.promise(async () => {
      await fs.mkdir(path.dirname(link), { recursive: true })
      return fs.symlink(target, link, "file").then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "EPERM" || error.code === "UNKNOWN") return false
          throw error
        },
      )
    })

  const directoryRows: ReadonlyArray<{
    readonly name: string
    readonly plant: (place: Effect.Success<typeof layout>) => Effect.Effect<boolean>
    readonly kind: "hooks" | "plugins"
  }> = [
    {
      name: "a link to a folder outside as agents/",
      kind: "hooks",
      plant: (place) => dirLink(place.outside, path.join(place.folder, "agents")).pipe(Effect.as(true)),
    },
    {
      name: "a link to a folder outside as skills/",
      kind: "hooks",
      plant: (place) => dirLink(place.outside, path.join(place.folder, "skills")).pipe(Effect.as(true)),
    },
    {
      name: "a link to a folder outside inside agents/",
      kind: "hooks",
      plant: (place) =>
        dirLink(place.outside, path.join(place.folder, "agents", "team")).pipe(Effect.as(true)),
    },
    {
      name: "a link to a file outside in agents/",
      kind: "hooks",
      plant: (place) => fileLink(path.join(place.outside, "agent.md"), path.join(place.folder, "agents", "linked.md")),
    },
    {
      name: "a link to a folder outside as plugins/",
      kind: "plugins",
      plant: (place) => dirLink(place.outside, path.join(place.folder, "plugins")).pipe(Effect.as(true)),
    },
    {
      name: "a link to a file outside in plugins/",
      kind: "plugins",
      plant: (place) => fileLink(path.join(place.outside, "plugin.ts"), path.join(place.folder, "plugins", "linked.ts")),
    },
    {
      name: "a link to a folder outside as a plugin",
      kind: "plugins",
      plant: (place) => dirLink(place.outside, path.join(place.folder, "plugins", "linked")).pipe(Effect.as(true)),
    },
  ]

  for (const row of directoryRows) {
    it.live(`does not read ${row.name}`, () =>
      Effect.gen(function* () {
        const files = yield* FSUtil.Service
        const place = yield* layout
        if (!(yield* row.plant(place))) return
        const recording = watched(files)
        const before = yield* Fingerprint.directory(recording.view, place.folder, [place.folder])
        yield* changeOutside(place.outside)
        const after = yield* Fingerprint.directory(recording.view, place.folder, [place.folder])
        expect(after).toEqual(before)
        expect(after[row.kind]).not.toBe("unreadable")
        // Nothing outside was listed, opened or read.
        expect(
          recording.seen.filter((item) => item !== "" && path.resolve(item).startsWith(place.outside)),
        ).toEqual([])
      }),
    )
  }

  it.live("names a link that leads out, so planting one is a change", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const place = yield* layout
      yield* Effect.promise(() => fs.mkdir(path.join(place.folder, "agents"), { recursive: true }))
      const none = yield* Fingerprint.directory(files, place.folder, [place.folder])
      if (!(yield* fileLink(path.join(place.outside, "agent.md"), path.join(place.folder, "agents", "team.md")))) return
      const linked = yield* Fingerprint.directory(files, place.folder, [place.folder])
      expect(none.hooks).toBeUndefined()
      expect(linked.hooks).toMatch(/^[0-9a-f]{64}$/)
    }),
  )

  it.live("control: a link to a file inside the folder is read, so an edit to its target is a change", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const place = yield* layout
      const real = path.join(place.folder, "shared", "agent.md")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(real), { recursive: true })
        await fs.writeFile(real, "---\ndescription: a\nhooks:\n  Stop:\n    - command: echo one\n---\nbody\n")
      })
      if (!(yield* fileLink(real, path.join(place.folder, "agents", "linked.md")))) return
      const before = yield* Fingerprint.directory(files, place.folder, [place.folder])
      yield* Effect.promise(() =>
        fs.writeFile(real, "---\ndescription: a\nhooks:\n  Stop:\n    - command: echo two\n---\nbody\n"),
      )
      expect((yield* Fingerprint.directory(files, place.folder, [place.folder])).hooks).not.toBe(before.hooks)
    }),
  )

  // The paths that a document's `skills` can spell. Each leads out of the project, none may be listed.
  const documentRows = [
    { name: "an absolute path", spell: (place: { outside: string }) => place.outside },
    { name: "a path that climbs with ..", spell: (place: { project: string; outside: string }) => path.join(place.project, "..", path.basename(place.outside)) },
    { name: "the folder that holds the project", spell: (place: { base: string }) => place.base },
  ]

  for (const row of documentRows) {
    it.live(`does not read the skills of ${row.name}`, () =>
      Effect.gen(function* () {
        const files = yield* FSUtil.Service
        const place = yield* layout
        const recording = watched(files)
        const root = row.spell(place)
        const read = () =>
          Fingerprint.document(recording.view, path.join(place.project, "orbit.json"), decode({ skills: [root] }), [root], [place.project])
        const before = yield* read()
        yield* changeOutside(place.outside)
        expect(yield* read()).toEqual(before)
        expect(before.skills).toMatch(/^[0-9a-f]{64}$/)
        expect(recording.seen.filter((item) => item !== "" && FSUtil.contains(place.outside, path.resolve(item)) && path.resolve(item) !== place.outside)).toEqual([])
        expect(recording.seen.some((item) => item.endsWith("SKILL.md") || item.endsWith("agent.md"))).toBe(false)
      }),
    )
  }

  for (const share of ["\\\\127.0.0.1\\C$\\skills", "//127.0.0.1/C$/skills", "\\\\?\\UNC\\127.0.0.1\\C$\\skills"]) {
    it.live(`does not touch the network path ${share}`, () =>
      Effect.gen(function* () {
        const files = yield* FSUtil.Service
        const place = yield* layout
        const recording = watched(files)
        const found = yield* Fingerprint.document(
          recording.view,
          path.join(place.project, "orbit.json"),
          decode({ skills: [share] }),
          [share],
          [place.project],
        )
        expect(found.skills).toMatch(/^[0-9a-f]{64}$/)
        expect(recording.seen.filter((item) => /^[\\/]{2}/.test(item))).toEqual([])
      }),
    )
  }

  it.live("control: the skills inside the project are read, so an edit is a change", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const place = yield* layout
      const skills = path.join(place.project, "skills")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(skills, "demo"), { recursive: true })
        await fs.writeFile(path.join(skills, "demo", "SKILL.md"), skill("echo a"))
      })
      const read = () =>
        Fingerprint.document(files, path.join(place.project, "orbit.json"), decode({ skills: [skills] }), [skills], [place.project])
      const before = yield* read()
      yield* Effect.promise(() => fs.writeFile(path.join(skills, "demo", "SKILL.md"), skill("echo b")))
      expect((yield* read()).skills).not.toBe(before.skills)
    }),
  )

  it.live("does not read a link to a device, and does not wait on it", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const files = yield* FSUtil.Service
      const place = yield* layout
      yield* fileLink("/dev/zero", path.join(place.folder, "agents", "z.md"))
      const started = Date.now()
      const found = yield* Fingerprint.directory(files, place.folder, [place.folder])
      expect(Date.now() - started).toBeLessThan(2000)
      expect(found.hooks).toMatch(/^[0-9a-f]{64}$/)
    }),
  )
})

// Class 6: a link that names a share. Reading a path below such a link makes Windows connect to the share, a host the
// repository chose, so nothing below the link may be handed to the file system, readLink included. Each row has its own
// unroutable TEST-NET-1 address (192.0.2.16, 192.0.2.17), because Windows remembers a host that failed.
describe("Fingerprint never reaches below a link that names a share", () => {
  const below = (seen: readonly string[], link: string) =>
    seen.filter((item) => item !== "" && path.resolve(item).startsWith(link + path.sep))

  // Symlinks to a share need Developer Mode or elevation: the row ends there when refused.
  const shareLink = (link: string, host: string) =>
    Effect.promise(() =>
      fs
        .mkdir(path.dirname(link), { recursive: true })
        .then(() => fs.symlink(`\\\\${host}\\share`, link, "dir"))
        .then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "EPERM" || error.code === "UNKNOWN") return false
            throw error
          },
        ),
    )

  it.live("document skills under a link to a share", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const files = yield* FSUtil.Service
      const place = yield* layout
      const link = path.join(place.project, "linked")
      if (!(yield* shareLink(link, "192.0.2.16"))) return
      const recording = watched(files)
      const started = Date.now()
      const found = yield* Fingerprint.document(
        recording.view,
        path.join(place.project, "orbit.json"),
        decode({ skills: ["linked/skills"] }),
        [path.join(link, "skills")],
        [place.project],
      )
      expect(found.skills).toMatch(/^[0-9a-f]{64}$/)
      expect(below([...recording.seen, ...recording.links], link)).toEqual([])
      expect(Date.now() - started).toBeLessThan(5000)
    }),
  )

  it.live(".orbit itself is a link to a share", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const files = yield* FSUtil.Service
      const place = yield* layout
      yield* Effect.promise(() => fs.rm(place.folder, { recursive: true }))
      if (!(yield* shareLink(place.folder, "192.0.2.17"))) return
      const recording = watched(files)
      const started = Date.now()
      yield* Fingerprint.directory(recording.view, place.folder, [place.project])
      expect(below([...recording.seen, ...recording.links], place.folder)).toEqual([])
      expect(Date.now() - started).toBeLessThan(5000)
    }),
  )

  it.live("control: a link to a local file is named, not read", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const place = yield* layout
      const linked = yield* Effect.promise(() =>
        fs
          .mkdir(path.join(place.folder, "plugins"), { recursive: true })
          .then(() => fs.symlink(path.join(place.outside, "plugin.ts"), path.join(place.folder, "plugins", "linked.ts"), "file"))
          .then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "EPERM" || error.code === "UNKNOWN") return false
              throw error
            },
          ),
      )
      if (!linked) return
      const recording = watched(files)
      const found = yield* Fingerprint.directory(recording.view, place.folder, [place.folder])
      expect(found.plugins).toMatch(/^[0-9a-f]{64}$/)
      expect(touched(recording.seen, place.outside)).toEqual([])
    }),
  )
})
