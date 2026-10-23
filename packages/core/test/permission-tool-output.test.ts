// tool-runtime-8, classes 4, 5 and 8: a session reads the results it saved without a folder question, and nothing else.
// The allow names `<data>/tool-output/<asking session>/*` for each spelling of the data folder and decides a call only
// when the call's real place is in that folder, end to end through the real Agent layer, FileAccess and Permission. Each
// row reports the answer to the `external_directory` question the file tools ask first.
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
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionStore } from "@orbit/core/session/store"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { insertSession } from "./lib/session-row"

const linkType = process.platform === "win32" ? "junction" : "dir"
const probe = Agent.ID.make("probe")
const ids = {
  own: "ses_tout_own",
  other: "ses_tout_other",
  child: "ses_tout_child",
  fork: "ses_tout_fork",
  // Passes `SessionID` (a `ses` prefix) but cannot name a folder: joined, it would name the folder of `own`.
  crafted: "ses_bad/../ses_tout_own",
} as const

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const project = path.join(root, "project")
  const data = path.join(root, "realdata")
  const dataLink = path.join(root, "datalink")
  const outside = path.join(root, "outside")
  const saved = (session: string, name = "msg_0a-call_x-1a2b3c4d.txt") => path.join(data, "tool-output", session, name)
  yield* Effect.promise(async () => {
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, "secret.txt"), "secret")
    for (const session of [ids.own, ids.other, ids.child, ids.fork]) {
      await fs.mkdir(path.dirname(saved(session)), { recursive: true })
      await fs.writeFile(saved(session), "saved")
    }
    await fs.writeFile(path.join(data, "tool-output", "tool_0123456789ab"), "legacy")
    await fs.mkdir(path.join(data, "tool-output-evil", ids.own), { recursive: true })
    await fs.writeFile(path.join(data, "tool-output-evil", ids.own, "x.txt"), "evil")
    // A link inside the session's own folder that leads out of it.
    await fs.symlink(outside, path.join(data, "tool-output", ids.own, "escape"), linkType)
    await fs.symlink(data, dataLink, linkType)
  })
  return { root, project, data, dataLink, outside, saved }
})
type Layout = Effect.Success<typeof layout>

const provide = (l: Layout) =>
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
        Global.node.replace(Global.layerWith({ data: l.dataLink, tmp: path.join(l.root, "tmp") })),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(l.project) }))),
        ),
      ],
    ),
  )

const seed = (l: Layout) =>
  Effect.gen(function* () {
    yield* insertSession({ id: ids.own, directory: l.project, agent: probe })
    yield* insertSession({ id: ids.other, directory: l.project, agent: probe })
    yield* insertSession({ id: ids.child, directory: l.project, parentID: ids.own, agent: probe })
    yield* insertSession({ id: ids.fork, directory: l.project, fork: ids.own, agent: probe })
    yield* insertSession({ id: ids.crafted, directory: l.project, agent: probe })
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => editor.update(probe, () => {}))
  })

const decide = (sessionID: string, file: string) =>
  Effect.gen(function* () {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const target = yield* access.resolve({ path: file })
    const request = access.externalRequest([target], { sessionID: SessionSchema.ID.make(sessionID), agent: probe })
    if (request === undefined) return "inside"
    return (yield* permission.ask({ ...request, id: Permission.ID.create() })).effect
  })

const timeout = { timeout: 120_000 }

describe("the prompt-free read of saved results", () => {
  const rows: ReadonlyArray<{
    readonly name: string
    readonly session: string
    readonly file: (l: Layout) => string
    readonly effect: "allow" | "ask"
  }> = [
    { name: "a file the session saved", session: ids.own, file: (l) => l.saved(ids.own), effect: "allow" },
    {
      name: "a file the session saved, named through the linked data folder",
      session: ids.own,
      file: (l) => path.join(l.dataLink, "tool-output", ids.own, path.basename(l.saved(ids.own))),
      effect: "allow",
    },
    { name: "another session's saved file", session: ids.own, file: (l) => l.saved(ids.other), effect: "ask" },
    { name: "the parent's file, read by a subagent", session: ids.child, file: (l) => l.saved(ids.own), effect: "ask" },
    {
      name: "the subagent's file, read by its parent",
      session: ids.own,
      file: (l) => l.saved(ids.child),
      effect: "ask",
    },
    { name: "the source's file, read by a fork", session: ids.fork, file: (l) => l.saved(ids.own), effect: "ask" },
    {
      name: "a flat file from before the session folders",
      session: ids.own,
      file: (l) => path.join(l.data, "tool-output", "tool_0123456789ab"),
      effect: "ask",
    },
    {
      name: "a file under a folder that only starts with the same name",
      session: ids.own,
      file: (l) => path.join(l.data, "tool-output-evil", ids.own, "x.txt"),
      effect: "ask",
    },
    {
      name: "another session's file spelled through the session's own folder and ..",
      session: ids.own,
      file: (l) => [path.dirname(l.saved(ids.own)), "..", ids.other, path.basename(l.saved(ids.other))].join(path.sep),
      effect: "ask",
    },
    {
      name: "a file a link inside the session's folder leads out to",
      session: ids.own,
      file: (l) => path.join(l.data, "tool-output", ids.own, "escape", "secret.txt"),
      effect: "ask",
    },
    {
      name: "a file of the folder a crafted session ID would join to",
      session: ids.crafted,
      file: (l) => l.saved(ids.own),
      effect: "ask",
    },
  ]
  for (const row of rows)
    it.live(
      `${row.effect === "allow" ? "allows" : "asks about"} ${row.name}`,
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const effect = yield* Effect.gen(function* () {
            yield* seed(l)
            return yield* decide(row.session, row.file(l))
          }).pipe(provide(l))
          expect(effect).toBe(row.effect)
        }),
      timeout,
    )

  if (process.platform === "win32")
    it.live(
      "allows a file the session saved, named in other letter case",
      () =>
        Effect.gen(function* () {
          const l = yield* layout
          const effect = yield* Effect.gen(function* () {
            yield* seed(l)
            return yield* decide(ids.own, l.saved(ids.own).replace("tool-output", "TOOL-OUTPUT"))
          }).pipe(provide(l))
          expect(effect).toBe("allow")
        }),
      timeout,
    )
})
