// Class 3 and 4: Orbit's own folders reached through a link, end to end through the real Agent layer, FileAccess and
// Permission. Orbit allows each folder by its spelling and by where it really leads, and a deny of the person's for one
// spelling must beat those allows for both.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Global } from "@orbit/util/global"
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
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = Session.ID.make("ses_owncfg")
const agentID = Agent.ID.make("probe")
const linkType = process.platform === "win32" ? "junction" : "dir"

const layout = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const project = path.join(tmp, "project")
  const cfgReal = path.join(tmp, "dotfiles", "orbit")
  const cfgLink = path.join(tmp, "cfglink")
  const dataReal = path.join(tmp, "realdata")
  const dataLink = path.join(tmp, "datalink")
  yield* Effect.promise(async () => {
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(cfgReal, { recursive: true })
    await fs.writeFile(path.join(cfgReal, "AGENTS.md"), "x")
    await fs.symlink(cfgReal, cfgLink, linkType)
    // A result this session saved: the prompt-free read covers the session's own folder only.
    await fs.mkdir(path.join(dataReal, "tool-output", sessionID), { recursive: true })
    await fs.writeFile(path.join(dataReal, "tool-output", sessionID, "out.txt"), "x")
    await fs.symlink(dataReal, dataLink, linkType)
    // Links the repository ships into the real config folder and into its linked spelling.
    await fs.symlink(cfgReal, path.join(project, "cfg"), linkType)
    await fs.symlink(cfgLink, path.join(project, "cfg2"), linkType)
  })
  return { tmp, project, cfgReal, cfgLink, dataReal, dataLink }
})

const provide = (project: string, global: Partial<Global.Interface>, trusted: boolean) =>
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
      ]),
      [
        Global.node.replace(Global.layerWith(global)),
        ...(trusted
          ? []
          : [
              Config.node.replace(Config.testLayer()),
              WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
            ]),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
        ),
      ],
    ),
  )

const prepare = (project: string, extra: Permission.Ruleset) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "owncfg",
        directory: project,
        title: "owncfg",
        version: "test",
        agent: agentID,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(agentID, (agent) => {
        agent.permissions.push(...extra)
      }),
    )
    return (yield* agents.get(agentID))!.permissions
  })

const decide = (file: string) =>
  Effect.gen(function* () {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const target = yield* access.resolve({ path: file })
    const request = access.externalRequest([target], { sessionID, agent: agentID })
    if (request === undefined) return { effect: "inside" }
    return { effect: (yield* permission.ask({ ...request, id: Permission.ID.create() })).effect }
  })

describe("Orbit's own folders reached through a link", () => {
  // Folder x the spelling the rule names x the spelling the call names: every cell is a deny.
  const folders = [
    { name: "config", rel: ["AGENTS.md"], spelled: "cfgLink", real: "cfgReal" },
    { name: "data", rel: ["tool-output", sessionID, "out.txt"], spelled: "dataLink", real: "dataReal" },
  ] as const
  for (const folder of folders)
    for (const rule of ["spelled", "real"] as const)
      for (const call of ["spelled", "real"] as const)
        it.live(
          `denies a ${folder.name} file named by its ${call} path under a deny written for the ${rule} path`,
          () =>
            Effect.gen(function* () {
              const l = yield* layout
              const out = yield* Effect.gen(function* () {
                yield* prepare(l.project, [
                  { action: "external_directory", resource: path.join(l[folder[rule]], "*"), effect: "deny" },
                ])
                return (yield* decide(path.join(l[folder[call]], ...folder.rel))).effect
              }).pipe(provide(l.project, { config: l.cfgLink, data: l.dataLink, tmp: path.join(l.tmp, "t") }, true))
              expect(out).toBe("deny")
            }),
          { timeout: 120_000 },
        )

  it.live(
    "allows the same files by either spelling under the default rules, and asks about a neighbour",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* prepare(l.project, [])
          return [
            (yield* decide(path.join(l.cfgLink, "AGENTS.md"))).effect,
            (yield* decide(path.join(l.cfgReal, "AGENTS.md"))).effect,
            (yield* decide(path.join(l.dataLink, "tool-output", sessionID, "out.txt"))).effect,
            (yield* decide(path.join(l.dataReal, "tool-output", sessionID, "out.txt"))).effect,
            (yield* decide(path.join(l.tmp, "dotfiles", "x.txt"))).effect,
          ]
        }).pipe(provide(l.project, { config: l.cfgLink, data: l.dataLink, tmp: path.join(l.tmp, "t") }, true))
        expect(out).toEqual(["allow", "allow", "allow", "allow", "ask"])
      }),
    { timeout: 120_000 },
  )

  it.live(
    "asks about a repository link into the config folder in an untrusted project",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* prepare(l.project, [])
          return [
            (yield* decide(path.join(l.project, "cfg", "AGENTS.md"))).effect,
            (yield* decide(path.join(l.project, "cfg2", "AGENTS.md"))).effect,
          ]
        }).pipe(provide(l.project, { config: l.cfgLink, data: l.dataLink, tmp: path.join(l.tmp, "t") }, false))
        expect(out).toEqual(["ask", "ask"])
      }),
    { timeout: 120_000 },
  )
})

// The layers that look at Orbit's own folders must start when one of them cannot be resolved: `FSUtil.resolve` dies on a
// link loop, and a die is not a NotFound.
describe("Orbit's own folders that cannot be resolved", () => {
  const rows = [
    { name: "a link loop", config: (tmp: string) => path.join(tmp, "loop-a") },
    { name: "a folder below a link loop", config: (tmp: string) => path.join(tmp, "loop-a", "orbit") },
  ]
  for (const row of rows)
    it.live(
      `the agent and permission layers start with ${row.name} as the config folder`,
      () =>
        Effect.gen(function* () {
          const tmp = (yield* tmpdirScoped()).path
          const project = path.join(tmp, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project, { recursive: true })
            await fs.symlink(path.join(tmp, "loop-b"), path.join(tmp, "loop-a"), linkType)
            await fs.symlink(path.join(tmp, "loop-a"), path.join(tmp, "loop-b"), linkType)
          })
          const config = row.config(tmp)
          const rules = yield* Effect.gen(function* () {
            const agents = yield* Agent.Service
            yield* Permission.Service
            yield* agents.transform((editor) => editor.update(agentID, () => {}))
            return (yield* agents.get(agentID))!.permissions.filter(Agent.isOwnFolder).map((rule) => rule.resource)
          }).pipe(
            Effect.provide(
              Layer.fresh(
                AppNodeBuilder.build(
                  LayerNode.group([
                    Agent.node,
                    Bus.node,
                    Permission.node,
                    Database.node,
                    SessionStore.node,
                    PermissionSaved.node,
                    PluginHooks.node,
                    ManagedPolicy.node,
                    Global.node,
                  ]),
                  [
                    Global.node.replace(
                      Layer.succeed(
                        Global.Service,
                        Global.Service.of(Global.make({ config, tmp: path.join(tmp, "t") })),
                      ),
                    ),
                    // The permission layer reads the memory folder from the config; the config's own loader is not what
                    // this row is about.
                    Config.node.replace(Config.testLayer()),
                    Location.node.replace(
                      Layer.succeed(
                        Location.Service,
                        Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          )
          expect(rules).toContain(path.join(config, "*"))
        }),
      { timeout: 120_000 },
    )
})
