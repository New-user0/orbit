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

// A deny written for a folder outside the project (`external_directory <folder>/*`) also meets that folder when a file
// tool reaches it by another spelling: a link outside the project, a Windows system junction, or /proc/self/root. The
// doors are the ones every file tool uses: authorizeRead (Read, Grep, Glob, LSP), authorizeExternal (Edit, Write, Patch,
// NotebookEdit) and the Permission.denied check that runs before anything is asked. The real stack decides: Permission,
// Agent, ManagedPolicy and FileAccess, with the rule once in the person's config and once in managed settings.

const sessionID = Session.ID.make("ses_external_leads")
const slash = (value: string) => value.replaceAll("\\", "/")

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
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
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
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })

describe("external_directory rules meet the real folder behind another spelling", () => {
  for (const managed of [false, true])
    it.live(
      `a deny for a folder blocks every spelling that leads there (${managed ? "managed" : "configured"})`,
      () =>
        Effect.gen(function* () {
          const tmp = (yield* tmpdirScoped()).path
          const project = path.join(tmp, "project")
          const ssh = path.join(tmp, "home", ".ssh")
          const elsewhere = path.join(tmp, "elsewhere")
          const open = path.join(tmp, "open")
          yield* Effect.promise(async () => {
            await Promise.all([project, ssh, elsewhere, open].map((folder) => fs.mkdir(folder, { recursive: true })))
            await fs.writeFile(path.join(ssh, "id_rsa"), "PRIVATE")
            await fs.writeFile(path.join(open, "note"), "fine")
            await fs.symlink(ssh, path.join(elsewhere, "k"), "junction")
            await fs.symlink(open, path.join(elsewhere, "o"), "junction")
          })
          // Windows keeps old names for a user's folders as system junctions: `Local Settings` leads to `AppData\Local`.
          const legacy = ssh.replace(/^(.*?\\Users\\[^\\]+)\\AppData\\Local\\/i, "$1\\Local Settings\\")
          const spellings = [
            ["plain path", path.join(ssh, "id_rsa")],
            ["link outside the project", path.join(elsewhere, "k", "id_rsa")],
            ...(legacy === ssh ? [] : [["system junction", path.join(legacy, "id_rsa")] as const]),
            ...(process.platform === "linux"
              ? [
                  ["/proc/self/root", path.join("/proc/self/root", ssh, "id_rsa")] as const,
                  ["/proc/self/cwd/..", path.join("/proc/self/cwd", path.relative(process.cwd(), ssh), "id_rsa")] as const,
                ]
              : []),
          ]
          const rule = {
            action: "external_directory",
            resource: `${slash(ssh)}/*`,
            effect: "deny",
          } satisfies Permission.Rule
          const results = yield* Effect.gen(function* () {
            yield* prepare(project, [{ action: "*", resource: "*", effect: "allow" }, ...(managed ? [] : [rule])])
            if (managed) yield* (yield* ManagedPolicy.Service).set("file", { statements: [], rules: [rule] })
            const access = yield* FileAccess.Service
            const permission = yield* Permission.Service
            const context = { sessionID, agent: Agent.ID.make("test"), messageID: "msg_leads", id: "call_leads" }
            const outcome = (effect: Effect.Effect<unknown, unknown>) =>
              effect.pipe(
                Effect.map(() => "allowed"),
                Effect.catch((error) => Effect.succeed(error instanceof Permission.BlockedError ? "blocked" : String(error))),
              )
            return yield* Effect.forEach([...spellings, ["trusted control", path.join(elsewhere, "o", "note")] as const], ([name, file]) =>
              Effect.gen(function* () {
                const target = yield* access.resolve({ path: file })
                const request = access.externalRequest([target], context)
                return {
                  name,
                  read: yield* outcome(access.authorizeRead(file, context)),
                  external: yield* outcome(access.authorizeExternal([target], context)),
                  denied: request === undefined ? false : yield* permission.denied(request),
                }
              }),
            )
          }).pipe(provide(project))
          expect(
            results.map((item) => [item.name, item.read, item.external, item.denied]),
          ).toEqual([
            ...spellings.map(([name]) => [name, "blocked", "blocked", true]),
            ["trusted control", "allowed", "allowed", false],
          ])
        }),
      60_000,
    )
})
