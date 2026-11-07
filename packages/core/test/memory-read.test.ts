// context-memory-9: a Read of a memory file that is more than a day old starts with a short note, in a reminder
// envelope, that names its age in days and says a memory is a record of a past moment to check against the code, as the
// reference's read tool does for every file of its memory folder. A fresh memory file, a file outside the folder and a
// memory file while memory is switched off get no note.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { Image } from "@orbit/core/image"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { InstructionTriggers } from "@orbit/core/instruction-triggers"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInstructions } from "@orbit/core/session/instructions"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { executeTool, registerToolPlugin } from "./lib/tool"

const readToolNode = makeLocationNode({
  name: "test/memory-read-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
  deps: [
    Config.node,
    Environment.node,
    FileLedger.node,
    Tool.node,
    ReadToolFileSystem.node,
    FileAccess.node,
    Image.node,
    Permission.node,
    SessionInstructions.node,
    InstructionTriggers.node,
    InstructionDiscovery.node,
    FSUtil.node,
    Location.node,
  ],
})

const harness = (entries: Entry[] = []) => {
  const config = Config.testLayer(entries)
  return testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionProjector.node,
        SessionStore.node,
        Session.node,
        Location.node,
        FSUtil.node,
        FileAccess.node,
        ReadToolFileSystem.node,
        readToolNode,
        FileLedger.node,
        Tool.node,
        PluginHooks.node,
        ProjectTrust.node,
        SessionInstructions.node,
        InstructionTriggers.node,
        InstructionDiscovery.node,
        Global.node,
        Image.node,
      ]),
      [
        Project.node.replace(globalProjectNode),
        SessionExecution.node.replace(SessionExecution.noopLayer),
        Location.node.replace(tempLocationLayer),
        Global.node.replace(tempGlobalLayer),
        Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
        Config.node.replace(config),
        Image.node.replace(AppNodeBuilder.build(Image.node, [Config.node.replace(config)])),
      ],
    ),
  )
}

const it = harness()
const off = harness([
  new Document({
    type: "document",
    scope: "user",
    path: AbsolutePath.make(path.resolve("/config/orbit.json")),
    info: Schema.decodeUnknownSync(Info)({ memory: { enabled: false } }),
  }),
])

const DAY = 86_400_000

// Writes `name` with `text`, last changed `days` ago, into the memory folder of the Location's project, or into the
// Location's own folder when `inMemory` is false, and reads it back with the Read tool.
const readAged = (name: string, text: string, days: number, inMemory = true) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const location = yield* Location.Service
    const folder = inMemory ? path.join(global.data, "memory", location.project.id) : location.directory
    const file = path.join(folder, name)
    yield* Effect.promise(async () => {
      await fs.mkdir(folder, { recursive: true })
      await fs.writeFile(file, text)
      const when = new Date(Date.now() - days * DAY)
      await fs.utimes(file, when, when)
    })
    const session = yield* Session.Service
    const sessionID = (yield* session.create({ location: Location.Ref.make({ directory: location.directory }) })).id
    const registry = yield* Tool.Service
    const result = yield* executeTool(registry, {
      sessionID,
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_memory_read"),
      call: { type: "tool-call", id: `call-${name}`, name: "Read", input: { file_path: file } },
    })
    expect(result.status).toBe("completed")
    const first = result.content?.[0]
    return first?.type === "text" ? first.text : ""
  })

describe("a Read of a memory file", () => {
  it.live("starts with a note naming the age of a memory older than a day", () =>
    Effect.gen(function* () {
      const text = yield* readAged("old.md", "OLD-MEMORY-BODY\n", 47)
      expect(text.startsWith("<system-reminder>\n")).toBe(true)
      expect(text.slice(0, text.indexOf("</system-reminder>"))).toContain("47 days")
      expect(text.indexOf("OLD-MEMORY-BODY")).toBeGreaterThan(text.indexOf("</system-reminder>"))
    }),
  )

  it.live("adds no note to a memory written today, or to an old file outside the memory folder", () =>
    Effect.gen(function* () {
      const fresh = yield* readAged("fresh.md", "FRESH-BODY\n", 0)
      const outside = yield* readAged("outside.md", "OUTSIDE-BODY\n", 47, false)
      // The control: an old memory file in the same run gets the note.
      const old = yield* readAged("old-control.md", "OLD-BODY\n", 47)
      expect(old).toContain("<system-reminder>")
      expect(fresh).not.toContain("<system-reminder>")
      expect(outside).not.toContain("<system-reminder>")
    }),
  )
})

describe("a Read of a memory file while memory is switched off", () => {
  off.live("adds no note", () =>
    Effect.gen(function* () {
      const text = yield* readAged("old.md", "OLD-MEMORY-BODY\n", 47)
      expect(text).toContain("OLD-MEMORY-BODY")
      expect(text).not.toContain("<system-reminder>")
    }),
  )
})

// context-memory-11: the reference's age note covers every file below its memory folder, and its team folder is one of
// them, so a Read of a team memory file more than a day old starts with the same note while team memory is on. An old
// project file in the same run is the control that gets none.
const team = harness([
  new Document({
    type: "document",
    scope: "user",
    path: AbsolutePath.make(path.resolve("/config/orbit.json")),
    info: Schema.decodeUnknownSync(Info)({ memory: { team: true } }),
  }),
])

// Writes `name` into the team memory folder of the Location's project, last changed `days` ago, and reads it back.
const readTeam = (name: string, text: string, days: number) =>
  Effect.gen(function* () {
    const location = yield* Location.Service
    yield* Effect.promise(() =>
      fs.mkdir(path.join(location.project.directory, ".orbit", "team-memory"), { recursive: true }),
    )
    return yield* readAged(path.join(".orbit", "team-memory", name), text, days, false)
  })

describe("a Read of a team memory file", () => {
  team.live("starts with a note naming the age of a team memory older than a day", () =>
    Effect.gen(function* () {
      const text = yield* readTeam("old-team.md", "OLD-TEAM-BODY\n", 47)
      const outside = yield* readAged("outside-team.md", "OUTSIDE-BODY\n", 47, false)
      expect(text.startsWith("<system-reminder>\n")).toBe(true)
      expect(text.slice(0, text.indexOf("</system-reminder>"))).toContain("47 days")
      expect(text.indexOf("OLD-TEAM-BODY")).toBeGreaterThan(text.indexOf("</system-reminder>"))
      expect(outside).not.toContain("<system-reminder>")
    }),
  )
})
