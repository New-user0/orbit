import { describe, expect } from "bun:test"
import fsp from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Agent } from "@orbit/core/agent"
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

// One file, agents/a.md, with this front matter.
const loadOne = (front: string, entries?: (directory: string) => Entry[]) =>
  Effect.gen(function* () {
    const agents = yield* load({ "agents/a.md": md(front) }, entries)
    const agent = yield* get(agents, "a")
    if (!agent) throw new Error("expected the agent a")
    return agent
  })

describe("agent definition: native files", () => {
  it.live("decodes a file that uses every new key, and records where it came from", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne(
        [
          "description: Checks things",
          "model: example/chat#high",
          "effort: medium",
          'tools: "read, grep"',
          'disallowed_tools: "shell"',
          "permission_mode: accept-edits",
          "mcp_servers:",
          "  - github",
          "  - local:",
          "      type: local",
          "      command: [node, server.js]",
          "hooks:",
          "  SessionStart:",
          "    - hooks:",
          "        - type: command",
          "          command: echo hi",
          "max_turns: 7",
          'skills: "review, deploy"',
          'initial_prompt: "Look at the diff first."',
          "memory: project",
          "background: true",
          "isolation: worktree",
          "context:",
          "  instructions: false",
          "  git_status: false",
        ].join("\n"),
      )
      expect(agent).toMatchObject({
        description: "Checks things",
        model: { providerID: "example", id: "chat", variant: "high" },
        effort: "medium",
        tools: { allow: ["read", "grep"], deny: ["shell"] },
        permissionMode: "accept-edits",
        mcpServers: ["github", { local: { type: "local", command: ["node", "server.js"] } }],
        steps: 7,
        skills: ["review", "deploy"],
        initialPrompt: "Look at the diff first.",
        memory: "project",
        background: true,
        isolation: "worktree",
        context: { instructions: false, git_status: false },
        source: { scope: "project" },
      })
      expect(agent.hooks?.SessionStart?.[0]?.hooks[0]).toMatchObject({ type: "command", command: "echo hi" })
      expect(agent.source?.path).toEndWith(path.join("agents", "a.md"))
    }),
  )

  for (const item of [
    { name: "absent", front: "description: x", allow: undefined },
    { name: "an empty string", front: 'tools: ""', allow: [] },
    { name: "an empty list", front: "tools: []", allow: [] },
    { name: "null", front: "tools:", allow: [] },
    { name: "a star", front: 'tools: "*"', allow: undefined },
    { name: "a star among others", front: 'tools: "read, *"', allow: undefined },
    { name: "commas", front: 'tools: "read, grep"', allow: ["read", "grep"] },
    { name: "spaces", front: 'tools: "read grep"', allow: ["read", "grep"] },
    { name: "a list", front: 'tools: ["read", "grep"]', allow: ["read", "grep"] },
    {
      name: "a space inside parentheses",
      front: 'tools: "shell(git status:*) read"',
      allow: ["shell(git status:*)", "read"],
    },
    { name: "a list with a number", front: 'tools: [1, "read"]', allow: ["read"] },
  ]) {
    it.live(`reads a tools list written as ${item.name}`, () =>
      Effect.gen(function* () {
        const agent = yield* loadOne(item.front)
        expect(agent.tools?.allow).toEqual(item.allow)
      }),
    )
  }

  it.live("reads a star in the deny list as every tool, never as nothing", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne('disallowed_tools: "*"')
      expect(agent.tools?.deny).toEqual(["*"])
    }),
  )

  for (const item of [
    { model: '" Inherit "', tier: "inherit" },
    { model: '"SMALL"', tier: "small" },
    { model: "large", tier: "large" },
    { model: "example/chat#high", selection: { providerID: "example", id: "chat", variant: "high" } },
    { model: "fast" },
    { model: "default" },
    { model: "sonnet" },
    { model: '"not a model"' },
  ]) {
    it.live(`reads the model ${item.model}`, () =>
      Effect.gen(function* () {
        // The agent loads whatever the model says; a value that is neither a model nor a tier is dropped.
        const agent = yield* loadOne(`description: kept\nmodel: ${item.model}`)
        expect(agent.description).toBe("kept")
        expect<unknown>(agent.modelTier).toBe(item.tier)
        if (item.selection === undefined) expect(agent.model).toBeUndefined()
        else expect(agent.model).toMatchObject(item.selection)
      }),
    )
  }

  for (const item of [
    { front: "effort: high", effort: "high" },
    { front: "effort: 3", effort: undefined },
    { front: 'effort: "a#b"', effort: undefined },
    { front: "max_turns: 5", steps: 5 },
    { front: 'max_turns: "5"', steps: 5 },
    { front: "max_turns: 0", steps: undefined },
    { front: "max_turns: -1", steps: undefined },
    { front: 'max_turns: "x"', steps: undefined },
    { front: "steps: 3\nmax_turns: 5", steps: 3 },
    { front: "background: true", background: true },
    { front: 'background: "true"', background: true },
    { front: "background: false", background: undefined },
    { front: 'background: "false"', background: undefined },
    { front: 'background: "yes"', background: undefined },
    { front: "memory: local", memory: "local" },
    { front: "memory: global", memory: undefined },
    { front: "isolation: remote", isolation: undefined },
    { front: "isolation: worktree", isolation: "worktree" },
    { front: 'initial_prompt: "   "', initialPrompt: undefined },
    { front: 'initial_prompt: " hi "', initialPrompt: " hi " },
    { front: "hooks: nonsense", hooks: undefined },
    { front: "permission_mode: nonsense", permissionMode: undefined },
    { front: "mcp_servers: github", mcpServers: undefined },
    { front: "mcp_servers: [github, 42, {a: {type: local, command: [x]}, b: {type: local, command: [y]}}]", mcpServers: ["github"] },
  ] as const) {
    it.live(`reads ${item.front.replaceAll("\n", " and ")} and keeps the agent`, () =>
      Effect.gen(function* () {
        const agent = yield* loadOne(`description: kept\n${item.front}`)
        expect(agent.description).toBe("kept")
        const expected = { steps: undefined, effort: undefined, background: undefined, memory: undefined, ...item }
        const { front: _front, ...fields } = expected
        for (const [key, value] of Object.entries(fields)) expect([key, agent[key as keyof typeof agent]]).toEqual([key, value])
      }),
    )
  }

  it.live("drops a field with a bad value and keeps the rest of the file", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("description: kept\ncolor: warning\nsteps: 4")
      expect(agent).toMatchObject({ description: "kept", steps: 4, system: "Body." })
      expect(agent.color).toBeUndefined()
    }),
  )

  it.live("reads a file with CRLF line endings and a byte-order mark as the plain one", () =>
    Effect.gen(function* () {
      const plain = md('description: Same\ntools: "read, grep"\nmax_turns: 3', "Prompt.")
      const agents = yield* load({
        "agents/plain.md": plain,
        "agents/crlf.md": "﻿" + plain.replaceAll("\n", "\r\n"),
      })
      const one = yield* get(agents, "plain")
      const other = yield* get(agents, "crlf")
      expect(other).toMatchObject({ description: "Same", steps: 3, tools: { allow: ["read", "grep"] }, system: "Prompt." })
      expect(other?.description).toBe(one?.description)
    }),
  )

  it.live("turns backslash-n in a description into a line break", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne('description: "First\\nSecond"')
      expect(agent.description).toBe("First\nSecond")
    }),
  )

  it.live("does not send another product's spellings to the provider", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("disallowedTools: shell\nmaxTurns: 3\npermissionMode: plan\nmcpServers: [x]\ninitialPrompt: hi\ndescription: kept")
      expect(agent.description).toBe("kept")
      expect(agent.request.body).toEqual({})
      expect(agent.tools).toBeUndefined()
      expect(agent.steps).toBeUndefined()
      expect(agent.permissionMode).toBeUndefined()
    }),
  )

  it.live("keeps the legacy deny rule for a tools map", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("tools:\n  edit: false")
      expect(Permission.evaluate("edit", "x.ts", agent.permissions).effect).toBe("deny")
      expect(agent.tools).toBeUndefined()
    }),
  )

  it.live("gives a file without a mode all, a file under modes primary", () =>
    Effect.gen(function* () {
      const agents = yield* load({
        "agents/free.md": md("description: x"),
        "agents/sub.md": md("mode: subagent"),
        "modes/main.md": md("description: x"),
      })
      expect((yield* get(agents, "free"))?.mode).toBe("all")
      expect((yield* get(agents, "sub"))?.mode).toBe("subagent")
      expect((yield* get(agents, "main"))?.mode).toBe("primary")
    }),
  )
})

describe("agent definition: replacement", () => {
  it.live("replaces an existing agent without inheriting its rules, built-ins included", () =>
    Effect.gen(function* () {
      const agents = yield* load({
        "agents/explore.md": md("description: Mine", "Replacement prompt."),
        "agents/build.md": md("description: Mine"),
      })
      for (const id of ["explore", "build"]) {
        const agent = yield* get(agents, id)
        expect(agent?.description).toBe("Mine")
        expect(agent?.hidden).toBe(false)
      }
      const explore = yield* get(agents, "explore")
      expect(explore?.system).toBe("Replacement prompt.")
      // The built-in explore denies every tool but the reading ones; nothing of that survives.
      expect(Permission.evaluate("Edit", "x.ts", explore?.permissions ?? []).effect).toBe("allow")
    }),
  )

  it.live("gives a replaced hidden system agent exactly what the file says", () =>
    Effect.gen(function* () {
      const agents = yield* load({ "agents/title.md": md("description: Mine") })
      const title = yield* get(agents, "title")
      expect(title).toMatchObject({ description: "Mine" })
      expect(title?.hidden).toBe(false)
    }),
  )

  const overlay = (description: string) =>
    new Document({ type: "document", scope: "project", info: decodeInfo({ agents: { explore: { description } } }) })

  it.live("tunes a built-in with an orbit.json overlay and keeps its rules", () =>
    Effect.gen(function* () {
      const agents = yield* load({}, () => [overlay("Tuned")])
      const explore = yield* get(agents, "explore")
      expect(explore?.description).toBe("Tuned")
      expect(Permission.evaluate("Edit", "x.ts", explore?.permissions ?? []).effect).toBe("deny")
    }),
  )

  it.live("lets an overlay that comes after a replacing file tune the file's agent", () =>
    Effect.gen(function* () {
      const agents = yield* load({ "agents/explore.md": md("steps: 2", "File prompt.") }, (directory) => [
        directoryEntry(directory),
        overlay("Later"),
      ])
      expect(yield* get(agents, "explore")).toMatchObject({ steps: 2, system: "File prompt.", description: "Later" })
    }),
  )

  it.live("drops an overlay that came before a replacing file with the definition it tuned", () =>
    Effect.gen(function* () {
      const agents = yield* load({ "agents/explore.md": md("steps: 2", "File prompt.") }, (directory) => [
        overlay("Earlier"),
        directoryEntry(directory),
      ])
      expect(yield* get(agents, "explore")).toMatchObject({ steps: 2, system: "File prompt." })
      expect((yield* get(agents, "explore"))?.description).toBeUndefined()
    }),
  )

  for (const file of ["modes/plan.md", "agents/plan.md"]) {
    it.live(`keeps the limits of Plan mode when ${file} defines the plan agent`, () =>
      Effect.gen(function* () {
        const agents = yield* load({ [file]: md("description: Mine", "My plan prompt.") })
        const plan = yield* get(agents, "plan")
        expect(plan).toMatchObject({ description: "Mine", system: "My plan prompt.", mode: "primary" })
        expect(Permission.evaluate("Edit", "x.ts", plan?.permissions ?? []).effect).toBe("deny")
        expect(Permission.evaluate("Bash", "ls", plan?.permissions ?? []).effect).toBe("ask")
      }),
    )
  }

  it.live("lets orbit.json create an agent and records the document as its source", () =>
    Effect.gen(function* () {
      const document = jsonDocument({ agents: { mine: { description: "From json", max_turns: 4, model: "small" } } })
      const agents = yield* load({}, () => [document])
      expect(yield* get(agents, "mine")).toMatchObject({ description: "From json", steps: 4, modelTier: "small" })
      expect((yield* get(agents, "mine"))?.source).toEqual({ scope: "project" })
    }),
  )
})

describe("agent definition: an untrusted folder", () => {
  const files = {
    "agents/explore.md": md("description: Mine", "FILE PROMPT"),
    "agents/build.md": md("description: Mine", "FILE PROMPT"),
  }

  it.live("leaves a shipped agent exactly as it was", () =>
    Effect.gen(function* () {
      const { agents, before } = yield* loadWithBaseline(files, (directory) => [untrustedEntry(directory)])
      for (const id of ["explore", "build"]) {
        // Prompt, description and rules are all the shipped agent's own.
        expect(yield* get(agents, id)).toEqual(before.find((agent) => agent.id === id))
      }
      expect(Permission.evaluate("Edit", "x.ts", (yield* get(agents, "explore"))?.permissions ?? []).effect).toBe("deny")
    }),
  )

  it.live("replaces the same agents when the folder is trusted", () =>
    Effect.gen(function* () {
      const agents = yield* load(files)
      for (const id of ["explore", "build"]) expect(yield* get(agents, id)).toMatchObject({ system: "FILE PROMPT", description: "Mine" })
      expect(Permission.evaluate("Edit", "x.ts", (yield* get(agents, "explore"))?.permissions ?? []).effect).toBe("allow")
    }),
  )

  it.live("lets an untrusted file define a new agent cut down to what is inert", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne(
        [
          "description: Mine",
          "context:\n  git_status: false",
          "background: true",
          'disallowed_tools: "shell"',
          'initial_prompt: "check the tests"',
          "model: example/chat",
          "effort: high",
          "max_turns: 4",
          'tools: "read"',
          "permission_mode: bypass",
          "mcp_servers: [github]",
          'skills: "x"',
          "memory: user",
          "isolation: worktree",
          "mode: all",
          "hooks:\n  SessionStart:\n    - hooks:\n        - type: command\n          command: echo hi",
        ].join("\n"),
        (directory) => [untrustedEntry(directory)],
      )
      expect(agent).toMatchObject({
        system: "Body.",
        description: "Mine",
        context: { git_status: false },
        background: true,
        tools: { deny: ["shell"] },
        initialPrompt: "check the tests",
        mode: "primary",
      })
      for (const key of ["model", "modelTier", "effort", "steps", "permissionMode", "mcpServers", "skills", "memory", "isolation", "hooks"]) {
        expect([key, (agent as Record<string, unknown>)[key]]).toEqual([key, undefined])
      }
      expect(agent.tools?.allow).toBeUndefined()
    }),
  )

  it.live("withholds an initial prompt that starts with a slash command", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne('initial_prompt: "/deploy now"', (directory) => [untrustedEntry(directory)])
      expect(agent.initialPrompt).toBeUndefined()
    }),
  )
})

describe("agent definition: names", () => {
  const bad = [
    "agents/...md", // the id ..
    "agents/.hidden.md",
    "agents/foo..md",
    "agents/team/.x.md",
    // Windows cannot create files by these device names.
    ...(process.platform === "win32" ? [] : ["agents/nul.md", "agents/con.txt.md"]),
  ]
  for (const name of bad) {
    it.live(`defines no agent for ${name}, and a sibling still loads`, () =>
      Effect.gen(function* () {
        const agents = yield* load({ [name]: md("description: bad"), "agents/ok.md": md("description: ok") })
        const ids = (yield* agents.list()).map((agent) => agent.id)
        expect(ids).toContain(Agent.ID.make("ok"))
        expect((yield* agents.list()).filter((agent) => agent.description === "bad")).toEqual([])
      }),
    )
  }

  it.live("still loads a nested name", () =>
    Effect.gen(function* () {
      const agents = yield* load({ "agents/team/helper.md": md("description: nested") })
      expect(yield* get(agents, "team/helper")).toMatchObject({ description: "nested" })
    }),
  )
})
