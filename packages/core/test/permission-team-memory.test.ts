// context-memory-11, classes 1, 3, 4 and 8: with `memory.team` on, memory on and the project trusted, the team memory
// folder (`<project>/.orbit/team-memory/`) is prompt-free for the file tools exactly as the private memory folder is
// (context-memory-9), since the reference keeps its team folder inside its memory folder and its carve-out covers both:
// no ask of the person's reaches it, a deny of theirs still decides. The allow decides only a call whose real place is
// in the real team folder, and only while the folder itself stays inside the real project folder, because a clone
// chooses what that folder is (a link out of it must not carry a prompt-free write anywhere). Off, untrusted or refused,
// the folder is an ordinary project folder. Every row that expects a question also checks a team file that is allowed
// in the same run, so no row passes because nothing is prompt-free.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { Document, Info, type Entry, type Scope } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigTrust } from "@orbit/core/config/trust"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionStore } from "@orbit/core/session/store"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { insertSession } from "./lib/session-row"

const probe = Agent.ID.make("probe")
const linkType = process.platform === "win32" ? "junction" : "dir"
const main = "ses_team_memory_main"
const timeout = { timeout: 120_000 }
const decodeInfo = Schema.decodeUnknownSync(Info)

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
  return { root, ...folders, team: path.join(folders.project, ".orbit", "team-memory") }
})
type Layout = Effect.Success<typeof layout>

const configured = (scope: Scope, memory: Record<string, unknown>) =>
  new Document({
    type: "document",
    scope,
    path: AbsolutePath.make(path.resolve(`/config/${scope}/orbit.json`)),
    info: decodeInfo({ memory }),
  })
const teamOn = [configured("user", { team: true })]

const provide = (l: Layout, entries: Entry[] = teamOn, options: { readonly untrusted?: boolean } = {}) =>
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
        Global.node.replace(Global.layerWith({ tmp: l.tmp, data: l.data, config: l.config })),
        Config.node.replace(Config.testLayer(entries)),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(l.project) }))),
        ),
        ...(options.untrusted ? [WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false }))] : []),
      ],
    ),
  )

// The agent without its allow of everything, so that what no rule speaks to is the fallthrough ask, plus `extra` after
// its own rules, as the person's config rules come.
const seed = (l: Layout, extra: Permission.Ruleset = []) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(probe, (agent) => {
        agent.permissions = agent.permissions.filter(
          (rule) => !(rule.action === "*" && rule.resource === "*" && rule.effect === "allow"),
        )
        agent.permissions.push(...extra)
      }),
    )
    yield* insertSession({ id: main, directory: l.project, agent: probe })
  })

// What the file tools do, in their order: resolve the path, ask for the folder, and then for the file with `action`.
const decide = (file: string, action: "Edit" | "Read" = "Edit") =>
  Effect.gen(function* () {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const base = { sessionID: SessionSchema.ID.make(main), agent: probe }
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

describe("the team memory folder", () => {
  it.live(
    "writes and reads team memory without a question under the person's ask rules",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          return {
            file: yield* decide(path.join(l.team, "testing.md")),
            nested: yield* decide(path.join(l.team, "topics", "build.md")),
            index: yield* decide(path.join(l.team, "MEMORY.md")),
            read: yield* decide(path.join(l.team, "testing.md"), "Read"),
            project: yield* decide(path.join(l.project, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({
          file: allowEdit,
          nested: allowEdit,
          index: allowEdit,
          read: { effect: "allow", stage: "Read" },
          project: { effect: "ask", stage: "Edit" },
        })
      }),
    timeout,
  )

  // Spellings the file tools accept for one team file: each is the same place, and is prompt-free.
  it.live(
    "writes a team file by every spelling without a question",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const spellings = [
          ".orbit/team-memory/a.md",
          "./.orbit/x/../team-memory/a.md",
          path.join(l.team, "a.md"),
          ...(process.platform === "win32"
            ? [".ORBIT\\TEAM-MEMORY\\a.md", path.join(l.team, "a.md").replaceAll("\\", "/")]
            : []),
        ]
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          return yield* Effect.forEach(spellings, (file) => decide(file))
        }).pipe(provide(l))
        expect(out).toEqual(spellings.map(() => allowEdit))
      }),
    timeout,
  )

  // Class 4: a sibling whose name only starts the same, a `..` back out of the folder and the `.orbit` folder above it
  // are not team memory.
  it.live(
    "asks about places beside the team folder",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          return {
            sibling: (yield* decide(".orbit/team-memory-evil/a.md")).effect,
            above: (yield* decide(".orbit/team-memory/../a.md")).effect,
            orbit: (yield* decide(".orbit/orbit.json")).effect,
            control: yield* decide(".orbit/team-memory/a.md"),
          }
        }).pipe(provide(l))
        expect(out).toEqual({ sibling: "ask", above: "ask", orbit: "ask", control: allowEdit })
      }),
    timeout,
  )

  // Class 8: the carve-out widens the person's rules only while team memory is on: `memory.team` set, and memory itself
  // on, as the reference turns team memory off with auto memory.
  it.live(
    "asks about the team folder while memory.team or memory is off",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const file = path.join(l.team, "a.md")
        const run = (entries: Entry[]) =>
          Effect.gen(function* () {
            yield* seed(l, askRules)
            return yield* decide(file)
          }).pipe(provide(l, entries))
        expect({
          unset: (yield* run([])).effect,
          off: (yield* run([configured("user", { team: false })])).effect,
          later: (yield* run([configured("user", { team: true }), configured("project", { team: false })])).effect,
          memoryOff: (yield* run([configured("user", { team: true, enabled: false })])).effect,
          on: yield* run(teamOn),
          // A trusted project's own config may turn it on.
          project: yield* run([configured("project", { team: true })]),
        }).toEqual({ unset: "ask", off: "ask", later: "ask", memoryOff: "ask", on: allowEdit, project: allowEdit })
      }),
    timeout,
  )

  // A mode is not a rule of the person's: as for the private folder, Plan's deny of every edit does not stop a team
  // memory write, while it still stops a project file. `Permission.denied`, which hides what a deny covers before a
  // tool asks, answers the same way.
  it.live(
    "writes team memory under a mode's deny of every edit, and the mode still denies a project file",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, [Agent.modeRule({ action: "Edit", resource: "*", effect: "deny" as const })])
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
            team: yield* decide(path.join(l.team, "a.md")),
            project: yield* decide(path.join(l.project, "a.md")),
            teamDenied: yield* denied(path.join(l.team, "a.md")),
            projectDenied: yield* denied(path.join(l.project, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({
          team: allowEdit,
          project: { effect: "deny", stage: "Edit" },
          teamDenied: false,
          projectDenied: true,
        })
      }),
    timeout,
  )

  // Class 1: nothing of the team folder counts before the project is trusted, whatever the person's own config says.
  // The trusted run is the control.
  it.live(
    "asks about the team folder of a project that is not trusted",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const file = path.join(l.team, "a.md")
        const run = (untrusted: boolean) =>
          Effect.gen(function* () {
            yield* seed(l, askRules)
            return yield* decide(file)
          }).pipe(provide(l, teamOn, { untrusted }))
        expect({ untrusted: (yield* run(true)).effect, trusted: yield* run(false) }).toEqual({
          untrusted: "ask",
          trusted: allowEdit,
        })
      }),
    timeout,
  )

  // A deny wins over any ask: a deny for one team file stays a deny under a later, broader ask.
  it.live(
    "denies a team file under the person's deny",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const out = yield* Effect.gen(function* () {
          yield* seed(l, [
            { action: "Edit", resource: path.join(l.team, "secret.md"), effect: "deny" },
            { action: "Read", resource: ".orbit/team-memory/private.md", effect: "deny" },
            ...askRules,
          ])
          return {
            denied: (yield* decide(path.join(l.team, "secret.md"))).effect,
            relative: (yield* decide(path.join(l.team, "private.md"), "Read")).effect,
            control: yield* decide(path.join(l.team, "open.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({ denied: "deny", relative: "deny", control: allowEdit })
      }),
    timeout,
  )

  // Classes 3 and 4: a link inside the team folder that points out of the project is decided by where it leads, as a
  // place outside the project, never by the team allow.
  it.live(
    "asks about a link inside the team folder that leads out",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        yield* Effect.promise(async () => {
          await fs.mkdir(l.team, { recursive: true })
          await fs.symlink(l.outside, path.join(l.team, "out"), linkType)
        })
        const out = yield* Effect.gen(function* () {
          yield* seed(l, askRules)
          return {
            linked: (yield* decide(path.join(l.team, "out", "a.md"))).effect,
            read: (yield* decide(path.join(l.team, "out", "a.md"), "Read")).effect,
            control: yield* decide(path.join(l.team, "a.md")),
          }
        }).pipe(provide(l))
        expect(out.linked).not.toBe("allow")
        expect(out.read).not.toBe("allow")
        expect(out.control).toEqual(allowEdit)
      }),
    timeout,
  )

  // Class 4: a clone can ship `.orbit/team-memory` as a link to a folder outside the project, such as one of the
  // person's own. Team memory is then off for the Location: nothing there is prompt-free. A second project whose team
  // folder is a plain folder is the control.
  it.live(
    "asks about a team folder that leads out of the project",
    () =>
      Effect.gen(function* () {
        const linked = yield* layout
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(linked.team), { recursive: true })
          await fs.symlink(linked.outside, linked.team, linkType)
        })
        const plain = yield* layout
        const run = (l: Layout) =>
          Effect.gen(function* () {
            yield* seed(l, askRules)
            return {
              spelled: (yield* decide(path.join(l.team, "a.md"))).effect,
              index: (yield* decide(path.join(l.team, "MEMORY.md"), "Read")).effect,
            }
          }).pipe(provide(l))
        const out = { linked: yield* run(linked), plain: yield* run(plain) }
        expect(out.linked.spelled).not.toBe("allow")
        expect(out.linked.index).not.toBe("allow")
        expect(out.plain).toEqual({ spelled: "allow", index: "allow" })
      }),
    timeout,
  )

  // Class 8: the carve-out is for the file tools. A shell command that names the team folder is decided by the shell's
  // own rules, as one that names any other project file.
  it.live(
    "asks about a shell command in the team folder",
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
            shell: yield* shell(`rm ${path.join(l.team, "a.md")}`),
            script: yield* shell(path.join(l.team, "run.sh")),
            control: yield* decide(path.join(l.team, "a.md")),
          }
        }).pipe(provide(l))
        expect(out).toEqual({ shell: "ask", script: "ask", control: allowEdit })
      }),
    timeout,
  )
})

// Class 8: `memory.team` turns on prompt-free writes into the repository, so it is a permission: an untrusted folder's
// config supplies no `memory` at all. The key itself survives decoding, so a person's or a trusted project's config
// can set it.
describe("memory.team in config", () => {
  it.live("withholds memory.team with the rest of memory for an untrusted folder", () =>
    Effect.gen(function* () {
      const tmp = (yield* tmpdirScoped()).path
      const info = decodeInfo({ memory: { team: true }, username: "kept" })
      expect(Object.entries(info.memory ?? {})).toEqual([["team", true]])
      const result = ConfigTrust.sanitize(info, { roots: [tmp], directory: tmp })
      expect(result.info.username).toBe("kept")
      expect(result.info).not.toHaveProperty("memory")
      expect(result.withheld).toEqual(["permissions"])
    }),
  )
})
