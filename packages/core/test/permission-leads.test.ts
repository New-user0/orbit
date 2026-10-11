// A link in a trusted project is followed, but the person's deny and ask rules and the managed ones are written against
// the place a file really is, so they decide the link as they decide the folder it leads to. An allow written for the real
// place never lifts the link (class 3 and 4, task permissions-23).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Global } from "@orbit/util/global"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
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
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = Session.ID.make("ses_leads")

// The project, a folder outside it (`home/.ssh`) and a link in the project to each kind of place. The core tests trust
// every folder, so the project is trusted.
const layout = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const project = path.join(tmp, "project")
  const ssh = path.join(tmp, "home", ".ssh")
  const gone = path.join(tmp, "home", "gone")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(project, "src"), { recursive: true })
    await fs.mkdir(ssh, { recursive: true })
    await fs.mkdir(gone, { recursive: true })
    await fs.writeFile(path.join(ssh, "id_rsa"), "PRIVATE")
    await fs.symlink(ssh, path.join(project, "keys"), "junction")
    await fs.symlink(ssh, path.join(project, "src", "nested"), "junction")
    await fs.symlink(gone, path.join(project, "dangling"), "junction")
    await fs.rmdir(gone)
  })
  return { project, ssh, gone }
})

const provide = (project: string) =>
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
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
        ),
      ],
    ),
  )

const prepare = (project: string, rules: Permission.Ruleset) =>
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
        slug: "leads",
        directory: project,
        title: "leads",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* (yield* Agent.Service).transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })

const slash = (value: string) => value.replaceAll("\\", "/")

describe("a link in a trusted project and the rules written for the place it leads to", () => {
  const paths = [
    ["a junction", "keys/id_rsa"],
    ["a junction below a folder", "src/nested/id_rsa"],
    ["a file that is not there yet below a junction", "keys/new.txt"],
    ["a junction whose target is gone", "dangling/new.txt"],
  ] as const

  for (const layer of ["managed", "configured"] as const)
    for (const action of ["Read", "Edit"] as const)
      for (const [name, file] of paths)
        it.live(`${layer} ${action} deny: ${name} (${file})`, () =>
          Effect.gen(function* () {
            const { project, ssh, gone } = yield* layout
            const real = file.startsWith("dangling") ? gone : ssh
            const rule = { action, resource: `${slash(real)}/*`, effect: "deny" } satisfies Permission.Rule
            yield* Effect.gen(function* () {
              yield* prepare(project, [{ action: "*", resource: "*", effect: "allow" }, ...(layer === "configured" ? [rule] : [])])
              if (layer === "managed") yield* (yield* ManagedPolicy.Service).set("file", { statements: [], rules: [rule] })
              const target = yield* (yield* FileAccess.Service).resolve({ path: file })
              // The place stays the project's own spelling, as for any trusted project.
              expect(target.place).toBe(target.absolute)
              expect(target.leads).toBeDefined()
              const permission = yield* Permission.Service
              const input = {
                id: Permission.ID.create(),
                sessionID,
                action,
                resources: [target.resource],
                ...FileAccess.leadsOf([target]),
              }
              expect(yield* permission.ask(input)).toMatchObject({ effect: "deny" })
              expect(yield* permission.denied(input)).toBe(true)
            }).pipe(provide(project))
          }),
        )

  // The same rule, but for a file in the project that no link touches: a control that the deny is not simply everywhere.
  it.live("a path with no link in it is not denied by a rule for another folder", () =>
    Effect.gen(function* () {
      const { project, ssh } = yield* layout
      yield* Effect.gen(function* () {
        yield* prepare(project, [
          { action: "*", resource: "*", effect: "allow" },
          { action: "Read", resource: `${slash(ssh)}/*`, effect: "deny" },
        ])
        const target = yield* (yield* FileAccess.Service).resolve({ path: "src/a.ts" })
        expect(target.leads).toBeUndefined()
        const permission = yield* Permission.Service
        expect(
          yield* permission.ask({ id: Permission.ID.create(), sessionID, action: "Read", resources: [target.resource] }),
        ).toMatchObject({ effect: "allow" })
      }).pipe(provide(project))
    }),
  )

  it.live("an ask rule for the real place asks, and an allow for it alone never lifts a deny of the link's spelling", () =>
    Effect.gen(function* () {
      const { project, ssh } = yield* layout
      yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        const target = yield* (yield* FileAccess.Service).resolve({ path: "keys/id_rsa" })
        const input = {
          id: Permission.ID.create(),
          sessionID,
          action: "Read",
          resources: [target.resource],
          ...FileAccess.leadsOf([target]),
        }
        yield* prepare(project, [
          { action: "*", resource: "*", effect: "allow" },
          { action: "Read", resource: `${slash(ssh)}/*`, effect: "ask" },
        ])
        expect(yield* permission.ask(input)).toMatchObject({ effect: "ask" })
        yield* prepare(project, [
          { action: "*", resource: "*", effect: "allow" },
          { action: "Read", resource: "keys/*", effect: "deny" },
          { action: "Read", resource: `${slash(ssh)}/*`, effect: "allow" },
        ])
        expect(yield* permission.ask({ ...input, id: Permission.ID.create() })).toMatchObject({ effect: "deny" })
      }).pipe(provide(project))
    }),
  )

  it.live("authorizeRead, which Read, Grep and LSP use, is blocked by a deny on the real place", () =>
    Effect.gen(function* () {
      const { project, ssh } = yield* layout
      yield* Effect.gen(function* () {
        yield* prepare(project, [
          { action: "*", resource: "*", effect: "allow" },
          { action: "Read", resource: `${slash(ssh)}/*`, effect: "deny" },
        ])
        const context = { sessionID, agent: Agent.ID.make("test"), messageID: "msg_leads", id: "call_leads" }
        const failure = yield* (yield* FileAccess.Service)
          .authorizeRead("keys/id_rsa", context as never)
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(Permission.BlockedError)
      }).pipe(provide(project))
    }),
  )

  // Every tool that writes passes the real places of its targets with its request, so none can be the one that misses.
  it.live("each tool that edits files names the real places of its targets in its request", () =>
    Effect.promise(async () => {
      for (const tool of ["edit", "write", "patch", "notebook-edit"]) {
        const source = await Bun.file(path.join(import.meta.dir, "..", "src", "tool", "plugin", `${tool}.ts`)).text()
        expect([tool, source.includes("FileAccess.leadsOf(")]).toEqual([tool, true])
      }
    }),
  )
})
