// Class 4, 5 and 8: the allow that every agent has for the scratchpad of the session that asks, end to end through the
// real Agent layer, FileAccess and Permission. A call that no rule speaks to asks here, because the agent's allow of
// everything is taken out, so the scratchpad allow is what decides. The file tools ask `external_directory` for the
// folder first and then `Edit` for the file, so a row reports the answer of the first one that does not allow, and where.
import { describe, expect, test } from "bun:test"
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
import { AgentPlugin } from "@orbit/core/plugin/agent"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"
import { SessionStore } from "@orbit/core/session/store"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { insertSession } from "./lib/session-row"
import { agentHost, host } from "./plugin/host"

const probe = Agent.ID.make("probe")
const linkType = process.platform === "win32" ? "junction" : "dir"

// A root session, the session of another root, a subagent of the first, a fork of it, a subagent of the subagent and a
// fork of the subagent. Each names the scratchpad of the session its lineage goes back to (`SessionAffinity`): the
// immediate parent, else the fork source, else itself.
const ids = {
  main: "ses_scratch_main",
  other: "ses_scratch_other",
  child: "ses_scratch_child",
  fork: "ses_scratch_fork",
  grandchild: "ses_scratch_grandchild",
  forkOfChild: "ses_scratch_forkchild",
} as const

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
    Promise.all([folders.project, folders.elsewhere].map((folder) => fs.mkdir(folder, { recursive: true }))),
  )
  return { root, ...folders, scratch: (key: string) => path.join(folders.tmp, "sessions", key) }
})
type Layout = Effect.Success<typeof layout>

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

// The agent without its allow of everything, so that what no rule speaks to is the fallthrough ask.
const withoutAllowAll = (agents: Agent.Interface, id: Agent.ID, extra: Permission.Ruleset = []) =>
  agents.transform((editor) =>
    editor.update(id, (agent) => {
      agent.permissions = agent.permissions.filter(
        (rule) => !(rule.action === "*" && rule.resource === "*" && rule.effect === "allow"),
      )
      agent.permissions.push(...extra)
    }),
  )

const seed = (l: Layout, extra: Permission.Ruleset = []) =>
  Effect.gen(function* () {
    yield* insertSession({ id: ids.main, directory: l.project, agent: probe })
    yield* insertSession({ id: ids.other, directory: l.project, agent: probe })
    yield* insertSession({ id: ids.child, directory: l.project, parentID: ids.main, agent: probe })
    yield* insertSession({ id: ids.fork, directory: l.project, fork: ids.main, agent: probe })
    yield* insertSession({ id: ids.grandchild, directory: l.project, parentID: ids.child, agent: probe })
    yield* insertSession({ id: ids.forkOfChild, directory: l.project, fork: ids.child, agent: probe })
    yield* withoutAllowAll(yield* Agent.Service, probe, extra)
  })

// What the file tools do, in their order: resolve the path, ask for the folder, and then for the file. A path that the
// tools refuse before anything is asked, such as a name the system cannot hold, is reported as `refused`.
const decide = (sessionID: string, file: string, agent: Agent.ID = probe) =>
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
    const edit = yield* permission.ask({
      id: Permission.ID.create(),
      action: "Edit",
      resources: [target.resource],
      save: ["*"],
      ...FileAccess.leadsOf([target]),
      metadata: { paths: [target.place] },
      ...base,
    })
    return { effect: edit.effect, stage: "Edit" }
  })

const timeout = { timeout: 120_000 }

describe("the allow for the scratchpad of the session that asks", () => {
  // Each row is a session, a file and the answer. A call into the folder of the lineage is allowed, and a call into any
  // other folder of the temporary folder asks, so the allow is the session's own and no wider.
  const rows: ReadonlyArray<{
    readonly name: string
    readonly session: string
    readonly file: (l: Layout) => string
    readonly effect: "allow" | "ask"
    readonly stage: "Edit" | "external_directory"
  }> = [
    {
      name: "a file in its own folder",
      session: ids.main,
      file: (l) => path.join(l.scratch(ids.main), "a.txt"),
      effect: "allow",
      stage: "Edit",
    },
    {
      name: "a file in a folder below its own",
      session: ids.main,
      file: (l) => path.join(l.scratch(ids.main), "sub", "deep", "a.txt"),
      effect: "allow",
      stage: "Edit",
    },
    {
      name: "a file beside the folder in the temporary folder",
      session: ids.main,
      file: (l) => path.join(l.tmp, "other.txt"),
      effect: "ask",
      stage: "Edit",
    },
    {
      name: "a file in the folder of sessions",
      session: ids.main,
      file: (l) => path.join(l.tmp, "sessions", "a.txt"),
      effect: "ask",
      stage: "Edit",
    },
    {
      name: "a file in the folder of another session",
      session: ids.main,
      file: (l) => path.join(l.scratch(ids.other), "a.txt"),
      effect: "ask",
      stage: "Edit",
    },
    {
      name: "the other session's own folder",
      session: ids.other,
      file: (l) => path.join(l.scratch(ids.other), "a.txt"),
      effect: "allow",
      stage: "Edit",
    },
    {
      name: "a folder that merely starts with the same name",
      session: ids.main,
      file: (l) => path.join(`${l.scratch(ids.main)}x`, "a.txt"),
      effect: "ask",
      stage: "Edit",
    },
    // A subagent and a fork use the folder of the session they came from, and not the one named after themselves.
    {
      name: "a subagent in its parent's folder",
      session: ids.child,
      file: (l) => path.join(l.scratch(ids.main), "a.txt"),
      effect: "allow",
      stage: "Edit",
    },
    {
      name: "a subagent in the folder named after itself",
      session: ids.child,
      file: (l) => path.join(l.scratch(ids.child), "a.txt"),
      effect: "ask",
      stage: "Edit",
    },
    {
      name: "a fork in its source's folder",
      session: ids.fork,
      file: (l) => path.join(l.scratch(ids.main), "a.txt"),
      effect: "allow",
      stage: "Edit",
    },
    {
      name: "a fork in the folder named after itself",
      session: ids.fork,
      file: (l) => path.join(l.scratch(ids.fork), "a.txt"),
      effect: "ask",
      stage: "Edit",
    },
    // The key is the immediate parent, or the fork source, so a lineage of three has two folders.
    {
      name: "a subagent's subagent in its parent's folder",
      session: ids.grandchild,
      file: (l) => path.join(l.scratch(ids.child), "a.txt"),
      effect: "allow",
      stage: "Edit",
    },
    {
      name: "a subagent's subagent in the root's folder",
      session: ids.grandchild,
      file: (l) => path.join(l.scratch(ids.main), "a.txt"),
      effect: "ask",
      stage: "Edit",
    },
    {
      name: "a fork of a subagent in the subagent's folder",
      session: ids.forkOfChild,
      file: (l) => path.join(l.scratch(ids.child), "a.txt"),
      effect: "allow",
      stage: "Edit",
    },
    {
      name: "a fork of a subagent in the root's folder",
      session: ids.forkOfChild,
      file: (l) => path.join(l.scratch(ids.main), "a.txt"),
      effect: "ask",
      stage: "Edit",
    },
  ]
  for (const row of rows)
    it.live(
      `${row.effect === "allow" ? "allows" : "asks about"} ${row.name}`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            return yield* decide(row.session, row.file(l))
          }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
          expect(out).toEqual({ effect: row.effect, stage: row.stage })
        }),
      timeout,
    )

  // A write that the tools ask about as `Edit` is the same call whichever tool makes it, and the rule is for that action.
  for (const [action, effect] of [
    ["Edit", "allow"],
    ["edit", "allow"],
    ["Read", "ask"],
    ["Bash", "ask"],
  ] as const)
    it.live(
      `${effect === "allow" ? "allows" : "asks about"} a request of the action ${action} in the folder`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* seed(l)
            const permission = yield* Permission.Service
            const resource = path.join(l.scratch(ids.main), "a.txt").replaceAll("\\", "/")
            return (yield* permission.ask({
              id: Permission.ID.create(),
              action,
              resources: [resource],
              sessionID: SessionSchema.ID.make(ids.main),
              agent: probe,
            })).effect
          }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
          expect(out).toBe(effect)
        }),
      timeout,
    )

  // The allow is Orbit's own, so a call that is marked as reaching the folder through a link that a project that is not
  // trusted ships is left to the person's own rules, as for the other folders of Orbit's.
  it.live("does not let the allow decide a call that is marked as reached through a link of a project", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const out = yield* Effect.gen(function* () {
        yield* seed(l)
        const permission = yield* Permission.Service
        const resource = path.join(l.scratch(ids.main), "a.txt").replaceAll("\\", "/")
        const ask = (escaped: boolean) =>
          permission
            .ask({
              id: Permission.ID.create(),
              action: "Edit",
              resources: [resource],
              ...(escaped ? { escaped: [resource] } : {}),
              sessionID: SessionSchema.ID.make(ids.main),
              agent: probe,
            })
            .pipe(Effect.map((answer) => answer.effect))
        return { plain: yield* ask(false), escaped: yield* ask(true) }
      }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
      expect(out).toEqual({ plain: "allow", escaped: "ask" })
    }),
  )

  // The allow comes before the person's rules, so a deny of theirs for the folder wins.
  it.live(
    "denies a file in the folder under a deny of the agent's, of the session's or of the person's for either spelling",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const file = path.join(l.scratch(ids.main), "a.txt")
        const rows = yield* Effect.gen(function* () {
          yield* seed(l, [{ action: "Edit", resource: path.join(l.scratch(ids.main), "*"), effect: "deny" }])
          yield* insertSession({
            id: "ses_scratch_denied",
            directory: l.project,
            agent: probe,
            permission: [{ action: "Edit", resource: path.join(l.scratch("ses_scratch_denied"), "*"), effect: "deny" }],
          })
          return {
            agent: yield* decide(ids.main, file),
            session: yield* decide("ses_scratch_denied", path.join(l.scratch("ses_scratch_denied"), "a.txt")),
            // The same rules say nothing of a file beside the denied one, so the deny is the deny of that folder only.
            neighbour: yield* decide(ids.other, path.join(l.scratch(ids.other), "a.txt")),
          }
        }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
        expect(rows).toEqual({
          agent: { effect: "deny", stage: "Edit" },
          session: { effect: "deny", stage: "Edit" },
          neighbour: { effect: "allow", stage: "Edit" },
        })
      }),
    timeout,
  )

  // Agents that take part in the lineage keep their own limits: the allow sits before each agent's own rules.
  const builtins = [
    { name: "a general subagent", agent: "general", effect: "allow" },
    { name: "the explore agent, which only reads", agent: "explore", effect: "deny" },
    { name: "the title agent, which edits nothing", agent: "title", effect: "deny" },
  ] as const
  for (const row of builtins)
    it.live(
      `${row.effect === "allow" ? "allows" : "denies"} an edit in the folder by ${row.name}`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            const agents = yield* Agent.Service
            yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
            yield* withoutAllowAll(agents, Agent.ID.make(row.agent))
            yield* seed(l)
            return yield* decide(ids.main, path.join(l.scratch(ids.main), "a.txt"), Agent.ID.make(row.agent))
          }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
          expect(out.effect).toBe(row.effect)
        }),
      timeout,
    )
})

// An ID that a client chose is a name for a folder only when `SessionScratchpad.key` says so. A session that has none
// gets no allow at all, whether the ID is its own, its parent's or its fork source's, so a folder that the ID would name
// is asked about like any other file of the temporary folder.
describe("the allow for a session whose ID cannot name a folder", () => {
  const hostile = [
    "ses_..",
    "ses_a.",
    "ses_a b",
    "ses_a/b",
    "ses_a\\b",
    "ses/../../x",
    "ses:x",
    `ses_${"a".repeat(300)}`,
  ]
  for (const id of hostile)
    for (const position of ["id", "parent", "fork source"] as const)
      it.live(
        `gives a session no allow when ${JSON.stringify(id.length > 40 ? `${id.slice(0, 12)}...` : id)} is its ${position}`,
        () =>
          Effect.gen(function* () {
            const l = yield* layout
            const out = yield* Effect.gen(function* () {
              yield* seed(l)
              const bad = position === "id" ? id : "ses_scratch_hostile"
              if (position !== "id") yield* insertSession({ id, directory: l.project, agent: probe })
              yield* insertSession({
                id: bad,
                directory: l.project,
                agent: probe,
                ...(position === "parent" ? { parentID: id } : position === "fork source" ? { fork: id } : {}),
              })
              // Where the ID would put the folder if it were joined as it is, and a plain file of the temporary folder.
              const named = path.join(l.tmp, "sessions", id, "a.txt")
              return {
                named: (yield* decide(bad, named)).effect,
                plain: (yield* decide(bad, path.join(l.tmp, "sessions", "ses_scratch_plain", "a.txt"))).effect,
              }
            }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
            // A name that the tools refuse before anything is asked is as good: no write follows.
            expect(["ask", "refused"]).toContain(out.named)
            expect(out.plain).toBe("ask")
          }),
        timeout,
      )

  // The trusted control: an ID of the same family that is a name gets its own folder, so the rows above are not
  // asking about a folder that nothing could allow.
  it.live("allows the folder of an ID that is a name, as a control", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const out = yield* Effect.gen(function* () {
        yield* seed(l)
        yield* insertSession({ id: "ses_ok_1", directory: l.project, agent: probe })
        return (yield* decide("ses_ok_1", path.join(l.scratch("ses_ok_1"), "a.txt"))).effect
      }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
      expect(out).toBe("allow")
    }),
  )
})

// The allow is written for the name that a call gives, so a name is not enough: a link inside the folder can lead
// anywhere, and the real place is what is decided. Each row has the plain file in the folder as its control.
describe("a link in the scratchpad", () => {
  const places = [
    { name: "a folder outside the temporary folder", target: (l: Layout) => l.elsewhere },
    { name: "another place in the temporary folder", target: (l: Layout) => path.join(l.tmp, "plain") },
    { name: "the folder of another session", target: (l: Layout) => l.scratch(ids.other) },
  ]
  for (const place of places) {
    it.live(
      `does not let the allow decide a write through a link to ${place.name}`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.mkdir(place.target(l), { recursive: true })
              await fs.mkdir(l.scratch(ids.main), { recursive: true })
              await fs.symlink(place.target(l), path.join(l.scratch(ids.main), "out"), linkType)
            })
            yield* seed(l)
            return {
              // An existing folder behind the link, and a file that is not there yet below it.
              existing: yield* decide(ids.main, path.join(l.scratch(ids.main), "out", "b.txt")),
              fresh: yield* decide(ids.main, path.join(l.scratch(ids.main), "out", "new", "c.txt")),
              control: yield* decide(ids.main, path.join(l.scratch(ids.main), "a.txt")),
            }
          }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
          expect(out.control).toEqual({ effect: "allow", stage: "Edit" })
          // Never an allow, and it asks about the folder that the link leads to when that is not Orbit's own, and about
          // the file when it is.
          expect(out.existing.effect).toBe("ask")
          expect(out.fresh.effect).toBe("ask")
        }),
      timeout,
    )
  }

  it.live(
    "asks about a link to a folder outside the temporary folder before the file, for the folder it leads to",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(l.scratch(ids.main), { recursive: true })
            await fs.symlink(l.elsewhere, path.join(l.scratch(ids.main), "out"), linkType)
          })
          yield* seed(l)
          return yield* decide(ids.main, path.join(l.scratch(ids.main), "out", "b.txt"))
        }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
        expect(out).toEqual({ effect: "ask", stage: "external_directory" })
      }),
  )

  const dangling = canLinkFile ? it.live : it.live.skip
  dangling("does not let the allow decide a write through a link that points nowhere", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const out = yield* Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(l.scratch(ids.main), { recursive: true })
          await fs.symlink(path.join(l.elsewhere, "not-there", "file"), path.join(l.scratch(ids.main), "dangling"))
        })
        yield* seed(l)
        return {
          dangling: yield* decide(ids.main, path.join(l.scratch(ids.main), "dangling")),
          control: yield* decide(ids.main, path.join(l.scratch(ids.main), "a.txt")),
        }
      }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
      expect(out.control.effect).toBe("allow")
      expect(out.dangling.effect).toBe("ask")
    }),
  )

  // The other direction: a link in the project that leads into the scratchpad is the project's own name for it. An
  // untrusted project's link is the person's to allow, and a trusted project's is decided by its own spelling.
  for (const trusted of [false, true])
    it.live(
      `does not let the allow decide a write through a link of ${trusted ? "a trusted" : "an untrusted"} project into the folder`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.mkdir(l.scratch(ids.main), { recursive: true })
              await fs.symlink(l.scratch(ids.main), path.join(l.project, "pad"), linkType)
            })
            yield* seed(l)
            return {
              linked: yield* decide(ids.main, path.join(l.project, "pad", "a.txt")),
              control: yield* decide(ids.main, path.join(l.scratch(ids.main), "a.txt")),
            }
          }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, trusted))
          expect(out.control.effect).toBe("allow")
          expect(out.linked.effect).toBe("ask")
          // In a project that is not trusted the folder question itself is the person's: Orbit's allow for its temporary
          // folder does not decide a place that a link of the project leads to.
          expect(out.linked.stage).toBe(trusted ? "Edit" : "external_directory")
        }),
      timeout,
    )

  // The temporary folder reached through a link: the allow is written for each spelling, a deny for the one spelling
  // decides both, and a link inside the folder still cannot lead out of it.
  it.live("allows each spelling of a temporary folder that is a link, and denies both under a deny for one", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const real = path.join(l.root, "tmp-real")
      const spelled = path.join(l.root, "tmp-link")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(real, "sessions", ids.main), { recursive: true })
        await fs.symlink(real, spelled, linkType)
      })
      const allowed = yield* Effect.gen(function* () {
        yield* seed(l)
        return {
          spelled: yield* decide(ids.main, path.join(spelled, "sessions", ids.main, "a.txt")),
          real: yield* decide(ids.main, path.join(real, "sessions", ids.main, "a.txt")),
          other: yield* decide(ids.main, path.join(spelled, "sessions", ids.other, "a.txt")),
        }
      }).pipe(provide(l.project, { tmp: spelled, data: l.data, config: l.config }, true))
      expect(allowed).toEqual({
        spelled: { effect: "allow", stage: "Edit" },
        real: { effect: "allow", stage: "Edit" },
        other: { effect: "ask", stage: "Edit" },
      })
      const denied = yield* Effect.gen(function* () {
        yield* seed(l, [{ action: "Edit", resource: path.join(spelled, "sessions", ids.main, "*"), effect: "deny" }])
        return {
          spelled: (yield* decide(ids.main, path.join(spelled, "sessions", ids.main, "a.txt"))).effect,
          real: (yield* decide(ids.main, path.join(real, "sessions", ids.main, "a.txt"))).effect,
        }
      }).pipe(provide(l.project, { tmp: spelled, data: l.data, config: l.config }, true))
      expect(denied).toEqual({ spelled: "deny", real: "deny" })
    }),
  )
})

// The spellings that one file has. The tools resolve the path before the rules see it, so each spelling of a file in
// the folder is the same call, and a `..` that climbs out is a call for the place it reaches.
describe("the spellings of a file in the scratchpad", () => {
  const spellings: ReadonlyArray<{
    readonly name: string
    readonly windows?: boolean
    readonly file: (scratch: string) => string
    readonly effect: "allow" | "ask"
  }> = [
    { name: "its plain path", file: (scratch) => path.join(scratch, "a.txt"), effect: "allow" },
    { name: "forward slashes", file: (scratch) => `${scratch.replaceAll("\\", "/")}/a.txt`, effect: "allow" },
    {
      name: "a `..` that comes back into the folder",
      file: (scratch) => `${scratch}${path.sep}sub${path.sep}..${path.sep}a.txt`,
      effect: "allow",
    },
    {
      name: "a `..` that climbs out of the folder",
      file: (scratch) => `${scratch}${path.sep}..${path.sep}a.txt`,
      effect: "ask",
    },
    {
      name: "a `..` that climbs out and into another folder",
      file: (scratch) => `${scratch}${path.sep}..${path.sep}${ids.other}${path.sep}a.txt`,
      effect: "ask",
    },
    {
      name: "a lowercase drive letter",
      windows: true,
      file: (scratch) => `${scratch[0]!.toLowerCase()}${scratch.slice(1)}${path.sep}a.txt`,
      effect: "allow",
    },
    {
      name: "an uppercase path in a folder of different case",
      windows: true,
      file: (scratch) => `${scratch.toUpperCase()}${path.sep}a.txt`,
      effect: "allow",
    },
    {
      name: "a trailing period on the file name",
      windows: true,
      file: (scratch) => `${scratch}${path.sep}a.txt.`,
      effect: "allow",
    },
  ]
  for (const row of spellings) {
    const run = row.windows && process.platform !== "win32" ? it.live.skip : it.live
    run(
      `${row.effect === "allow" ? "allows" : "asks about"} ${row.name}`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const out = yield* Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(path.join(l.scratch(ids.main), "sub"), { recursive: true }))
            yield* seed(l)
            return (yield* decide(ids.main, row.file(l.scratch(ids.main)))).effect
          }).pipe(provide(l.project, { tmp: l.tmp, data: l.data, config: l.config }, true))
          expect(out).toBe(row.effect)
        }),
      timeout,
    )
  }
})

// `Permission` and the scratchpad service name the folder with the same function of the session.
describe("SessionScratchpad.key", () => {
  const lineage = (input: { readonly id: string; readonly parentID?: string; readonly fork?: string }) => ({
    id: SessionSchema.ID.make(input.id),
    ...(input.parentID === undefined ? {} : { parentID: SessionSchema.ID.make(input.parentID) }),
    ...(input.fork === undefined
      ? {}
      : {
          fork: {
            sessionID: SessionSchema.ID.make(input.fork),
            boundary: { type: "through" as const, messageID: SessionMessage.ID.make("msg_x") },
          },
        }),
  })

  test("is the ID of the session that the lineage goes back to, for an ID that is a name", () => {
    expect(SessionScratchpad.key(lineage({ id: "ses_a" }))).toBe("ses_a")
    expect(SessionScratchpad.key(lineage({ id: "ses_a", parentID: "ses_b" }))).toBe("ses_b")
    expect(SessionScratchpad.key(lineage({ id: "ses_a", fork: "ses_c" }))).toBe("ses_c")
    expect(SessionScratchpad.key(lineage({ id: "ses_a", parentID: "ses_b", fork: "ses_c" }))).toBe("ses_b")
  })

  // The shape is `ses_` and letters, digits and underscores, so that no spelling of a path can be taken for a name.
  const refused = [
    "ses_",
    "ses_..",
    "ses_a.",
    "ses_a ",
    "ses_ a",
    "ses_a/b",
    "ses_a\\b",
    "ses/../../x",
    "ses\\..\\..\\x",
    "ses_../x",
    "ses:x",
    "ses_a:b",
    "ses_a\0b",
    "ses_a\nb",
    "ses_é",
    "session",
    "ses",
    `ses_${"a".repeat(97)}`,
  ]
  for (const id of refused)
    for (const position of ["id", "parentID", "fork"] as const)
      test(`is nothing for ${JSON.stringify(id.length > 30 ? `${id.slice(0, 12)}...` : id)} as the ${position}`, () => {
        const session =
          position === "id"
            ? lineage({ id })
            : position === "parentID"
              ? lineage({ id: "ses_own", parentID: id })
              : lineage({ id: "ses_own", fork: id })
        expect(SessionScratchpad.key(session)).toBeUndefined()
      })

  test("is a name up to the longest that fits", () => {
    expect(SessionScratchpad.key(lineage({ id: `ses_${"a".repeat(96)}` }))).toBe(`ses_${"a".repeat(96)}`)
    expect(SessionScratchpad.key(lineage({ id: "ses_Ab_09" }))).toBe("ses_Ab_09")
  })
})
