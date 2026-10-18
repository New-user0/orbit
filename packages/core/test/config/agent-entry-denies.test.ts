import { describe, expect } from "bun:test"
import fsp from "fs/promises"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { Agent } from "@orbit/core/agent"
import { LegacyAgent } from "@orbit/core/config/legacy-agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { Directory, Document, Info, type Entry } from "@orbit/schema/config"
import { Schema } from "effect"
import { ConfigAgentPlugin } from "@orbit/core/config/plugin/agent"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { AgentPlugin } from "@orbit/core/plugin/agent"
import { PlanMode } from "@orbit/core/plan-mode"
import { AbsolutePath } from "@orbit/core/schema"
import { tmpdirScoped } from "../fixture/tmpdir"
import { trustedProject } from "../fixture/project-trust"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node, ManagedPolicy.node])),
    trustedProject,
  ),
)

const directoryEntry = (directory: string): Entry =>
  new Directory({ type: "directory", path: AbsolutePath.make(directory), scope: "project" })

// The directory as config reports it while the folder that holds it is not trusted.
const untrustedEntry = (directory: string): Entry =>
  ConfigTrust.stamp(new Directory({ type: "directory", path: AbsolutePath.make(directory), scope: "project" }), {
    roots: [directory],
    directory,
  })

const decodeInfo = Schema.decodeUnknownSync(Info)

// The way an orbit.json is read: normalized first, then decoded.
const jsonDocument = (input: unknown) => {
  const result = ConfigNormalize.normalize(input)
  if (result.type !== "normalized") throw new Error("expected normalized config")
  return new Document({ type: "document", scope: "project", info: decodeInfo(result.encoded) })
}

// Mutation: with the per-entry decode removed (the whole tools map, permission object or permissions list dropped
// on one bad entry, or a deny list replaced by an untrusted document), every row below that is not a control fails.
const md = (front: string, body = "Body.") => `---\n${front}\n---\n${body}`

/**
 * Builds the agents that Orbit ships, then a Plan agent with the rules Plan mode puts on it, then the config. `entries`
 * is given the folder that `files` were written into. The result is the agent service.
 */
function load(files: Record<string, string>, entries?: (directory: string) => Entry[]) {
  return loadWithBaseline(files, entries).pipe(Effect.map((result) => result.agents))
}

function loadWithBaseline(
  files: Record<string, string>,
  entries: (directory: string) => Entry[] = (directory) => [directoryEntry(directory)],
) {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(() =>
      Promise.all(
        Object.entries(files).map(async ([name, content]) => {
          const file = path.join(tmp.path, name)
          await fsp.mkdir(path.dirname(file), { recursive: true })
          await fsp.writeFile(file, content)
        }),
      ),
    )
    const agents = yield* Agent.Service
    yield* AgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))
    yield* agents.transform((editor) =>
      editor.update(PlanMode.agent, (item) => {
        item.mode = "primary"
        item.system = "Built-in plan prompt"
        item.permissions.push(Agent.modeRule({ action: "Edit", resource: "*", effect: "deny" as const }))
        item.permissions.push({ action: "Bash", resource: "*", effect: "ask" })
      }),
    )
    const before = structuredClone(yield* agents.list())
    yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
      Effect.provide(Config.testLayer(entries(tmp.path))),
    )
    return { agents, before }
  })
}

const get = (agents: Agent.Interface, id: string) => agents.get(Agent.ID.make(id))

const loadOne = (front: string, entries?: (directory: string) => Entry[]) =>
  Effect.gen(function* () {
    const agents = yield* load({ "agents/a.md": md(front) }, entries)
    const agent = yield* get(agents, "a")
    if (!agent) throw new Error("expected the agent a")
    return agent
  })

describe("one bad entry in an agent costs only itself, so the denies beside it hold", () => {
  it.live("markdown file keeps the shell deny beside a typo", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("description: x\ntools:\n  shell: false\n  edit: ask")
      expect(Permission.evaluate("shell", "*", agent.permissions).effect).toBe("deny")
    }),
  )
  it.live("a trusted agents/build.md replaces build and keeps the shell deny beside a typo", () =>
    Effect.gen(function* () {
      const agents = yield* load({ "agents/build.md": md("description: x\ntools:\n  shell: false\n  edit: ask") })
      const agent = yield* get(agents, "build")
      expect(Permission.evaluate("shell", "*", agent!.permissions).effect).toBe("deny")
    }),
  )
  it.live("orbit.json entry keeps the shell deny beside a typo", () =>
    Effect.gen(function* () {
      const document = jsonDocument({ agents: { a: { description: "x", tools: { shell: false, edit: "ask" } } } })
      const agents = yield* load({}, () => [document])
      const agent = yield* get(agents, "a")
      expect(agent).toBeDefined()
      expect(Permission.evaluate("shell", "*", agent!.permissions).effect).toBe("deny")
    }),
  )
  it.live("markdown permissions list keeps its deny beside one bad rule", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne(
        [
          "description: x",
          "permissions:",
          "  - action: shell",
          "    resource: '*'",
          "    effect: deny",
          "  - action: edit",
          "    resource: '*'",
          "    effect: maybe",
        ].join("\n"),
      )
      expect(Permission.evaluate("shell", "*", agent.permissions).effect).toBe("deny")
    }),
  )
  it.live("control: orbit.json permissions list keeps its deny beside one bad rule", () =>
    Effect.gen(function* () {
      const document = jsonDocument({
        agents: {
          a: {
            description: "x",
            permissions: [
              { action: "shell", resource: "*", effect: "deny" },
              { action: "edit", resource: "*", effect: "maybe" },
            ],
          },
        },
      })
      const agents = yield* load({}, () => [document])
      const agent = yield* get(agents, "a")
      expect(Permission.evaluate("shell", "*", agent!.permissions).effect).toBe("deny")
    }),
  )
  it.live("an untrusted project's empty disallowed_tools does not clear the person's own deny list", () =>
    Effect.gen(function* () {
      const user = new Document({
        ...jsonDocument({ agents: { build: { disallowed_tools: ["shell"] } } }),
        scope: "user",
      })
      const project = ConfigTrust.stamp(jsonDocument({ agents: { build: { disallowed_tools: [] } } }), {
        roots: ["/nowhere"],
        directory: "/nowhere",
      })
      const agents = yield* load({}, () => [user, project])
      const agent = yield* get(agents, "build")
      expect(agent?.tools?.deny).toEqual(["shell"])
    }),
  )
  it.live("a trusted project overlay may still replace the deny list", () =>
    Effect.gen(function* () {
      const user = new Document({
        ...jsonDocument({ agents: { build: { disallowed_tools: ["shell"] } } }),
        scope: "user",
      })
      const project = jsonDocument({ agents: { build: { disallowed_tools: ["webfetch"] } } })
      const agents = yield* load({}, () => [user, project])
      expect((yield* get(agents, "build"))?.tools?.deny).toEqual(["webfetch"])
    }),
  )
  it.live("an untrusted project adds to the person's deny list", () =>
    Effect.gen(function* () {
      const user = new Document({
        ...jsonDocument({ agents: { build: { disallowed_tools: ["shell"] } } }),
        scope: "user",
      })
      const project = ConfigTrust.stamp(jsonDocument({ agents: { build: { disallowed_tools: ["webfetch"] } } }), {
        roots: ["/nowhere"],
        directory: "/nowhere",
      })
      const agents = yield* load({}, () => [user, project])
      expect((yield* get(agents, "build"))?.tools?.deny).toEqual(["shell", "webfetch"])
    }),
  )
  it.live("markdown legacy permission object keeps its deny beside one bad value", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("description: x\ntemperature: 0.5\npermission:\n  bash: deny\n  edit: maybe")
      expect(Permission.evaluate("shell", "*", agent.permissions).effect).toBe("deny")
    }),
  )
  it.live("control: markdown legacy permission object without a bad value keeps its deny", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("description: x\ntemperature: 0.5\npermission:\n  bash: deny\n  edit: ask")
      expect(Permission.evaluate("shell", "*", agent.permissions).effect).toBe("deny")
    }),
  )
  it.live("control: a clean map keeps the shell deny", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("description: x\ntools:\n  shell: false\n  edit: true")
      expect(Permission.evaluate("shell", "*", agent.permissions).effect).toBe("deny")
    }),
  )
})
