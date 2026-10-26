// context-memory-10, classes 1, 3, 4 and 8: every agent's memory folder, in all three scopes, is prompt-free for the
// file tools, as the reference's read and write carve-outs make it: user `<data>/memory/agents`, project
// `<dir>/.orbit/agent-memory` and local `<dir>/.orbit/agent-memory-local`. No ask of the person's, no managed ask, no
// default question for a place outside the project and no mode's deny reaches them; a deny still decides. The allow
// decides only a call whose real place is in a real root, and the two roots in the repository count only once the
// project is trusted and while each really is that folder, because a clone chooses what they are. A shell command is
// not covered. Every row that expects a question also checks an agent memory file that is allowed in the same run, so
// no row passes because nothing is prompt-free.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema, type Types } from "effect"
import { Document, Info, type Entry } from "@orbit/schema/config"
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
import { AgentPlugin } from "@orbit/core/plugin/agent"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionStore } from "@orbit/core/session/store"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { location } from "./fixture/location"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { insertSession } from "./lib/session-row"
import { agentHost, host } from "./plugin/host"

const probe = Agent.ID.make("probe")
const linkType = process.platform === "win32" ? "junction" : "dir"
const main = "ses_agent_memory_main"
const timeout = { timeout: 120_000 }
const decodeInfo = Schema.decodeUnknownSync(Info)
const scopes = ["user", "project", "local"] as const
type Scope = (typeof scopes)[number]

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const folders = {
    project: path.join(root, "project"),
    outside: path.join(root, "outside"),
    tmp: path.join(root, "tmp"),
    data: path.join(root, "data"),
    config: path.join(root, "config"),
  }
  yield* Effect.promise(() =>
    Promise.all(Object.values(folders).map((folder) => fs.mkdir(folder, { recursive: true }))),
  )
  return {
    root,
    ...folders,
    roots: {
      user: path.join(folders.data, "memory", "agents"),
      project: path.join(folders.project, ".orbit", "agent-memory"),
      local: path.join(folders.project, ".orbit", "agent-memory-local"),
    } satisfies Record<Scope, string>,
  }
})
type Layout = Effect.Success<typeof layout>

const configured = (memory: Record<string, unknown>) =>
  new Document({
    type: "document",
    scope: "user",
    path: AbsolutePath.make(path.resolve("/config/user/orbit.json")),
    info: decodeInfo({ memory }),
  })

const provide = (
  l: Layout,
  options: { readonly entries?: Entry[]; readonly untrusted?: boolean; readonly data?: string } = {},
) =>
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
        Global.node.replace(Global.layerWith({ tmp: l.tmp, data: options.data ?? l.data, config: l.config })),
        Config.node.replace(Config.testLayer(options.entries ?? [])),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(l.project) }))),
        ),
        ...(options.untrusted ? [WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false }))] : []),
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
const decide = (file: string, action: "Edit" | "Read" = "Edit", agent: Agent.ID = probe) =>
  Effect.gen(function* () {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const base = { sessionID: SessionSchema.ID.make(main), agent }
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
const askRules: Permission.Ruleset = [
  { action: "Edit", resource: "*", effect: "ask" },
  { action: "Read", resource: "*", effect: "ask" },
  { action: "external_directory", resource: "*", effect: "ask" },
]
const modeDeny = () => [Agent.modeRule({ action: "Edit", resource: "*", effect: "deny" as const })]

// Adds the built-in agents. The plugin edits the agent itself, as the server's plugin host lets it, so the marks of
// Orbit's own rules stay on the rules it copies.
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

// A root of the repository that is a link: out of the project, onto `src`, to a folder that is not there, or in a loop.
const rootLinks = ["out", "src", "dangling", "loop"] as const
const linkRoot = (l: Layout, scope: "project" | "local", link: (typeof rootLinks)[number]) =>
  Effect.promise(async () => {
    const root = l.roots[scope]
    const target = {
      out: path.join(l.outside, "notes"),
      src: path.join(l.project, "src"),
      dangling: path.join(l.outside, "missing"),
      loop: path.join(path.dirname(root), "loop"),
    }[link]
    await fs.mkdir(path.dirname(root), { recursive: true })
    if (link === "out" || link === "src") await fs.mkdir(target, { recursive: true })
    await fs.symlink(target, root, linkType)
    if (link === "loop") await fs.symlink(root, target, linkType)
  })

describe("agent memory folders", () => {
  // Class 8 and decision 5: the session's own agent and any other, in every scope, write and read without a question
  // under the person's ask rules for edits, reads and folders. A project file still asks.
  it.live(
    "writes and reads every agent's memory in all three scopes without a question under the person's ask rules",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          const rows = yield* Effect.forEach([...scopes], (scope) =>
            Effect.forEach(["probe", "other", "review/deep"], (id) =>
              Effect.gen(function* () {
                const file = path.join(l.roots[scope], ...id.split("/"), "a.md")
                return {
                  scope,
                  id,
                  edit: (yield* decide(file, "Edit")).effect,
                  // Write, Patch and NotebookEdit ask as Edit does; Write makes the folders above a new file.
                  write: (yield* decide(path.join(path.dirname(file), "topics", "new.md"))).effect,
                  read: (yield* decide(file, "Read")).effect,
                  index: (yield* decide(path.join(l.roots[scope], id, "MEMORY.md"), "Read")).effect,
                }
              }),
            ),
          )
          return { rows: rows.flat(), project: yield* decide(path.join(l.project, "a.md")) }
        }).pipe(provide(l))
        for (const row of out.rows)
          expect(row).toEqual({
            scope: row.scope,
            id: row.id,
            edit: "allow",
            write: "allow",
            read: "allow",
            index: "allow",
          })
        expect(out.project).toEqual({ effect: "ask", stage: "Edit" })
      }),
    timeout,
  )

  // Class 4: the spellings the file tools accept for one agent memory file are each the same place and prompt-free,
  // the data folder reached through a link included.
  it.live(
    "writes an agent memory file by every spelling without a question",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const spellings = [
          ".orbit/agent-memory/probe/a.md",
          ".orbit/agent-memory-local/probe/a.md",
          "./.orbit/x/../agent-memory/probe/a.md",
          path.join(l.roots.project, "probe", "a.md"),
          path.join(l.roots.local, "probe", "a.md"),
          path.join(l.roots.user, "probe", "a.md"),
          `${l.roots.user}${path.sep}x${path.sep}..${path.sep}probe${path.sep}a.md`,
          ...(process.platform === "win32"
            ? [
                ".ORBIT\\AGENT-MEMORY\\probe\\a.md",
                path.join(l.roots.project, "probe", "a.md").replaceAll("\\", "/"),
                path.join(l.roots.user, "probe", "a.md").replaceAll("\\", "/"),
                path.join(l.roots.user, "probe", "a.md").toUpperCase(),
              ]
            : []),
        ]
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          return yield* Effect.forEach(spellings, (file) =>
            decide(file).pipe(Effect.map((answer) => ({ file, ...answer }))),
          )
        }).pipe(provide(l))
        expect(out).toEqual(spellings.map((file) => ({ file, ...allowEdit })))
        // The data folder reached through a link: the user root is spelled through the link and reached by either path.
        const linkedData = path.join(l.root, "linked-data")
        yield* Effect.promise(() => fs.symlink(l.data, linkedData, linkType))
        const linked = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          return {
            spelled: yield* decide(path.join(linkedData, "memory", "agents", "probe", "a.md")),
            real: yield* decide(path.join(l.roots.user, "probe", "b.md")),
          }
        }).pipe(provide(l, { data: linkedData }))
        expect(linked).toEqual({ spelled: allowEdit, real: allowEdit })
      }),
    timeout,
  )

  // Class 4: names that only start like a root, the folders above the roots and the snapshot folder are not agent
  // memory. A file inside a root is the control.
  it.live(
    "asks about places beside the agent memory roots",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          return {
            orbit: (yield* decide(".orbit/a.md")).effect,
            dashed: (yield* decide(".orbit/agent-memory-x/probe/a.md")).effect,
            joined: (yield* decide(".orbit/agent-memoryx/probe/a.md")).effect,
            snapshots: (yield* decide(".orbit/agent-memory-snapshots/probe/a.md")).effect,
            above: (yield* decide(".orbit/agent-memory/../a.md")).effect,
            userSibling: (yield* decide(path.join(l.data, "memory", "agentsx", "a.md"))).effect,
            memory: (yield* decide(path.join(l.data, "memory", "a.md"))).effect,
            control: yield* decide(".orbit/agent-memory/probe/a.md"),
            userControl: yield* decide(path.join(l.roots.user, "probe", "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({
          orbit: "ask",
          dashed: "ask",
          joined: "ask",
          snapshots: "ask",
          above: "ask",
          userSibling: "ask",
          memory: "ask",
          control: allowEdit,
          userControl: allowEdit,
        })
      }),
    timeout,
  )

  // A mode is not a rule of the person's: as for the private folder, Plan's deny of every edit does not stop an agent
  // memory write, while it still stops a project file. `Permission.denied` answers the same way.
  it.live(
    "writes agent memory under a mode's deny of every edit, and the mode still denies a project file",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, modeDeny())
          const permission = yield* Permission.Service
          const denied = (file: string) =>
            permission.denied({
              id: Permission.ID.create(),
              action: "Edit",
              resources: [file],
              sessionID: SessionSchema.ID.make(main),
              agent: probe,
            })
          return {
            memory: yield* Effect.forEach([...scopes], (scope) => decide(path.join(l.roots[scope], "probe", "a.md"))),
            project: yield* decide(path.join(l.project, "a.md")),
            memoryDenied: yield* denied(path.join(l.roots.project, "probe", "a.md")),
            projectDenied: yield* denied(path.join(l.project, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({
          memory: scopes.map(() => allowEdit),
          project: { effect: "deny", stage: "Edit" },
          memoryDenied: false,
          projectDenied: true,
        })
      }),
    timeout,
  )

  // Classes 3 and 8: a deny wins over the carve-out by either spelling of a root that is reached through a link: the deny
  // names the data folder through the link and the call the real path, or the other way round. A sibling is allowed.
  it.live(
    "denies an agent memory file under the person's deny, by either spelling",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const linkedData = path.join(l.root, "linked-data")
        yield* Effect.promise(() => fs.symlink(l.data, linkedData, linkType))
        const linkedRoot = path.join(linkedData, "memory", "agents")
        const out = yield* Effect.gen(function* () {
          yield* seed(l, [
            { action: "Edit", resource: path.join(linkedRoot, "probe", "secret.md"), effect: "deny" },
            { action: "Edit", resource: path.join(l.roots.user, "probe", "private.md"), effect: "deny" },
            { action: "Read", resource: ".orbit/agent-memory/probe/hidden.md", effect: "deny" },
            ...askRules,
          ])
          return {
            linkedByReal: (yield* decide(path.join(l.roots.user, "probe", "secret.md"))).effect,
            linkedBySpelled: (yield* decide(path.join(linkedRoot, "probe", "secret.md"))).effect,
            realBySpelled: (yield* decide(path.join(linkedRoot, "probe", "private.md"))).effect,
            relative: (yield* decide(path.join(l.roots.project, "probe", "hidden.md"), "Read")).effect,
            control: yield* decide(path.join(linkedRoot, "probe", "open.md")),
            realControl: yield* decide(path.join(l.roots.user, "probe", "open.md")),
          }
        }).pipe(provide(l, { data: linkedData }))
        expect(out).toEqual({
          linkedByReal: "deny",
          linkedBySpelled: "deny",
          realBySpelled: "deny",
          relative: "deny",
          control: allowEdit,
          realControl: allowEdit,
        })
      }),
    timeout,
  )

  // Class 8: a managed ask does not reach an agent memory folder, as no other ask does, while a managed deny for one of
  // its files decides it. A project file still meets the managed ask.
  it.live(
    "writes agent memory under a managed ask, and a managed deny still decides",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l)
          const policy = yield* ManagedPolicy.Service
          yield* policy.set("file", {
            statements: [],
            rules: [
              { action: "Edit", resource: "*", effect: "ask" },
              { action: "Read", resource: "*", effect: "ask" },
              { action: "external_directory", resource: "*", effect: "ask" },
              { action: "Edit", resource: path.join(l.roots.user, "probe", "secret.md"), effect: "deny" },
            ],
          })
          return {
            write: yield* Effect.forEach([...scopes], (scope) => decide(path.join(l.roots[scope], "probe", "a.md"))),
            read: (yield* decide(path.join(l.roots.user, "probe", "a.md"), "Read")).effect,
            denied: (yield* decide(path.join(l.roots.user, "probe", "secret.md"))).effect,
            project: yield* decide(path.join(l.project, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({
          write: scopes.map(() => allowEdit),
          read: "allow",
          denied: "deny",
          project: { effect: "ask", stage: "Edit" },
        })
      }),
    timeout,
  )

  // Class 8: a call marked as reaching the folder through a link that the project ships is the person's to decide.
  it.live(
    "does not let the carve-out decide a call marked as reached through a link of a project",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l)
          const permission = yield* Permission.Service
          const ask = (resource: string, escaped: boolean) =>
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
          return yield* Effect.forEach([...scopes], (scope) =>
            Effect.gen(function* () {
              const resource = path.join(l.roots[scope], "probe", "a.md").replaceAll("\\", "/")
              return { scope, plain: yield* ask(resource, false), escaped: yield* ask(resource, true) }
            }),
          )
        }).pipe(provide(l))
        expect(out).toEqual(scopes.map((scope) => ({ scope, plain: "allow", escaped: "ask" })))
      }),
    timeout,
  )

  // Classes 3 and 4: a link inside an agent's folder that leads out of it is decided by where it leads, never by the
  // carve-out: a folder link with a new and an existing file, and a file link. The question the person gets names the
  // place the server resolved. A plain file in the same folder is the control.
  it.live(
    "asks about a link inside an agent memory folder that leads out",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const folder = path.join(l.roots.project, "probe")
        const userFolder = path.join(l.roots.user, "probe")
        yield* Effect.promise(async () => {
          await fs.mkdir(folder, { recursive: true })
          await fs.mkdir(userFolder, { recursive: true })
          await fs.writeFile(path.join(l.outside, "existing.md"), "outside")
          await fs.symlink(l.outside, path.join(folder, "out"), linkType)
          await fs.symlink(l.outside, path.join(userFolder, "out"), linkType)
          if (canLinkFile) await fs.symlink(path.join(l.outside, "existing.md"), path.join(folder, "file.md"))
        })
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          const access = yield* FileAccess.Service
          const permission = yield* Permission.Service
          const pendingFor = (file: string) =>
            Effect.gen(function* () {
              const target = yield* access.resolve({ path: file, kind: "file" })
              const answer = yield* permission.ask({
                id: Permission.ID.create(),
                action: "Edit",
                resources: [target.resource],
                save: ["*"],
                ...FileAccess.leadsOf([target]),
                metadata: { paths: [target.place] },
                sessionID: SessionSchema.ID.make(main),
                agent: probe,
              })
              const request = (yield* permission.list()).find((item) => item.id === answer.id)
              return { effect: answer.effect, resources: request?.resources, real: FileAccess.realPlace(target) }
            })
          return {
            newFile: (yield* decide(path.join(folder, "out", "new.md"))).effect,
            existing: (yield* decide(path.join(folder, "out", "existing.md"))).effect,
            read: (yield* decide(path.join(folder, "out", "existing.md"), "Read")).effect,
            user: (yield* decide(path.join(userFolder, "out", "new.md"))).effect,
            fileLink: canLinkFile ? (yield* decide(path.join(folder, "file.md"))).effect : "ask",
            request: yield* pendingFor(path.join(folder, "out", "existing.md")),
            control: yield* decide(path.join(folder, "a.md")),
          }
        }).pipe(provide(l))
        const outside = yield* Effect.promise(() => fs.realpath(l.outside))
        expect({
          newFile: out.newFile,
          existing: out.existing,
          read: out.read,
          user: out.user,
          fileLink: out.fileLink,
        }).toEqual({ newFile: "ask", existing: "ask", read: "ask", user: "ask", fileLink: "ask" })
        expect(out.request.effect).toBe("ask")
        expect(out.request.resources).toHaveLength(1)
        expect(FSUtil.contains(outside, out.request.real)).toBe(true)
        expect(out.control).toEqual(allowEdit)
      }),
    timeout,
  )

  // Classes 4 and 8: the carve-out drops every ask and every mode's deny for what is in a root, so a clone that ships
  // `.orbit/agent-memory` or `.orbit/agent-memory-local` as a link out, onto `src`, to nothing or in a loop would carry
  // it over other files. That scope is then off: the project's files are asked about under the person's ask rules and
  // denied under a mode's deny, and nothing through the link is prompt-free. The user root stays prompt-free as the
  // control, and a plain layout is the control for the roots.
  it.live(
    "asks about the project's files when an agent memory root is a link",
    () =>
      Effect.gen(function* () {
        const run = (l: Layout, scope: "project" | "local", rules: Permission.Ruleset) =>
          Effect.gen(function* () {
            yield* seed(l, rules)
            return {
              memory: (yield* decide(path.join(l.roots[scope], "probe", "a.md"))).effect,
              source: (yield* decide(path.join(l.project, "src", "a.ts"))).effect,
              hook: (yield* decide(path.join(l.project, ".git", "hooks", "pre-commit"))).effect,
              user: (yield* decide(path.join(l.roots.user, "probe", "a.md"))).effect,
            }
          }).pipe(provide(l))
        const out = yield* Effect.forEach(
          (["project", "local"] as const).flatMap((scope) => rootLinks.map((link) => ({ scope, link }))),
          (row) =>
            Effect.gen(function* () {
              const ask = yield* layout
              yield* linkRoot(ask, row.scope, row.link)
              const deny = yield* layout
              yield* linkRoot(deny, row.scope, row.link)
              return {
                ...row,
                ask: yield* run(ask, row.scope, askRules),
                deny: yield* run(deny, row.scope, modeDeny()),
              }
            }),
        )
        for (const row of out) {
          const name = `${row.scope} ${row.link}`
          // A file through a link that leads nowhere may be refused before any question; it is never allowed.
          expect({
            name,
            memory: row.ask.memory === "allow",
            source: row.ask.source,
            hook: row.ask.hook,
            user: row.ask.user,
          }).toEqual({ name, memory: false, source: "ask", hook: "ask", user: "allow" })
          expect({
            name,
            memory: row.deny.memory === "allow",
            source: row.deny.source,
            hook: row.deny.hook,
            user: row.deny.user,
          }).toEqual({ name, memory: false, source: "deny", hook: "deny", user: "allow" })
        }
        const plain = {
          ask: yield* run(yield* layout, "project", askRules),
          deny: yield* run(yield* layout, "local", modeDeny()),
        }
        expect(plain.ask).toEqual({ memory: "allow", source: "ask", hook: "ask", user: "allow" })
        expect(plain.deny).toEqual({ memory: "allow", source: "deny", hook: "deny", user: "allow" })
      }),
    timeout,
  )

  // Class 1: nothing of the repository's roots counts before the project is trusted, whatever the agent. The user root is
  // the person's own and stays prompt-free; the trusted run is the control.
  it.live(
    "asks about the project and local roots of a project that is not trusted",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const run = (untrusted: boolean) =>
          Effect.gen(function* () {
            yield* seed(l, askRules)
            return {
              project: (yield* decide(path.join(l.roots.project, "probe", "a.md"))).effect,
              local: (yield* decide(path.join(l.roots.local, "probe", "a.md"))).effect,
              user: (yield* decide(path.join(l.roots.user, "probe", "a.md"))).effect,
            }
          }).pipe(provide(l, { untrusted }))
        expect({ untrusted: yield* run(true), trusted: yield* run(false) }).toEqual({
          untrusted: { project: "ask", local: "ask", user: "allow" },
          trusted: { project: "allow", local: "allow", user: "allow" },
        })
      }),
    timeout,
  )

  // Class 8: the carve-out is for the file tools. A shell command that names an agent's folder is decided by the shell's
  // own rules, and the folder question a command asks is not covered either.
  it.live(
    "asks about a shell command in an agent memory folder",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l)
          const permission = yield* Permission.Service
          const ask = (input: { action: string; resource: string; shell?: boolean }) =>
            permission
              .ask({
                id: Permission.ID.create(),
                action: input.action,
                resources: [input.resource],
                ...(input.shell ? { shell: true } : {}),
                sessionID: SessionSchema.ID.make(main),
                agent: probe,
              })
              .pipe(Effect.map((answer) => answer.effect))
          const folder = path.join(l.roots.user, "probe")
          return {
            shell: yield* ask({ action: "Bash", resource: `rm ${path.join(folder, "a.md")}` }),
            script: yield* ask({ action: "Bash", resource: path.join(l.roots.project, "probe", "run.sh") }),
            folder: yield* ask({ action: "external_directory", resource: path.join(folder, "*"), shell: true }),
            control: yield* decide(path.join(folder, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({ shell: "ask", script: "ask", folder: "ask", control: allowEdit })
      }),
    timeout,
  )

  // Class 8: a scope does not undo what an agent may do. Explore tuned with `memory: user` still has its deny of every
  // edit, so it reads its folder and writes nothing there; the probe agent writing the same file is the control.
  it.live(
    "a read-only agent cannot write its agent memory",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const explore = Agent.ID.make("explore")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(l.roots.user, "explore"), { recursive: true })
          await fs.writeFile(path.join(l.roots.user, "explore", "a.md"), "note")
        })
        const out = yield* Effect.gen(function* () {
          yield* builtIns
          const agents = yield* Agent.Service
          yield* agents.transform((editor) =>
            editor.update(explore, (agent) => {
              agent.memory = "user"
            }),
          )
          yield* seed(l, [], [explore, probe])
          const file = path.join(l.roots.user, "explore", "a.md")
          return {
            write: (yield* decide(file, "Edit", explore)).effect,
            read: (yield* decide(file, "Read", explore)).effect,
            control: (yield* decide(file, "Edit", probe)).effect,
          }
        }).pipe(provide(l))
        expect(out).toEqual({ write: "deny", read: "allow", control: "allow" })
      }),
    timeout,
  )

  // The reference's carve-out does not ask whether memory is on, and neither does Orbit's: while memory is off an agent
  // memory file stays prompt-free (nothing tells the model about it then). The run with memory on is the control.
  it.live(
    "keeps agent memory prompt-free while memory is off",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const run = (entries: Entry[]) =>
          Effect.gen(function* () {
            yield* seed(l, askRules)
            return yield* Effect.forEach([...scopes], (scope) => decide(path.join(l.roots[scope], "probe", "a.md")))
          }).pipe(provide(l, { entries }))
        expect({ off: yield* run([configured({ enabled: false })]), on: yield* run([]) }).toEqual({
          off: scopes.map(() => allowEdit),
          on: scopes.map(() => allowEdit),
        })
      }),
    timeout,
  )
})
