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
import { Agent as AgentSchema } from "@orbit/schema/agent"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
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
            const context = { sessionID, agent: Agent.ID.make("test"), messageID: "msg_leads", id: "call_leads" } as never
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

// The same deny meets a link that sits inside the project and leads out of it, in a trusted project as well as in one that
// is not: Read, Grep, Glob and LSP (authorizeRead) and Edit, Write, Patch and NotebookEdit (authorizeExternal) are asked
// for the folder the link leads to, as the shell is (class 3 and 4). The rows are a link to a folder, a file that is not
// there yet below it, and a link whose target is gone.
describe("an external_directory rule meets the real folder behind a link inside the project", () => {
  const provideWith = (project: string, untrusted: boolean) =>
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
          ...(untrusted ? untrustedProjectNodes : []),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
          ),
        ],
      ),
    )

  const files = [
    ["a link to a folder, a file in it", "keys/id_rsa", "ssh"],
    ["a link to a folder, a file that is not there yet", "keys/authorized_keys", "ssh"],
    ["a link below a folder", "src/nested/id_rsa", "ssh"],
    ["a link whose target is gone", "dangling/new.txt", "gone"],
  ] as const

  for (const untrusted of [false, true])
    for (const managed of [false, true])
      for (const [name, file, folder] of files)
        it.live(
          `${untrusted ? "untrusted" : "trusted"}, ${managed ? "managed" : "configured"} deny: ${name} (${file})`,
          () =>
            Effect.gen(function* () {
              const tmp = (yield* tmpdirScoped()).path
              const project = path.join(tmp, "home", "code", "repo")
              const places = { ssh: path.join(tmp, "home", ".ssh"), gone: path.join(tmp, "home", "gone") }
              yield* Effect.promise(async () => {
                await fs.mkdir(path.join(project, "src"), { recursive: true })
                await fs.mkdir(places.ssh, { recursive: true })
                await fs.mkdir(places.gone, { recursive: true })
                await fs.writeFile(path.join(places.ssh, "id_rsa"), "PRIVATE")
                await fs.symlink(places.ssh, path.join(project, "keys"), "junction")
                await fs.symlink(places.ssh, path.join(project, "src", "nested"), "junction")
                await fs.symlink(places.gone, path.join(project, "dangling"), "junction")
                await fs.rmdir(places.gone)
              })
              const rule = {
                action: "external_directory",
                resource: `${slash(places[folder])}/*`,
                effect: "deny",
              } satisfies Permission.Rule
              const results = yield* Effect.gen(function* () {
                yield* prepare(project, [{ action: "*", resource: "*", effect: "allow" }, ...(managed ? [] : [rule])])
                if (managed) yield* (yield* ManagedPolicy.Service).set("file", { statements: [], rules: [rule] })
                const access = yield* FileAccess.Service
                const permission = yield* Permission.Service
                const context = { sessionID, agent: Agent.ID.make("test"), messageID: "msg_leads", id: "call_leads" } as never
                const outcome = (effect: Effect.Effect<unknown, unknown>) =>
                  effect.pipe(
                    Effect.map(() => "allowed"),
                    Effect.catch((error) =>
                      Effect.succeed(error instanceof Permission.BlockedError ? "blocked" : String(error)),
                    ),
                  )
                const target = yield* access.resolve({ path: file })
                const request = access.externalRequest([target], context)
                return [
                  yield* outcome(access.authorizeRead(file, context)),
                  yield* outcome(access.authorizeExternal([target], context)),
                  request === undefined ? false : yield* permission.denied(request),
                ]
              }).pipe(provideWith(project, untrusted))
              expect(results).toEqual(["blocked", "blocked", true])
            }),
          60_000,
        )

  // Under the built-in defaults the folder is asked about, not allowed, whatever the trust.
  for (const untrusted of [false, true])
    it.live(`${untrusted ? "untrusted" : "trusted"}: under the default rules a read through the link asks about the folder`, () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const project = path.join(tmp, "home", "code", "repo")
        const ssh = path.join(tmp, "home", ".ssh")
        yield* Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.mkdir(ssh, { recursive: true })
          await fs.writeFile(path.join(ssh, "id_rsa"), "PRIVATE")
          await fs.symlink(ssh, path.join(project, "keys"), "junction")
        })
        const decision = yield* Effect.gen(function* () {
          yield* prepare(project, [...AgentSchema.Info.default(Agent.ID.make("test")).permissions])
          const access = yield* FileAccess.Service
          const permission = yield* Permission.Service
          const request = access.externalRequest([yield* access.resolve({ path: "keys/id_rsa" })], {
            sessionID,
            agent: Agent.ID.make("test"),
          })
          return request === undefined ? undefined : yield* permission.ask({ ...request, id: Permission.ID.create() })
        }).pipe(provideWith(project, untrusted))
        expect(decision).toMatchObject({ effect: "ask" })
      }),
    )
})

// A managed allow lifts the built-in `external_directory * ask` for a place it names in any spelling, the link's folder or
// the real place behind it, however the person answered before: with an allow of their own or an "Always" for the link's
// folder, the lead onto the real place is still only the default question (class 8). A lead onto an ask the person wrote
// stays explicit, and a link out of an untrusted project is not lifted at all.
describe("a managed allow for a link's folder and its real place", () => {
  const provideWith = (project: string, untrusted: boolean) =>
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
          ...(untrusted ? untrustedProjectNodes : []),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
          ),
        ],
      ),
    )
  const rows = [
    { name: "no rule of the person's", person: [], grant: false, untrusted: false, effect: "allow" },
    { name: "the person's allow for the link's folder", person: ["links-allow"], grant: false, untrusted: false, effect: "allow" },
    { name: "a saved grant for the link's folder", person: [], grant: true, untrusted: false, effect: "allow" },
    { name: "the person's ask for the real place and a grant", person: ["real-ask"], grant: true, untrusted: false, effect: "ask" },
    { name: "a link out of an untrusted project", person: [], grant: false, untrusted: true, effect: "ask" },
  ] as const

  for (const row of rows)
    it.live(row.name, () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const project = path.join(tmp, "project")
        const shared = path.join(tmp, "shared")
        const links = path.join(tmp, "links")
        yield* Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.mkdir(shared, { recursive: true })
          await fs.mkdir(links, { recursive: true })
          await fs.symlink(shared, path.join(row.untrusted ? project : links, "lnk"), "junction")
        })
        const linksRule = `${slash(links)}/*`
        const person = row.person.map(
          (kind): Permission.Rule =>
            kind === "links-allow"
              ? { action: "external_directory", resource: linksRule, effect: "allow" }
              : { action: "external_directory", resource: `${slash(shared)}/*`, effect: "ask" },
        )
        const decision = yield* Effect.gen(function* () {
          yield* prepare(project, [])
          const agents = yield* Agent.Service
          // A fresh agent has the built-in rules with the default question marked; the person's come after them.
          yield* agents.transform((editor) => {
            editor.remove(Agent.ID.make("test"))
            editor.update(Agent.ID.make("test"), (agent) => {
              agent.permissions = [...agent.permissions, ...person]
            })
          })
          if (row.grant)
            yield* (yield* PermissionSaved.Service).add({
              projectID: Project.ID.global,
              action: "external_directory",
              resources: [linksRule],
            })
          yield* (yield* ManagedPolicy.Service).set("file", {
            statements: [],
            rules: [
              { action: "external_directory", resource: linksRule, effect: "allow" },
              { action: "external_directory", resource: `${slash(shared)}/*`, effect: "allow" },
            ],
          })
          const access = yield* FileAccess.Service
          const file = path.join(row.untrusted ? project : links, "lnk", "x.txt")
          const targets = row.untrusted ? yield* access.escaped([file]) : [yield* access.resolve({ path: file })]
          const request = access.externalRequest(targets, {
            sessionID,
            agent: Agent.ID.make("test"),
          })
          return request === undefined
            ? undefined
            : yield* (yield* Permission.Service).ask({ ...request, id: Permission.ID.create() })
        }).pipe(provideWith(project, row.untrusted))
        expect(decision).toMatchObject({ effect: row.effect })
      }),
      60_000,
    )
})
