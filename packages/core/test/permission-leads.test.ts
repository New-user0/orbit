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
              // The place is the real one, and the folder it is in is asked about, with no mark that would stop Orbit's own
              // allows (that mark is for a link of an untrusted project).
              expect(target.place).not.toBe(target.absolute)
              expect(slash(target.place)).toContain(slash(real))
              expect(target.leads).toBeDefined()
              expect(target.externalDirectory).toBeDefined()
              expect(target.externalDirectory?.escaped).toBeUndefined()
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

// More places for the rows below: a link outside the project, links to project folders and a file, and a folder shared by
// two projects.
const more = Effect.gen(function* () {
  const base = yield* layout
  const tmp = path.dirname(base.project)
  const elsewhere = path.join(tmp, "elsewhere")
  const shared = path.join(tmp, "shared")
  const symlinks = yield* Effect.promise(async () => {
    await fs.mkdir(elsewhere, { recursive: true })
    await fs.mkdir(shared, { recursive: true })
    await fs.mkdir(path.join(base.project, "secrets"), { recursive: true })
    await fs.mkdir(path.join(base.project, "src", "real-gen"), { recursive: true })
    await fs.writeFile(path.join(base.project, "secrets", "key"), "SECRET")
    await fs.writeFile(path.join(base.project, ".env"), "SECRET")
    await fs.symlink(base.ssh, path.join(elsewhere, "k"), "junction")
    await fs.symlink(shared, path.join(base.project, "vendor"), "junction")
    await fs.symlink(path.join(base.project, "secrets"), path.join(base.project, "alias"), "junction")
    await fs.symlink(path.join(base.project, "src", "real-gen"), path.join(base.project, "src", "gen"), "junction")
    // A link to a file needs a right that Windows does not always give; the Linux run has it.
    return await fs
      .symlink(path.join(base.project, ".env"), path.join(base.project, "envlink"), "file")
      .then(() => true)
      .catch(() => false)
  })
  return { ...base, elsewhere, shared, symlinks }
})

// The decision of the permission service for a file tool's request, as the tool sends it.
const decide = (
  project: string,
  rules: Permission.Ruleset,
  layer: "managed" | "configured",
  action: "Read" | "Edit",
  file: string,
) =>
  Effect.gen(function* () {
    yield* prepare(project, layer === "configured" ? rules : [{ action: "*", resource: "*", effect: "allow" }])
    if (layer === "managed") yield* (yield* ManagedPolicy.Service).set("file", { statements: [], rules })
    const target = yield* (yield* FileAccess.Service).resolve({ path: file })
    const permission = yield* Permission.Service
    return (yield* permission.ask({
      id: Permission.ID.create(),
      sessionID,
      action,
      resources: [target.resource],
      ...FileAccess.leadsOf([target]),
    })).effect
  }).pipe(provide(project))

describe("a link outside the project, and rules written relative to the project", () => {
  for (const layer of ["managed", "configured"] as const)
    for (const action of ["Read", "Edit"] as const) {
      it.live(`${layer} ${action} deny of the folder an external link leads to`, () =>
        Effect.gen(function* () {
          const { project, ssh, elsewhere } = yield* more
          const rules = [
            { action: "*", resource: "*", effect: "allow" },
            { action, resource: `${slash(ssh)}/*`, effect: "deny" },
          ] satisfies Permission.Ruleset
          // The control: the folder itself, and the link outside the project that leads to it.
          expect(yield* decide(project, rules, layer, action, path.join(ssh, "id_rsa"))).toBe("deny")
          expect(yield* decide(project, rules, layer, action, path.join(elsewhere, "k", "id_rsa"))).toBe("deny")
          expect(yield* decide(project, rules, layer, action, path.join(elsewhere, "k", "new.txt"))).toBe("deny")
          expect(yield* decide(project, rules, layer, action, path.join(elsewhere, "other.txt"))).toBe("allow")
        }),
      )

      it.live(`${layer} ${action} deny written relative to the project holds through a link inside it`, () =>
        Effect.gen(function* () {
          const { project, symlinks } = yield* more
          const rules = [
            { action: "*", resource: "*", effect: "allow" },
            { action, resource: "secrets/*", effect: "deny" },
            { action, resource: ".env", effect: "deny" },
          ] satisfies Permission.Ruleset
          expect(yield* decide(project, rules, layer, action, "secrets/key")).toBe("deny")
          expect(yield* decide(project, rules, layer, action, "alias/key")).toBe("deny")
          expect(yield* decide(project, rules, layer, action, "src/a.ts")).toBe("allow")
          if (symlinks) expect(yield* decide(project, rules, layer, action, "envlink")).toBe("deny")
        }),
      )
    }

  it.live("an allow written relative to the project still covers a link to another folder of it", () =>
    Effect.gen(function* () {
      const { project } = yield* more
      const rules = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "Edit", resource: "*", effect: "ask" },
        { action: "Edit", resource: "src/*", effect: "allow" },
      ] satisfies Permission.Ruleset
      expect(yield* decide(project, rules, "configured", "Edit", "src/real-gen/x.ts")).toBe("allow")
      expect(yield* decide(project, rules, "configured", "Edit", "src/gen/x.ts")).toBe("allow")
      // The control: a link whose lead is not under `src/` is asked about, since the broad ask is the last rule for it.
      expect(yield* decide(project, rules, "configured", "Edit", "alias/key")).toBe("ask")
    }),
  )

  it.live("a link that leads out of the project under a broad ask is asked about, whatever allow names the link", () =>
    Effect.gen(function* () {
      const { project } = yield* more
      const rules = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "Edit", resource: "*", effect: "ask" },
        { action: "Edit", resource: "vendor/*", effect: "allow" },
      ] satisfies Permission.Ruleset
      // Documented in docs/upgrading.md: the ask is for the folder the link leads to, which `vendor/*` does not name.
      expect(yield* decide(project, rules, "configured", "Edit", "vendor/x.ts")).toBe("ask")
    }),
  )
})

// The session folder reached through a link (a junction or symlink to the project, as `process.cwd()` is when the person
// starts Orbit in one): every lead is then a real path, and rules written for the project must still decide it
// (class 3 and 4).
const linked = Effect.gen(function* () {
  const base = yield* more
  const tmp = path.dirname(base.project)
  const projlink = path.join(tmp, "projlink")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(base.project, "src"), { recursive: true })
    await fs.writeFile(path.join(base.project, "src", "a.ts"), "")
    await fs.symlink(base.project, projlink, "junction")
  })
  return { ...base, projlink }
})

const decideAt = (
  directory: string,
  rules: Permission.Ruleset,
  layer: "managed" | "configured",
  action: "Read" | "Edit",
  file: string,
) =>
  Effect.gen(function* () {
    yield* prepare(directory, layer === "configured" ? rules : [{ action: "*", resource: "*", effect: "allow" }])
    if (layer === "managed") yield* (yield* ManagedPolicy.Service).set("file", { statements: [], rules })
    const target = yield* (yield* FileAccess.Service).resolve({ path: file })
    return (yield* (yield* Permission.Service).ask({
      id: Permission.ID.create(),
      sessionID,
      action,
      resources: [target.resource],
      ...FileAccess.leadsOf([target]),
    })).effect
  }).pipe(provide(directory))

describe("the session folder spelled directly or through a link", () => {
  const forms = ["relative", "absolute as spelled", "absolute through the real path"] as const
  const written = (form: (typeof forms)[number], session: string, real: string, rest: string) =>
    form === "relative" ? rest : slash(path.join(form === "absolute as spelled" ? session : real, rest))

  for (const spelling of ["direct", "link"] as const)
    for (const layer of ["managed", "configured"] as const)
      for (const effect of ["deny", "ask"] as const)
        for (const form of forms)
          it.live(`${layer} ${effect} written ${form}, session ${spelling}: a link to a project folder, a plain file`, () =>
            Effect.gen(function* () {
              const { project, projlink } = yield* linked
              const session = spelling === "direct" ? project : projlink
              const rules = [
                { action: "*", resource: "*", effect: "allow" },
                { action: "Edit", resource: written(form, session, project, "secrets/*"), effect },
              ] satisfies Permission.Ruleset
              for (const file of ["secrets/key", "alias/key"])
                expect([file, yield* decideAt(session, rules, layer, "Edit", file)]).toEqual([file, effect])
              expect(yield* decideAt(session, rules, layer, "Edit", "src/a.ts")).toBe("allow")
            }),
          )

  for (const spelling of ["direct", "link"] as const)
    for (const form of ["relative", "absolute as spelled"] as const)
      it.live(`an allow written ${form} covers an in-project link under a broad ask, session ${spelling}`, () =>
        Effect.gen(function* () {
          const { project, projlink } = yield* linked
          const session = spelling === "direct" ? project : projlink
          const rules = [
            { action: "*", resource: "*", effect: "allow" },
            { action: "Edit", resource: "*", effect: "ask" },
            { action: "Edit", resource: written(form, session, project, "src/*"), effect: "allow" },
          ] satisfies Permission.Ruleset
          for (const file of ["src/a.ts", "src/real-gen/x.ts", "src/gen/x.ts"])
            expect([file, yield* decideAt(session, rules, "configured", "Edit", file)]).toEqual([file, "allow"])
          // The controls: a link whose lead is not under src/, and a link out of the project, still ask.
          expect(yield* decideAt(session, rules, "configured", "Edit", "alias/key")).toBe("ask")
          expect(yield* decideAt(session, rules, "configured", "Edit", "vendor/x.ts")).toBe("ask")
        }),
      )

  it.live("a deny for the folder a link outside the project leads to holds with the session folder linked", () =>
    Effect.gen(function* () {
      const { projlink, ssh } = yield* linked
      const rules = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "Read", resource: `${slash(ssh)}/*`, effect: "deny" },
      ] satisfies Permission.Ruleset
      expect(yield* decideAt(projlink, rules, "configured", "Read", "keys/id_rsa")).toBe("deny")
      expect(yield* decideAt(projlink, rules, "configured", "Read", "src/a.ts")).toBe("allow")
    }),
  )
})

// The Plan agent's rules (`Edit *` denied as a mode rule, then an allow for the plan folder, as `PlanPlugin` pushes them)
// with the home folder, or ~/.orbit, reached through a link.
describe("the Plan agent writes its plan file when the plan folder's path goes through a link", () => {
  for (const [name, linkAt] of [
    ["home linked", "home"],
    ["~/.orbit linked", "orbit"],
    ["no link (control)", "none"],
  ] as const)
    it.live(name, () =>
      Effect.gen(function* () {
        const { project } = yield* linked
        const tmp = path.dirname(project)
        const real = path.join(tmp, `real-${linkAt}`)
        const home = linkAt === "home" ? path.join(tmp, `home-${linkAt}`) : real
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(real, ".orbit", "plan"), { recursive: true })
          if (linkAt === "home") await fs.symlink(real, home, "junction")
          if (linkAt === "orbit") {
            await fs.mkdir(path.join(tmp, "dotfiles", "plan"), { recursive: true })
            await fs.rm(path.join(real, ".orbit"), { recursive: true })
            await fs.symlink(path.join(tmp, "dotfiles"), path.join(real, ".orbit"), "junction")
          }
        })
        const planDir = path.join(home, ".orbit", "plan")
        const rules = [
          { action: "*", resource: "*", effect: "allow" },
          Agent.modeRule({ action: "Edit", resource: "*", effect: "deny" as const }),
          { action: "Edit", resource: slash(path.join(planDir, "*")), effect: "allow" },
        ] satisfies Permission.Ruleset
        expect(yield* decideAt(project, rules, "configured", "Edit", path.join(planDir, "ses.md"))).toBe("allow")
        // Only the plan folder: another file of the home folder stays denied.
        expect(yield* decideAt(project, rules, "configured", "Edit", path.join(home, "other.md"))).toBe("deny")
      }),
    )
})
