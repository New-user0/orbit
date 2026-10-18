import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { Instance } from "@orbit/core/instance/service"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionPrompt } from "@orbit/core/session/prompt"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Admission decides what of a prompt's editor field and @agent mentions reaches the durable inbox item. The real stack
// decides: Permission, Agent and FileAccess; only the instance is a pass-through, because the stack is already the
// session's own.

const sessionID = Session.ID.make("ses_prompt_editor")

const provide = (project: string) =>
  Effect.provide(
    Layer.mergeAll(
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
        ]),
        [
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(project) }))),
          ),
        ],
      ),
      Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
      Layer.succeed(Instance.Service, Instance.Service.of({ provide: () => (effect) => effect as never })),
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
        slug: "editor",
        directory: project,
        title: "editor",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      })
      editor.update(Agent.ID.make("helper"), (agent) => {
        agent.mode = "subagent"
      })
      editor.update(Agent.ID.make("both"), (agent) => {
        agent.mode = "all"
      })
      editor.update(Agent.ID.make("lead"), (agent) => {
        agent.mode = "primary"
      })
    })
  })

/** Admits one prompt the way `Session.prompt` does and returns the inbox payload. */
const admit = (input: SessionPrompt.Input) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const session = yield* store.get(sessionID)
    if (!session) throw new Error("no session")
    const item = yield* SessionPrompt.prepare({ session, messageID: SessionMessage.ID.create(), input }).pipe(
      Effect.provideService(FSUtil.Service, yield* FSUtil.Service),
    )
    if (item.type !== "user") throw new Error("not a user item")
    return item.payload
  })

const allow = { action: "*", resource: "*", effect: "allow" } satisfies Permission.Rule

describe("editor context at admission", () => {
  it.live("passes through onto the inbox payload", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const editor = {
        path: path.join(project, "src", "a.ts"),
        selection: { start: 2, end: 4, text: "one\ntwo\nthree" },
      }
      const payload = yield* Effect.gen(function* () {
        yield* prepare(project, [allow])
        return yield* admit({ text: "hi", editor })
      }).pipe(provide(project))
      expect(payload.editor).toEqual(editor)
    }),
  )

  const spellings = (project: string) =>
    [
      ["plain path", path.join(project, "secret", "key.txt")],
      ...(process.platform === "win32"
        ? [["other drive-letter case", path.join(project, "secret", "key.txt").replace(/^./, (c) => c.toLowerCase())] as const]
        : []),
    ] as const

  it.live("a read rule that denies the path drops the field and still admits the prompt", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const results = yield* Effect.gen(function* () {
        yield* prepare(project, [allow, { action: "Read", resource: "secret/*", effect: "deny" }])
        return yield* Effect.forEach(
          [...spellings(project), ["trusted control", path.join(project, "open", "a.txt")] as const],
          ([name, file]) =>
            Effect.gen(function* () {
              const payload = yield* admit({ text: "hi", editor: { path: file } })
              return [name, payload.text, payload.editor !== undefined] as const
            }),
        )
      }).pipe(provide(project))
      expect(results).toEqual([
        ["plain path", "hi", false],
        ...(process.platform === "win32" ? [["other drive-letter case", "hi", false] as const] : []),
        ["trusted control", "hi", true],
      ])
    }),
  )

  it.live("a ~ spelling is resolved before the rule decides", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const home = Global.Path.home.replaceAll("\\", "/")
      const results = yield* Effect.gen(function* () {
        yield* prepare(project, [allow, { action: "Read", resource: `${home}/.ssh/*`, effect: "deny" }])
        return [
          (yield* admit({ text: "hi", editor: { path: "~/.ssh/id_rsa" } })).editor,
          (yield* admit({ text: "hi", editor: { path: "~/notes/a.txt" } })).editor,
        ]
      }).pipe(provide(project))
      expect(results).toEqual([undefined, { path: "~/notes/a.txt" }])
    }),
  )

  it.live("a relative path and a selection that ends before it starts drop the field", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const results = yield* Effect.gen(function* () {
        yield* prepare(project, [allow])
        return [
          (yield* admit({ text: "hi", editor: { path: "src/a.ts" } })).editor,
          (yield* admit({
            text: "hi",
            editor: { path: path.join(project, "a.ts"), selection: { start: 5, end: 4, text: "x" } },
          })).editor,
        ]
      }).pipe(provide(project))
      expect(results).toEqual([undefined, undefined])
    }),
  )
})

describe("agent mentions at admission", () => {
  it.live("keeps the agents a subagent call can start, in order, and drops the rest", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const payload = yield* Effect.gen(function* () {
        yield* prepare(project, [allow])
        return yield* admit({
          text: "hi",
          agents: [{ name: "helper" }, { name: "ghost" }, { name: "lead" }, { name: "both" }],
        })
      }).pipe(provide(project))
      expect(payload.agents?.map((agent) => agent.name)).toEqual(["helper", "both"])
    }),
  )
})
