// context-memory-11: team memory lives in the repository (`.orbit/team-memory/`), and everyone who works in it reads what
// is written there, so the file tools refuse to write text that looks like a secret into it, as the reference's write
// and edit validation does: before any permission question and before anything is written, naming the kinds of secret
// found and never the text itself. Write scans its whole content, Edit only its replacement (an edit that takes a secret
// out is never refused), and Patch, Orbit's own spelling of both, what it adds. The scan follows the path, not the
// `memory.team` switch or trust, as the reference's does: it is the one team behaviour of an untrusted project.
//
// The secrets are assembled at run time, so that no file of the repository holds a string a scanner takes for a real one.
// Every refused row has a control in the same run that writes, so no row passes because nothing is written.
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { ToolFailure } from "@orbit/ai"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { ConfigWatch } from "@orbit/core/config/watch"
import type { ConfigDiscovery } from "@orbit/core/config/discovery"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { FileMutation } from "@orbit/core/file-mutation"
import { Formatter } from "@orbit/core/formatter"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { PatchTool } from "@orbit/core/tool/plugin/patch"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { ToolTraits } from "@orbit/core/tool/traits"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

// One node per tool, each registered against the real registry, as the tool suites register theirs.
const writeNode = makeLocationNode({
  name: "test/team-write",
  layer: Layer.effectDiscard(registerToolPlugin(WriteTool.Plugin)),
  deps: [
    FileLedger.node,
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})
const editNode = makeLocationNode({
  name: "test/team-edit",
  layer: Layer.effectDiscard(registerToolPlugin(EditTool.Plugin)),
  deps: [
    FileLedger.node,
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})
const patchNode = makeLocationNode({
  name: "test/team-patch",
  layer: Layer.effectDiscard(registerToolPlugin(PatchTool.Plugin)),
  deps: [
    FileLedger.node,
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

const sessionID = Session.ID.make("ses_team_memory_test")
const linkType = process.platform === "win32" ? "junction" : "dir"
const it = testEffect(Layer.empty)

// A key in the shape of a source host's personal access token, and one in the shape of a cloud access key.
const ALNUM = "aB3dE5gH7jK9mN2pQ4rS6tU8vW0xY1zC"
const fill = (alphabet: string, length: number) =>
  Array.from({ length }, (_, index) => alphabet[(index * 7 + 3) % alphabet.length]).join("")
const pat = ["gh", "p_", fill(ALNUM, 36)].join("")
const cloud = ["AK", "IA", fill("J2K3L4M5N6P7Q2R3", 16)].join("")

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const project = path.join(root, "project")
  const team = path.join(project, ".orbit", "team-memory")
  const outside = path.join(root, "outside")
  yield* Effect.promise(() => Promise.all([team, outside].map((folder) => fs.mkdir(folder, { recursive: true }))))
  return { root, project, team, outside }
})
type Layout = Effect.Success<typeof layout>

// What a call asked and wrote: the permission questions in order, and every file the environment wrote.
const record = () => {
  const asked: string[] = []
  const written: string[] = []
  const permission = permissionLayer({ assert: (input) => Effect.sync(() => asked.push(input.action)) })
  return { asked, written, permission }
}

const withTools = <A, E>(
  l: Layout,
  log: ReturnType<typeof record>,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, Tool.Service>,
  untrusted = false,
) =>
  Effect.gen(function* () {
    return yield* body(yield* Tool.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          Tool.node,
          FileAccess.node,
          FileMutation.node,
          FileLedger.node,
          writeNode,
          editNode,
          patchNode,
        ]),
        [
          FileLedger.node.replace(FileLedger.permissiveLayer),
          Environment.node.replace(
            transformEnvironmentFiles((files) => ({
              write: (target, content) =>
                Effect.sync(() => log.written.push(target)).pipe(Effect.andThen(files.write(target, content))),
            })),
          ),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(l.project) }))),
          ),
          Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
          Permission.node.replace(log.permission),
          ...(untrusted ? untrustedProjectNodes : []),
        ],
      ),
    ),
  )

const call = (name: "Write" | "Edit" | "Patch", input: Record<string, unknown>, id: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

const read = (file: string) =>
  Effect.promise(() =>
    fs.readFile(file, "utf8").then(
      (text) => text,
      () => undefined,
    ),
  )

// A refusal of the scan: a tool error that names the kind of secret and team memory, and holds none of the secret.
const expectRefused = (result: { readonly status: string }, label: string, secret: string) => {
  expect(result.status).toBe("error")
  const shown = JSON.stringify(result)
  expect(shown).toContain(label)
  expect(shown.toLowerCase()).toContain("team memory")
  expect(shown).not.toContain(secret)
}

describe("a Write into team memory", () => {
  it.live("refuses a fake key in a Write into team memory before any question", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const log = record()
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const refused = yield* executeTool(
            registry,
            call("Write", { file_path: ".orbit/team-memory/deploy.md", content: `Deploy with ${pat}\n` }, "w1"),
          )
          const askedAfterRefusal = [...log.asked]
          // The controls: the same text outside the team folder, and clean text inside it, are written.
          const outside = yield* executeTool(
            registry,
            call("Write", { file_path: "notes/deploy.md", content: `Deploy with ${pat}\n` }, "w2"),
          )
          const clean = yield* executeTool(
            registry,
            call(
              "Write",
              { file_path: ".orbit/team-memory/testing.md", content: "Tests hit a real database.\n" },
              "w3",
            ),
          )
          return { refused, askedAfterRefusal, outside, clean }
        }),
      )
      expectRefused(out.refused, "GitHub PAT", pat)
      expect(out.askedAfterRefusal).toEqual([])
      expect(yield* read(path.join(l.team, "deploy.md"))).toBeUndefined()
      expect(log.written.filter((file) => file.endsWith("deploy.md") && file.includes("team-memory"))).toEqual([])
      expect(out.outside.status).toBe("completed")
      expect(out.clean.status).toBe("completed")
      expect(yield* read(path.join(l.team, "testing.md"))).toBe("Tests hit a real database.\n")
    }),
  )

  it.live("names every kind of secret it found, once each", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const log = record()
      const result = yield* withTools(l, log, (registry) =>
        executeTool(
          registry,
          call("Write", { file_path: ".orbit/team-memory/keys.md", content: `${pat}\n${cloud}\n${pat}\n` }, "w1"),
        ),
      )
      expectRefused(result, "GitHub PAT", pat)
      const shown = JSON.stringify(result)
      expect(shown).toContain("AWS Access Token")
      expect(shown).not.toContain(cloud)
      expect(shown.split("GitHub PAT").length).toBe(2)
      expect(log.asked).toEqual([])
    }),
  )

  // Spellings the file tools accept for one place: each lands in the team folder and is scanned. A sibling whose name
  // only starts the same, and a `..` back out of the folder, are not in it, and are written.
  it.live("refuses a fake key by every spelling of the team folder", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const log = record()
      const spellings = [
        ".orbit/team-memory/a.md",
        "./.orbit/x/../team-memory/b.md",
        path.join(l.team, "c.md"),
        ...(process.platform === "win32"
          ? [".ORBIT\\TEAM-MEMORY\\d.md", path.join(l.team, "e.md").replaceAll("\\", "/")]
          : []),
      ]
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const refused = yield* Effect.forEach(spellings, (file, index) =>
            executeTool(registry, call("Write", { file_path: file, content: `key ${pat}\n` }, `s${index}`)),
          )
          const sibling = yield* executeTool(
            registry,
            call("Write", { file_path: ".orbit/team-memory-evil/f.md", content: `key ${pat}\n` }, "sibling"),
          )
          const above = yield* executeTool(
            registry,
            call("Write", { file_path: ".orbit/team-memory/../g.md", content: `key ${pat}\n` }, "above"),
          )
          return { refused, sibling, above }
        }),
      )
      for (const result of out.refused) expectRefused(result, "GitHub PAT", pat)
      expect(out.sibling.status).toBe("completed")
      expect(out.above.status).toBe("completed")
      expect(yield* Effect.promise(() => fs.readdir(l.team))).toEqual([])
    }),
  )

  // Class 3: the stricter answer wins. A link elsewhere in the project that leads into the team folder lands the write
  // there, so it is scanned by where it really goes.
  it.live("scans a write through a link elsewhere in the project that leads into the team folder", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* Effect.promise(() => fs.symlink(l.team, path.join(l.project, "notes"), linkType))
      const log = record()
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const refused = yield* executeTool(
            registry,
            call("Write", { file_path: "notes/linked.md", content: `key ${pat}\n` }, "l1"),
          )
          const clean = yield* executeTool(
            registry,
            call("Write", { file_path: "notes/clean.md", content: "clean\n" }, "l2"),
          )
          return { refused, clean }
        }),
      )
      expectRefused(out.refused, "GitHub PAT", pat)
      expect(yield* read(path.join(l.team, "linked.md"))).toBeUndefined()
      expect(out.clean.status).toBe("completed")
      expect(yield* read(path.join(l.team, "clean.md"))).toBe("clean\n")
    }),
  )

  // Class 3: a team folder that is a link to another folder of the project is in the repository by both names, so a
  // write by the name of the folder it leads to is scanned as well. A clean write there is the control.
  it.live("scans a write by the real name of a team folder that is a link inside the project", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const shared = path.join(l.project, "shared")
      yield* Effect.promise(async () => {
        await fs.rm(l.team, { recursive: true })
        await fs.mkdir(shared)
        await fs.symlink(shared, l.team, linkType)
      })
      const log = record()
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const refused = yield* executeTool(
            registry,
            call("Write", { file_path: "shared/real.md", content: `key ${pat}\n` }, "r1"),
          )
          const clean = yield* executeTool(
            registry,
            call("Write", { file_path: "shared/clean.md", content: "clean\n" }, "r2"),
          )
          return { refused, clean }
        }),
      )
      expectRefused(out.refused, "GitHub PAT", pat)
      expect(log.asked).toEqual(["Edit"])
      expect(yield* read(path.join(shared, "real.md"))).toBeUndefined()
      expect(out.clean.status).toBe("completed")
      expect(yield* read(path.join(shared, "clean.md"))).toBe("clean\n")
    }),
  )

  // A team folder that leads out of the project turns team memory off (class 4), but a write by the folder's own name
  // is still scanned, as the reference's guard asks only whether the path is in the folder. A clean write is the control.
  it.live("scans a write by the folder's name when the team folder leads out of the project", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* Effect.promise(async () => {
        await fs.rm(l.team, { recursive: true })
        await fs.symlink(l.outside, l.team, linkType)
      })
      const log = record()
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const refused = yield* executeTool(
            registry,
            call("Write", { file_path: ".orbit/team-memory/out.md", content: `key ${pat}\n` }, "o1"),
          )
          const askedAfterRefusal = [...log.asked]
          const clean = yield* executeTool(
            registry,
            call("Write", { file_path: ".orbit/team-memory/clean.md", content: "clean\n" }, "o2"),
          )
          return { refused, askedAfterRefusal, clean }
        }),
      )
      expectRefused(out.refused, "GitHub PAT", pat)
      expect(out.askedAfterRefusal).toEqual([])
      expect(yield* read(path.join(l.outside, "out.md"))).toBeUndefined()
      expect(out.clean.status).toBe("completed")
      expect(yield* read(path.join(l.outside, "clean.md"))).toBe("clean\n")
    }),
  )

  // A team folder that leads onto the whole project, or out of it, does not make the place it leads to team memory: a
  // repository must not get every write of the project, or of a folder of the person's, refused. A write by the team
  // folder's own name is still refused in the same run, as the control.
  it.live("scans no write by another name when the team folder leads onto the project or out of it", () =>
    Effect.gen(function* () {
      const rows = yield* Effect.forEach(["project", "outside"] as const, (target) =>
        Effect.gen(function* () {
          const l = yield* layout
          const place = target === "project" ? path.join(l.project, "src") : l.outside
          yield* Effect.promise(async () => {
            await fs.rm(l.team, { recursive: true })
            await fs.mkdir(place, { recursive: true })
            await fs.symlink(target === "project" ? l.project : l.outside, l.team, linkType)
          })
          return yield* withTools(l, record(), (registry) =>
            Effect.gen(function* () {
              const elsewhere = yield* executeTool(
                registry,
                call("Write", { file_path: path.join(place, "a.md"), content: `key ${pat}\n` }, "e1"),
              )
              const named = yield* executeTool(
                registry,
                call("Write", { file_path: ".orbit/team-memory/b.md", content: `key ${pat}\n` }, "e2"),
              )
              return { target, elsewhere, named, written: yield* read(path.join(place, "a.md")) }
            }),
          )
        }),
      )
      for (const row of rows) {
        expect({ target: row.target, status: row.elsewhere.status, written: row.written }).toEqual({
          target: row.target,
          status: "completed",
          written: `key ${pat}\n`,
        })
        expectRefused(row.named, "GitHub PAT", pat)
      }
    }),
  )

  // The reference's guard follows the path alone. Orbit's does too: an untrusted project, where nothing else of team
  // memory works, still keeps a secret out of the folder that will be committed. The trusted run is the control.
  it.live("scans whether or not the project is trusted", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const untrusted = record()
      const refused = yield* withTools(
        l,
        untrusted,
        (registry) =>
          Effect.gen(function* () {
            return {
              secret: yield* executeTool(
                registry,
                call("Write", { file_path: ".orbit/team-memory/u.md", content: `key ${pat}\n` }, "u1"),
              ),
              clean: yield* executeTool(
                registry,
                call("Write", { file_path: ".orbit/team-memory/v.md", content: "clean\n" }, "u2"),
              ),
            }
          }),
        true,
      )
      const trusted = yield* withTools(l, record(), (registry) =>
        executeTool(registry, call("Write", { file_path: ".orbit/team-memory/t.md", content: `key ${pat}\n` }, "t1")),
      )
      expectRefused(refused.secret, "GitHub PAT", pat)
      expect(refused.clean.status).toBe("completed")
      expectRefused(trusted, "GitHub PAT", pat)
    }),
  )
})

describe("an Edit in team memory", () => {
  // Only the replacement is scanned: an edit that brings a key in is refused, and one that takes a key out is not, even
  // though the file around it still holds one.
  it.live("refuses a key in the replacement and lets an edit take one out", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const file = path.join(l.team, "deploy.md")
      const original = `# Deploy\nold line\nleft over ${cloud}\nremove ${pat}\n`
      yield* Effect.promise(() => fs.writeFile(file, original))
      const log = record()
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const refused = yield* executeTool(
            registry,
            call(
              "Edit",
              { file_path: ".orbit/team-memory/deploy.md", old_string: "old line", new_string: `token ${pat}` },
              "e1",
            ),
          )
          const askedAfterRefusal = [...log.asked]
          const unchanged = yield* read(file)
          const removed = yield* executeTool(
            registry,
            call(
              "Edit",
              { file_path: ".orbit/team-memory/deploy.md", old_string: `remove ${pat}`, new_string: "removed" },
              "e2",
            ),
          )
          return { refused, askedAfterRefusal, unchanged, removed }
        }),
      )
      expectRefused(out.refused, "GitHub PAT", pat)
      expect(out.askedAfterRefusal).toEqual([])
      expect(out.unchanged).toBe(original)
      expect(out.removed.status).toBe("completed")
      expect(yield* read(file)).toBe(`# Deploy\nold line\nleft over ${cloud}\nremoved\n`)
    }),
  )

  // Edit's validation refuses the key before the file is read, and its `execute`, which decides, refuses it again on its
  // own: each is run alone here, so neither passes because the other refused.
  it.live("refuses a key in its validation and again in execute", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const file = path.join(l.team, "deploy.md")
      yield* Effect.promise(() => fs.writeFile(file, "old line\n"))
      const log = record()
      const input = { file_path: ".orbit/team-memory/deploy.md", old_string: "old line", new_string: `token ${pat}` }
      const context = {
        sessionID,
        ...toolIdentity,
        id: Tool.CallID.make("call-team-edit"),
        progress: () => Effect.void,
        traits: ToolTraits.defaults,
      }
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const tool = (yield* registry.list()).find((item) => item.id === EditTool.name)
          if (tool?.validate === undefined) return yield* Effect.die("The edit tool has no validate")
          return {
            validated: yield* tool.validate(input, context).pipe(Effect.flip),
            executed: yield* tool.execute(input, context).pipe(Effect.flip),
            clean: yield* tool.validate({ ...input, new_string: "new line" }, context).pipe(Effect.exit),
          }
        }),
      )
      for (const error of [out.validated, out.executed]) {
        expect(error).toBeInstanceOf(ToolFailure)
        expect(error.message).toContain("GitHub PAT")
        expect(error.message).not.toContain(pat)
      }
      expect(Exit.isSuccess(out.clean)).toBe(true)
      expect(log.asked).toEqual([])
      expect(yield* read(file)).toBe("old line\n")
    }),
  )
})

describe("a Patch into team memory", () => {
  // Patch writes files as Write and Edit do, so its new text is scanned the same way: an added file's content, an update's
  // added lines, and the whole of a file it moves into the team folder.
  it.live("refuses a key in an added file, an added line or a file moved into the team folder", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* Effect.promise(async () => {
        await fs.writeFile(path.join(l.team, "notes.md"), "first\n")
        await fs.writeFile(path.join(l.project, "carried.md"), `token ${pat}\nkeep\n`)
      })
      const log = record()
      const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const added = yield* executeTool(
            registry,
            call("Patch", { patchText: patch(`*** Add File: .orbit/team-memory/new.md\n+key ${pat}`) }, "p1"),
          )
          const updated = yield* executeTool(
            registry,
            call(
              "Patch",
              { patchText: patch(`*** Update File: .orbit/team-memory/notes.md\n@@\n-first\n+${pat}`) },
              "p2",
            ),
          )
          const moved = yield* executeTool(
            registry,
            call(
              "Patch",
              {
                patchText: patch(
                  "*** Update File: carried.md\n*** Move to: .orbit/team-memory/carried.md\n@@\n-keep\n+kept",
                ),
              },
              "p3",
            ),
          )
          const askedAfterRefusals = log.asked.filter((action) => action === "Edit")
          const clean = yield* executeTool(
            registry,
            call("Patch", { patchText: patch("*** Add File: .orbit/team-memory/clean.md\n+clean") }, "p4"),
          )
          return { added, updated, moved, askedAfterRefusals, clean }
        }),
      )
      expectRefused(out.added, "GitHub PAT", pat)
      expectRefused(out.updated, "GitHub PAT", pat)
      expectRefused(out.moved, "GitHub PAT", pat)
      expect(out.askedAfterRefusals).toEqual([])
      expect(yield* read(path.join(l.team, "new.md"))).toBeUndefined()
      expect(yield* read(path.join(l.team, "notes.md"))).toBe("first\n")
      expect(yield* read(path.join(l.team, "carried.md"))).toBeUndefined()
      expect(yield* read(path.join(l.project, "carried.md"))).toBe(`token ${pat}\nkeep\n`)
      expect(out.clean.status).toBe("completed")
      expect(yield* read(path.join(l.team, "clean.md"))).toBe("clean\n")
    }),
  )

  // A move's added lines are scanned against its destination too, before its source is asked about: a file outside the
  // project that a patch moves into the team folder, adding a key on the way, is refused with no question about the
  // outside folder. The same move without the key is the control, which asks about it and lands.
  it.live("refuses a key that a move into the team folder adds before it asks about the file it moves", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const source = path.join(l.outside, "carried.md")
      yield* Effect.promise(() => fs.writeFile(source, "keep\n"))
      const log = record()
      const patch = (line: string) =>
        `*** Begin Patch\n*** Update File: ${source}\n*** Move to: .orbit/team-memory/carried.md\n@@\n-keep\n+${line}\n*** End Patch`
      const out = yield* withTools(l, log, (registry) =>
        Effect.gen(function* () {
          const refused = yield* executeTool(registry, call("Patch", { patchText: patch(`key ${pat}`) }, "m1"))
          const askedAfterRefusal = [...log.asked]
          const clean = yield* executeTool(registry, call("Patch", { patchText: patch("kept") }, "m2"))
          return { refused, askedAfterRefusal, clean }
        }),
      )
      expectRefused(out.refused, "GitHub PAT", pat)
      expect(out.askedAfterRefusal).toEqual([])
      expect(out.clean.status).toBe("completed")
      expect(log.asked).toContain("external_directory")
      expect(yield* read(path.join(l.team, "carried.md"))).toBe("kept\n")
      expect(yield* read(source)).toBeUndefined()
    }),
  )
})

describe("a Patch that takes a key out of team memory", () => {
  // Only the lines a hunk adds are scanned. A hunk whose context holds a key already in the file, as it takes another
  // line out, adds nothing, as an Edit that takes a key out adds nothing. A hunk that adds a key in the same file is
  // the control, refused in the same run.
  it.live("lets a patch take a line out beside a key and refuses one that adds a key", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const file = path.join(l.team, "keys.md")
      yield* Effect.promise(() => fs.writeFile(file, `first\n${pat}\nold ${cloud}\nlast\n`))
      const patch = (body: string) =>
        `*** Begin Patch\n*** Update File: .orbit/team-memory/keys.md\n${body}\n*** End Patch`
      const out = yield* withTools(l, record(), (registry) =>
        Effect.gen(function* () {
          const removed = yield* executeTool(
            registry,
            call("Patch", { patchText: patch(`@@\n ${pat}\n-old ${cloud}\n last`) }, "k1"),
          )
          const added = yield* executeTool(registry, call("Patch", { patchText: patch(`@@\n-first\n+${pat}`) }, "k2"))
          return { removed, added }
        }),
      )
      expect(out.removed.status).toBe("completed")
      expectRefused(out.added, "GitHub PAT", pat)
      expect(yield* read(file)).toBe(`first\n${pat}\nlast\n`)
    }),
  )
})

// The config watch of a project's `.orbit` folder sees every file below it. A memory write is not config, so it must not
// reach the reloaders of agents, commands, instructions and plugin sources.
describe("the config watch of .orbit", () => {
  it.live("ignores the team memory folder", () =>
    Effect.sync(() => {
      const project = path.resolve("team-watch-project")
      const root = AbsolutePath.make(path.join(project, ".orbit"))
      const sources: ConfigDiscovery.Sources = {
        direct: [],
        local: [],
        project: [{ path: root, present: true }],
        compat: [],
        compatSettings: [],
      }
      const watch = Array.from(ConfigWatch.plan(sources).values()).find(
        (target) => target.path === root && target.type === "directory",
      )
      expect(watch).toBeDefined()
      // The folder at the top of `.orbit` only: a skill or agent folder of the same name further down still reloads.
      expect(watch && "ignore" in watch ? watch.ignore : []).toEqual(
        expect.arrayContaining(["node_modules", ".git", "team-memory", "team-memory/**"]),
      )
      expect(watch && "ignore" in watch ? watch.ignore : []).not.toContain("**/team-memory/**")
    }),
  )
})
