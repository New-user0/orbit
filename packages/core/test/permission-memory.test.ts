// context-memory-9, classes 3, 4 and 8: the memory folder of the project is prompt-free for the file tools, end to end
// through the real Agent layer, FileAccess and Permission, as the reference's write and read carve-outs make it. A
// write or read there is allowed ahead of the person's ask rules, while a deny of theirs, the session's or an agent's
// own wins over any ask and over a mode (a later allow of the person's lifts it, as elsewhere). The allow decides only a call whose real place is in the real memory folder, so a link inside the
// folder cannot carry a prompt-free write out (the M5 verification line "An edit through a link inside a memory folder
// is not prompt-free"). Every row that expects a question also checks a plain file of the memory folder in the same
// run, so the row cannot pass because nothing is prompt-free.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema, type Types } from "effect"
import { Document, Info, type Entry, type Scope } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AgentPlugin } from "@orbit/core/plugin/agent"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionStore } from "@orbit/core/session/store"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { ShellGuard } from "@orbit/core/shell/guard"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { insertSession } from "./lib/session-row"
import { agentHost, host } from "./plugin/host"

const probe = Agent.ID.make("probe")
const linkType = process.platform === "win32" ? "junction" : "dir"
const main = "ses_memory_main"
const timeout = { timeout: 120_000 }
const decodeInfo = Schema.decodeUnknownSync(Info)

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const folders = {
    project: path.join(root, "project"),
    tmp: path.join(root, "tmp"),
    elsewhere: path.join(root, "elsewhere"),
    data: path.join(root, "data"),
    config: path.join(root, "config"),
  }
  yield* Effect.promise(() =>
    Promise.all(Object.values(folders).map((folder) => fs.mkdir(folder, { recursive: true }))),
  )
  // The fixture Location is the `global` project, so its memory folder is `<data>/memory/global`.
  return { root, ...folders, memory: path.join(folders.data, "memory", Project.ID.global) }
})
type Layout = Effect.Success<typeof layout>

const configured = (scope: Scope, memory: Record<string, unknown>) =>
  new Document({
    type: "document",
    scope,
    path: AbsolutePath.make(path.resolve(`/config/${scope}/orbit.json`)),
    info: decodeInfo({ memory }),
  })

const provide = (l: Layout, global: Partial<Global.Interface> = {}, entries: Entry[] = []) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionStore.node,
        PermissionSaved.node,
        Agent.node,
        PluginHooks.node,
        ManagedPolicy.node,
        Permission.node,
        Global.node,
        FileAccess.node,
        ProjectTrust.node,
        FSUtil.node,
        Location.node,
      ]),
      [
        Global.node.replace(Global.layerWith({ tmp: l.tmp, data: l.data, config: l.config, ...global })),
        Config.node.replace(Config.testLayer(entries)),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(l.project) }))),
        ),
      ],
    ),
  )

// The agent without its allow of everything, so that what no rule speaks to is the fallthrough ask, plus `extra` after
// its own rules, as the person's config rules come.
const seed = (l: Layout, extra: Permission.Ruleset = [], ids: readonly Agent.ID[] = [probe]) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    for (const id of ids)
      yield* agents.transform((editor) =>
        editor.update(id, (agent) => {
          agent.permissions = agent.permissions.filter(
            (rule) => !(rule.action === "*" && rule.resource === "*" && rule.effect === "allow"),
          )
          agent.permissions.push(...extra)
        }),
      )
    yield* insertSession({ id: main, directory: l.project, agent: ids[0] })
  })

// What the file tools do, in their order: resolve the path, ask for the folder, and then for the file with `action`.
const decide = (file: string, action: "Edit" | "Read" = "Edit", agent: Agent.ID = probe, sessionID = main) =>
  Effect.gen(function* () {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const base = { sessionID: SessionSchema.ID.make(sessionID), agent }
    const resolved = yield* Effect.result(access.resolve({ path: file, kind: "file" }))
    if (resolved._tag === "Failure") return { effect: "refused", stage: "resolve" }
    const target = resolved.success
    const external = access.externalRequest([target], base)
    if (external) {
      const folder = (yield* permission.ask({ ...external, id: Permission.ID.create() })).effect
      if (folder !== "allow") return { effect: folder, stage: "external_directory" }
    }
    const answer = yield* permission.ask({
      id: Permission.ID.create(),
      action,
      resources: [target.resource],
      save: ["*"],
      ...FileAccess.leadsOf([target]),
      metadata: { paths: [target.place] },
      ...base,
    })
    return { effect: answer.effect, stage: action }
  })

const allowEdit = { effect: "allow", stage: "Edit" }

// Adds the built-in agents. The plugin edits the agent itself, as the server's plugin host lets it: `agentHost` edits a
// copy, which carries none of the marks of Orbit's own rules.
const builtIns = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* AgentPlugin.Plugin.effect(
    host({
      agent: {
        ...agentHost(agents),
        transform: (callback) =>
          agents.transform((editor) =>
            callback({
              list: () => editor.list() as Types.DeepMutable<Agent.Info>[],
              get: (id) => editor.get(Agent.ID.make(id)) as Types.DeepMutable<Agent.Info> | undefined,
              default: (id) => editor.default(id === undefined ? undefined : Agent.ID.make(id)),
              update: (id, update) => editor.update(Agent.ID.make(id), update),
              remove: (id) => editor.remove(Agent.ID.make(id)),
            }),
          ),
      },
    }),
  )
})

describe("the memory folder of the project", () => {
  // A file anywhere below the folder, MEMORY.md included, is written without a question.
  for (const [name, file] of [
    ["a new memory file", (l: Layout) => path.join(l.memory, "testing.md")],
    ["a file in a folder below it", (l: Layout) => path.join(l.memory, "topics", "deep", "build.md")],
    ["the index", (l: Layout) => path.join(l.memory, "MEMORY.md")],
  ] as const)
    it.live(
      `writes ${name} without a question`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            return yield* decide(file(l))
          }).pipe(provide(l))
          expect(out).toEqual(allowEdit)
        }),
      timeout,
    )

  // The folder is this project's and no other: each place beside it asks, as it did before.
  for (const [name, file] of [
    ["another project's memory folder", (l: Layout) => path.join(l.data, "memory", "a".repeat(40), "a.md")],
    ["a folder that merely starts with the same name", (l: Layout) => path.join(`${l.memory}x`, "a.md")],
    ["the folder that holds every project's memory", (l: Layout) => path.join(l.data, "memory", "a.md")],
    ["a `..` out of the folder", (l: Layout) => `${l.memory}${path.sep}..${path.sep}${"b".repeat(40)}${path.sep}a.md`],
    ["the data folder", (l: Layout) => path.join(l.data, "a.md")],
  ] as const)
    it.live(
      `asks about ${name}`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            return { row: yield* decide(file(l)), control: yield* decide(path.join(l.memory, "a.md")) }
          }).pipe(provide(l))
          expect(out.control).toEqual(allowEdit)
          expect(out.row.effect).not.toBe("allow")
        }),
      timeout,
    )

  // The reference's carve-out comes before the ask rules: `edit: ask` and `read: ask` do not reach memory files
  // (the M5 manual check "memory edits do not prompt under `edit: ask`"), while a project file still asks under them.
  it.live(
    "writes and reads memory without a question under the person's ask rules for edits, reads and folders",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, [
            { action: "Edit", resource: "*", effect: "ask" },
            { action: "Read", resource: "*", effect: "ask" },
            { action: "external_directory", resource: "*", effect: "ask" },
          ])
          return {
            write: yield* decide(path.join(l.memory, "a.md")),
            read: yield* decide(path.join(l.memory, "a.md"), "Read"),
            project: yield* decide(path.join(l.project, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({
          write: allowEdit,
          read: { effect: "allow", stage: "Read" },
          project: { effect: "ask", stage: "Edit" },
        })
      }),
    timeout,
  )

  // A deny wins over any ask and over a mode: a deny for one memory file stays a deny under a later, broader ask that the
  // last-match order would otherwise let decide. As everywhere else in Orbit, a later allow of the person's lifts it.
  it.live(
    "denies a memory file under the person's deny, even with a broader ask after it",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, [
            { action: "Edit", resource: path.join(l.memory, "secret.md"), effect: "deny" },
            { action: "Edit", resource: "*", effect: "ask" },
          ])
          yield* insertSession({
            id: "ses_memory_denied",
            directory: l.project,
            agent: probe,
            permission: [{ action: "Edit", resource: path.join(l.memory, "*"), effect: "deny" }],
          })
          yield* insertSession({
            id: "ses_memory_lifted",
            directory: l.project,
            agent: probe,
            permission: [
              { action: "Edit", resource: path.join(l.memory, "*"), effect: "deny" },
              { action: "Edit", resource: "*", effect: "allow" },
            ],
          })
          return {
            denied: yield* decide(path.join(l.memory, "secret.md")),
            neighbour: yield* decide(path.join(l.memory, "other.md")),
            session: yield* decide(path.join(l.memory, "other.md"), "Edit", probe, "ses_memory_denied"),
            lifted: yield* decide(path.join(l.memory, "other.md"), "Edit", probe, "ses_memory_lifted"),
          }
        }).pipe(provide(l))
        expect(out).toEqual({
          denied: { effect: "deny", stage: "Edit" },
          neighbour: allowEdit,
          session: { effect: "deny", stage: "Edit" },
          lifted: allowEdit,
        })
      }),
    timeout,
  )

  // A mode is not a rule of the person's: the reference lets plan mode write memory, so Plan's deny of every edit does
  // not stop a memory write, while it still stops a project file.
  it.live(
    "writes memory under a mode's deny of every edit, and the mode still denies a project file",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, [Agent.modeRule({ action: "Edit", resource: "*", effect: "deny" as const })])
          return {
            memory: yield* decide(path.join(l.memory, "a.md")),
            project: yield* decide(path.join(l.project, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({ memory: allowEdit, project: { effect: "deny", stage: "Edit" } })
      }),
    timeout,
  )

  // The M1 check "an explore subagent cannot call the memory tool" becomes: a read-only agent cannot write a memory
  // file. It may read one, as the reference's read carve-out lets every agent.
  for (const row of [
    { agent: "explore", write: "deny", read: "allow" },
    { agent: "title", write: "deny", read: "deny" },
    { agent: "general", write: "allow", read: "allow" },
  ] as const)
    it.live(
      `answers the built-in ${row.agent} agent's memory write with ${row.write} and its read with ${row.read}`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* builtIns
            yield* seed(l, [], [Agent.ID.make(row.agent), probe])
            return {
              write: (yield* decide(path.join(l.memory, "a.md"), "Edit", Agent.ID.make(row.agent))).effect,
              read: (yield* decide(path.join(l.memory, "a.md"), "Read", Agent.ID.make(row.agent))).effect,
              control: (yield* decide(path.join(l.memory, "a.md"))).effect,
            }
          }).pipe(provide(l))
          expect(out).toEqual({ write: row.write, read: row.read, control: "allow" })
        }),
      timeout,
    )

  // The carve-out is for the file tools, as the reference's is: a shell command that names the folder is asked about.
  it.live(
    "asks about a shell command in the memory folder",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l)
          const permission = yield* Permission.Service
          const shell = (command: string) =>
            permission
              .ask({
                id: Permission.ID.create(),
                action: "Bash",
                resources: [command],
                sessionID: SessionSchema.ID.make(main),
                agent: probe,
              })
              .pipe(Effect.map((answer) => answer.effect))
          return {
            shell: yield* shell(`rm ${path.join(l.memory, "a.md")}`),
            // A command that is only the path of a script the model wrote into the folder runs that script.
            script: yield* shell(path.join(l.memory, "run.sh")),
            control: yield* decide(path.join(l.memory, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({ shell: "ask", script: "ask", control: allowEdit })
      }),
    timeout,
  )

  // The default agent allows every command and asks only about a folder outside the project, so that folder question is
  // all that stands between a command and the memory folder. The shell guard's question is asked, and stays asked when
  // an "always" for another folder makes the pending questions be decided again; a file tool's write there is not.
  it.live(
    "asks the default agent about a shell command that reaches the memory folder, also after an always elsewhere",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          const build = Agent.ID.make("build")
          const base = { sessionID: SessionSchema.ID.make(main), agent: build }
          yield* builtIns
          yield* insertSession({ id: main, directory: l.project, agent: build })
          const access = yield* FileAccess.Service
          const permission = yield* Permission.Service
          const cwd = yield* access.resolve({ path: l.project, kind: "directory" })
          const folder = (command: string) =>
            Effect.gen(function* () {
              const prepared = yield* ShellGuard.prepare({ command, shell: "sh", cwd, env: {}, portable: true, base })
              if (!prepared.external) return { effect: "none", id: undefined }
              return yield* permission.ask({ ...prepared.external, id: Permission.ID.create() })
            }).pipe(
              Effect.provideService(
                PowerShellParse.Service,
                PowerShellParse.Service.of({ parse: () => Effect.succeed({ valid: false, reason: "no-host" }) }),
              ),
            )
          const file = path.join(l.memory, "a.md").replaceAll("\\", "/")
          const rm = yield* folder(`rm ${file}`)
          const cat = yield* folder(`cat ${file}`)
          const other = access.externalRequest(
            [yield* access.resolve({ path: path.join(l.elsewhere, "a.md"), kind: "file" })],
            base,
          )
          const elsewhere = yield* permission.ask({ ...other!, id: Permission.ID.create() })
          yield* permission.reply({ requestID: elsewhere.id, reply: "always" })
          const pending = (yield* permission.list()).map((request) => request.id)
          return {
            rm: rm.effect,
            cat: cat.effect,
            elsewhere: elsewhere.effect,
            stillAsked: pending.includes(rm.id!),
            write: yield* decide(path.join(l.memory, "a.md"), "Edit", build),
          }
        }).pipe(provide(l))
        expect(out).toEqual({ rm: "ask", cat: "ask", elsewhere: "ask", stillAsked: true, write: allowEdit })
      }),
    timeout,
  )

  // Class 4: a call marked as reaching the folder through a link that the project ships is the person's to decide.
  it.live(
    "does not let the carve-out decide a call marked as reached through a link of a project",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l)
          const permission = yield* Permission.Service
          const resource = path.join(l.memory, "a.md").replaceAll("\\", "/")
          const ask = (escaped: boolean) =>
            permission
              .ask({
                id: Permission.ID.create(),
                action: "Edit",
                resources: [resource],
                ...(escaped ? { escaped: [resource] } : {}),
                sessionID: SessionSchema.ID.make(main),
                agent: probe,
              })
              .pipe(Effect.map((answer) => answer.effect))
          return { plain: yield* ask(false), escaped: yield* ask(true) }
        }).pipe(provide(l))
        expect(out).toEqual({ plain: "allow", escaped: "ask" })
      }),
    timeout,
  )
})

// Class 4: the carve-out is written for the name a call gives, so a name is not enough. A link inside the folder can
// lead anywhere, and the real place is what is decided: never an allow for a file behind the link, existing or new.
describe("a link in the memory folder", () => {
  const places = [
    { name: "a folder outside Orbit's folders", target: (l: Layout) => l.elsewhere },
    { name: "the global config folder, which Orbit allows by itself", target: (l: Layout) => l.config },
    { name: "another project's memory folder", target: (l: Layout) => path.join(l.data, "memory", "c".repeat(40)) },
    { name: "a folder that is not there (a dangling link)", target: (l: Layout) => path.join(l.root, "gone") },
  ]
  for (const place of places)
    it.live(
      `does not make a write through a link to ${place.name} prompt-free`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* Effect.promise(async () => {
              if (!place.name.includes("dangling")) await fs.mkdir(place.target(l), { recursive: true })
              await fs.mkdir(l.memory, { recursive: true })
              await fs.symlink(place.target(l), path.join(l.memory, "out"), linkType)
              if (!place.name.includes("dangling")) await fs.writeFile(path.join(place.target(l), "b.md"), "victim")
            })
            yield* seed(l)
            return {
              existing: yield* decide(path.join(l.memory, "out", "b.md")),
              fresh: yield* decide(path.join(l.memory, "out", "new", "c.md")),
              read: yield* decide(path.join(l.memory, "out", "b.md"), "Read"),
              control: yield* decide(path.join(l.memory, "a.md")),
            }
          }).pipe(provide(l))
          expect(out.control).toEqual(allowEdit)
          // The question comes for the folder, before the file: the memory folder's allow does not decide a place that a
          // link leads out to, even one that an allow of Orbit's own for the place it reaches would let through.
          const asked = { effect: "ask", stage: "external_directory" }
          expect({ existing: out.existing, fresh: out.fresh, read: out.read }).toEqual({
            existing: asked,
            fresh: asked,
            read: asked,
          })
        }),
      timeout,
    )

  // Class 3: a data folder reached through a link is one folder with two spellings, and both are the memory folder.
  it.live(
    "writes without a question by either spelling when the data folder is a link",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const linked = path.join(l.root, "data-link")
        yield* Effect.promise(() => fs.symlink(l.data, linked, linkType))
        const out = yield* Effect.gen(function* () {
          yield* seed(l)
          return {
            spelled: yield* decide(path.join(linked, "memory", Project.ID.global, "a.md")),
            real: yield* decide(path.join(l.memory, "b.md")),
          }
        }).pipe(provide(l, { data: linked }))
        expect(out).toEqual({ spelled: allowEdit, real: allowEdit })
      }),
    timeout,
  )

  // Class 3: a deny the person wrote for the real folder decides a write that names it through the linked data folder,
  // since the place the write really reaches is the one the deny names.
  it.live(
    "denies a write by the linked spelling when the person's deny names the real folder",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const linked = path.join(l.root, "data-link")
        yield* Effect.promise(() => fs.symlink(l.data, linked, linkType))
        yield* Effect.promise(() => fs.mkdir(l.memory, { recursive: true }))
        const out = yield* Effect.gen(function* () {
          yield* seed(l, [{ action: "Edit", resource: path.join(l.memory, "private", "*"), effect: "deny" }])
          return {
            spelled: yield* decide(path.join(linked, "memory", Project.ID.global, "private", "a.md")),
            control: yield* decide(path.join(linked, "memory", Project.ID.global, "a.md")),
          }
        }).pipe(provide(l, { data: linked }))
        expect(out.control).toEqual(allowEdit)
        expect(out.spelled.effect).toBe("deny")
      }),
    timeout,
  )

  if (process.platform === "win32")
    it.live(
      "writes without a question when the folder is spelled in other letter case",
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            return yield* decide(path.join(l.memory.toUpperCase(), "a.md"))
          }).pipe(provide(l))
          expect(out).toEqual(allowEdit)
        }),
      timeout,
    )
})

// Classes 3, 4 and 8: `memory.directory` moves the folder, and the carve-out moves with it. Only the person's own
// scopes and the administrator's choose it: a project's value is not read, even in a trusted project, because a
// repository could otherwise point it at `~/.ssh` and write there without a question.
describe("memory.directory", () => {
  for (const scope of ["user", "local", "flag", "managed"] as const)
    it.live(
      `moves the prompt-free folder when the ${scope} scope sets it`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const custom = path.join(l.root, "custom-memory")
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            return {
              custom: yield* decide(path.join(custom, "a.md")),
              default: yield* decide(path.join(l.memory, "a.md")),
            }
          }).pipe(provide(l, {}, [configured(scope, { directory: custom })]))
          expect(out.custom).toEqual(allowEdit)
          // The override replaces the default folder; it does not add to it.
          expect(out.default.effect).not.toBe("allow")
        }),
      timeout,
    )

  for (const scope of ["project", "remote"] as const)
    it.live(
      `does not read memory.directory from the ${scope} scope`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const custom = path.join(l.root, "chosen-by-the-repository")
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            return {
              custom: yield* decide(path.join(custom, "a.md")),
              default: yield* decide(path.join(l.memory, "a.md")),
            }
          }).pipe(provide(l, {}, [configured(scope, { directory: custom })]))
          expect(out.default).toEqual(allowEdit)
          expect(out.custom.effect).not.toBe("allow")
        }),
      timeout,
    )

  it.live(
    "writes without a question by either spelling when the configured folder is a link, and not through a link in it",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const real = path.join(l.root, "real-memory")
        const linked = path.join(l.root, "linked-memory")
        yield* Effect.promise(async () => {
          await fs.mkdir(real, { recursive: true })
          await fs.symlink(real, linked, linkType)
          await fs.symlink(l.elsewhere, path.join(real, "out"), linkType)
        })
        const out = yield* Effect.gen(function* () {
          yield* seed(l)
          return {
            spelled: yield* decide(path.join(linked, "a.md")),
            real: yield* decide(path.join(real, "b.md")),
            through: yield* decide(path.join(linked, "out", "c.md")),
          }
        }).pipe(provide(l, {}, [configured("user", { directory: linked })]))
        expect(out.spelled).toEqual(allowEdit)
        expect(out.real).toEqual(allowEdit)
        expect(out.through.effect).not.toBe("allow")
      }),
    timeout,
  )

  // Class 3: Explore denies everything and then keeps Orbit's own folders, the memory folder among them, so it reads a
  // memory file by either spelling of a configured folder that is a link, still writes none, and asks about another
  // project's memory folder.
  it.live(
    "lets the built-in explore agent read by either spelling of a configured folder that is a link",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const real = path.join(l.root, "real-memory")
        const linked = path.join(l.root, "linked-memory")
        yield* Effect.promise(async () => {
          await fs.mkdir(real, { recursive: true })
          await fs.symlink(real, linked, linkType)
          await fs.writeFile(path.join(real, "a.md"), "note")
        })
        const explore = Agent.ID.make("explore")
        const out = yield* Effect.gen(function* () {
          yield* builtIns
          yield* seed(l, [], [explore, probe])
          return {
            spelled: (yield* decide(path.join(linked, "a.md"), "Read", explore)).effect,
            real: (yield* decide(path.join(real, "a.md"), "Read", explore)).effect,
            write: (yield* decide(path.join(real, "a.md"), "Edit", explore)).effect,
            other: (yield* decide(path.join(l.data, "memory", "c".repeat(40), "a.md"), "Read", explore)).effect,
          }
        }).pipe(provide(l, {}, [configured("user", { directory: linked })]))
        expect(out).toEqual({ spelled: "allow", real: "allow", write: "deny", other: "ask" })
      }),
    timeout,
  )

  // An invalid value is ignored and the default folder stays prompt-free, as the reference does.
  it.live(
    "keeps the default folder for a relative or share value",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        for (const directory of [
          "relative-memory",
          "//orbit-test-host/share/memory",
          "\\\\orbit-test-host\\share\\memory",
        ]) {
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            return yield* decide(path.join(l.memory, "a.md"))
          }).pipe(provide(l, {}, [configured("user", { directory })]))
          expect(out).toEqual(allowEdit)
        }
      }),
    timeout,
  )
})

// Class 8: while a folder is untrusted its config supplies no `memory` at all, since `directory` picks the folder that
// is written without a question; trusting it makes `enabled` count and still not `directory` (above).
describe("memory in an untrusted folder's config", () => {
  it.live("is withheld whole as a permission", () =>
    Effect.gen(function* () {
      const tmp = (yield* tmpdirScoped()).path
      const result = ConfigTrust.sanitize(
        decodeInfo({ memory: { enabled: false, directory: path.join(tmp, "m") }, username: "kept" }),
        {
          roots: [tmp],
          directory: tmp,
        },
      )
      expect(result.info.username).toBe("kept")
      expect(result.info).not.toHaveProperty("memory")
      expect(result.withheld).toEqual(["permissions"])
    }),
  )
})
