import { describe, expect, spyOn } from "bun:test"
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
    {
      front: "mcp_servers: [github, 42, {a: {type: local, command: [x]}, b: {type: local, command: [y]}}]",
      mcpServers: ["github"],
    },
  ] as const) {
    it.live(`reads ${item.front.replaceAll("\n", " and ")} and keeps the agent`, () =>
      Effect.gen(function* () {
        const agent = yield* loadOne(`description: kept\n${item.front}`)
        expect(agent.description).toBe("kept")
        const expected = { steps: undefined, effort: undefined, background: undefined, memory: undefined, ...item }
        const { front: _front, ...fields } = expected
        for (const [key, value] of Object.entries(fields))
          expect([key, agent[key as keyof typeof agent]]).toEqual([key, value])
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
      expect(other).toMatchObject({
        description: "Same",
        steps: 3,
        tools: { allow: ["read", "grep"] },
        system: "Prompt.",
      })
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
      const agent = yield* loadOne(
        "disallowedTools: shell\nmaxTurns: 3\npermissionMode: plan\nmcpServers: [x]\ninitialPrompt: hi\ndescription: kept",
      )
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

  it.live("keeps Explore's other context switch off when a trusted document turns one back on", () =>
    Effect.gen(function* () {
      const builtIn = yield* load({})
      expect((yield* get(builtIn, "explore"))?.context).toEqual({ instructions: false, git_status: false })
      expect((yield* get(builtIn, "general"))?.context).toBeUndefined()

      const agents = yield* load({}, () => [jsonDocument({ agents: { explore: { context: { instructions: true } } } })])

      expect((yield* get(agents, "explore"))?.context).toEqual({ instructions: true, git_status: false })
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
      expect(Permission.evaluate("Edit", "x.ts", (yield* get(agents, "explore"))?.permissions ?? []).effect).toBe(
        "deny",
      )
    }),
  )

  // Class 8 and 14: the guard at "defines && untrusted && exists" holds a whole definition file back, not only the
  // text fields the `held` rule also blocks. These keys pass `held`, so only the guard keeps them off a shipped agent.
  // Mutation: comment out that guard in config/plugin/agent.ts and the first row fails (build gains background, color,
  // git_status false and an edit deny).
  const tuning = md(
    ["background: true", 'color: "#ff0000"', "disallowed_tools: Read", "context:", "  git_status: false", "tools:", "  edit: false"].join("\n"),
    "",
  )

  // Both spellings of the folder are definitions. Mutation: change `AgentFile.defines` to `/^(?:agents)$/` and the agent/
  // rows fail (build keeps the tuning), while the agents/ rows and the trusted controls still pass.
  for (const folder of ["agent", "agents"]) {
    it.live(`holds a definition file in ${folder}/ back whole when it names a shipped agent, whatever keys it carries`, () =>
      Effect.gen(function* () {
        const { agents, before } = yield* loadWithBaseline(
          { [`${folder}/build.md`]: tuning, [`${folder}/explore.md`]: tuning },
          (directory) => [untrustedEntry(directory)],
        )
        for (const id of ["build", "explore"]) expect(yield* get(agents, id)).toEqual(before.find((agent) => agent.id === id))
      }),
    )

    it.live(`applies the same file in ${folder}/ in a trusted folder, as the control`, () =>
      Effect.gen(function* () {
        const { agents, before } = yield* loadWithBaseline({ [`${folder}/build.md`]: tuning })
        const agent = yield* get(agents, "build")
        expect(agent).not.toEqual(before.find((item) => item.id === "build"))
        expect(agent).toMatchObject({ background: true, color: "#ff0000" })
      }),
    )
  }

  it.live("applies the same keys from modes/, where an untrusted file only tunes", () =>
    Effect.gen(function* () {
      const { agents, before } = yield* loadWithBaseline({ "modes/build.md": tuning }, (directory) => [
        untrustedEntry(directory),
      ])
      expect(yield* get(agents, "build")).not.toEqual(before.find((item) => item.id === "build"))
    }),
  )

  // Class 7: the line for held-back text goes to the configured logger, once per entry, and not to the console.
  // Mutation: switch the call back to Effect.runSync and the row sees no line in the logger (and one on the console).
  it.live("logs one line for held-back entry text to the configured logger", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const consoleLog = spyOn(console, "log").mockImplementation(() => {})
      yield* Effect.addFinalizer(() => Effect.sync(() => consoleLog.mockRestore()))
      yield* loadWithBaseline({}, (directory) => [
        ConfigTrust.stamp(jsonDocument({ agents: { build: { system: "REPO TEXT", description: "Mine" } } }), {
          roots: [directory],
          directory,
        }),
      ]).pipe(Effect.provide(logged(logs)))
      expect(logs.filter((line) => line.includes("held back"))).toHaveLength(1)
      expect(consoleLog).not.toHaveBeenCalled()
    }),
  )

  // Class 8: `context.instructions: false` would hide the user's own instruction files, so a folder that is not trusted
  // cannot set it, and a `true` of either key would replace the person's own `false`; only `git_status: false` stays. Columns: where the key comes from.
  const switchOff = { context: { instructions: false, git_status: false } }
  const unstamped = (directory: string) => ConfigTrust.stamp(jsonDocument({ agents: { build: switchOff, fresh: switchOff } }), {
    roots: [directory],
    directory,
  })

  it.live("drops the instruction switch of an agent in orbit.json, a new agent included, and keeps the git one", () =>
    Effect.gen(function* () {
      const agents = yield* load({}, (directory) => [unstamped(directory)])
      for (const id of ["build", "fresh"]) expect([id, (yield* get(agents, id))?.context]).toEqual([id, { git_status: false }])
      // Explore ships with both off; an untrusted document adds nothing to it and removes nothing.
      expect((yield* get(agents, "explore"))?.context).toEqual({ instructions: false, git_status: false })
    }),
  )

  it.live("drops it from an agent file in an untrusted directory", () =>
    Effect.gen(function* () {
      const agents = yield* load({ "agents/fresh.md": md("context:\n  instructions: false\n  git_status: false") }, (directory) => [
        untrustedEntry(directory),
      ])
      expect((yield* get(agents, "fresh"))?.context).toEqual({ git_status: false })
    }),
  )

  it.live("keeps it when the document is trusted, as the control", () =>
    Effect.gen(function* () {
      const agents = yield* load({}, () => [jsonDocument({ agents: { build: switchOff } })])
      expect((yield* get(agents, "build"))?.context).toEqual({ instructions: false, git_status: false })
    }),
  )

  // Class 8: the later document wins, so a `true` from an untrusted one would replace a `false` that the person (or
  // Explore's default, to spare tokens) set.
  it.live("keeps Explore's default and the person's own false over an untrusted document's true", () =>
    Effect.gen(function* () {
      const agents = yield* load({}, (directory) => [
        // Class 8 control: the person's own document, unstamped.
        jsonDocument({ agents: { build: { context: { instructions: false, git_status: false } } } }),
        ConfigTrust.stamp(
          jsonDocument({
            agents: {
              explore: { context: { instructions: true, git_status: true } },
              build: { context: { instructions: true, git_status: true } },
            },
          }),
          { roots: [directory], directory },
        ),
      ])
      expect((yield* get(agents, "explore"))?.context).toEqual({ instructions: false, git_status: false })
      expect((yield* get(agents, "build"))?.context).toEqual({ instructions: false, git_status: false })
    }),
  )

  it.live("replaces the same agents when the folder is trusted", () =>
    Effect.gen(function* () {
      const agents = yield* load(files)
      for (const id of ["explore", "build"])
        expect(yield* get(agents, id)).toMatchObject({ system: "FILE PROMPT", description: "Mine" })
      expect(Permission.evaluate("Edit", "x.ts", (yield* get(agents, "explore"))?.permissions ?? []).effect).toBe(
        "allow",
      )
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
      for (const key of [
        "model",
        "modelTier",
        "effort",
        "steps",
        "permissionMode",
        "mcpServers",
        "skills",
        "memory",
        "isolation",
        "hooks",
      ]) {
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

describe("agent definition: native keys beside a tools map", () => {
  const webfetch = "tools:\n  webfetch: false"
  // Every native key, in the Markdown spelling and the orbit.json one, with what the agent must hold afterwards.
  const rows: {
    key: string
    yaml: string
    json: unknown
    check: (agent: Agent.Info) => void
  }[] = [
    {
      key: "permissions",
      yaml: "permissions:\n  - action: Bash\n    resource: '*'\n    effect: deny",
      json: [{ action: "Bash", resource: "*", effect: "deny" }],
      check: (agent) => expect(Permission.evaluate("Bash", "x", agent.permissions).effect).toBe("deny"),
    },
    {
      key: "disallowed_tools",
      yaml: "disallowed_tools: shell",
      json: "shell",
      check: (agent) => expect(agent.tools?.deny).toEqual(["shell"]),
    },
    {
      key: "hooks",
      yaml: "hooks:\n  SessionStart:\n    - hooks:\n        - type: command\n          command: echo hi",
      json: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      check: (agent) => expect(agent.hooks?.SessionStart?.[0]?.hooks[0]).toMatchObject({ command: "echo hi" }),
    },
    {
      key: "mcp_servers",
      yaml: "mcp_servers:\n  - github",
      json: ["github"],
      check: (agent) => expect(agent.mcpServers).toEqual(["github"]),
    },
    {
      key: "skills",
      yaml: "skills: review",
      json: "review",
      check: (agent) => expect(agent.skills).toEqual(["review"]),
    },
    { key: "memory", yaml: "memory: project", json: "project", check: (agent) => expect(agent.memory).toBe("project") },
    { key: "effort", yaml: "effort: high", json: "high", check: (agent) => expect<unknown>(agent.effort).toBe("high") },
    { key: "max_turns", yaml: "max_turns: 4", json: 4, check: (agent) => expect(agent.steps).toBe(4) },
    {
      key: "initial_prompt",
      yaml: "initial_prompt: Start here",
      json: "Start here",
      check: (agent) => expect(agent.initialPrompt).toBe("Start here"),
    },
    {
      key: "context",
      yaml: "context:\n  git_status: false",
      json: { git_status: false },
      check: (agent) => expect(agent.context).toEqual({ git_status: false }),
    },
    {
      key: "permission_mode",
      yaml: "permission_mode: plan",
      json: "plan",
      check: (agent) => expect(agent.permissionMode).toBe("plan"),
    },
    { key: "background", yaml: "background: true", json: true, check: (agent) => expect(agent.background).toBe(true) },
    {
      key: "isolation",
      yaml: "isolation: worktree",
      json: "worktree",
      check: (agent) => expect(agent.isolation).toBe("worktree"),
    },
    {
      key: "request",
      yaml: "request:\n  body:\n    seed: 1",
      json: { body: { seed: 1 } },
      check: (agent) => expect(agent.request.body).toEqual({ seed: 1 }),
    },
  ]

  for (const row of rows) {
    it.live(`keeps ${row.key} beside a tools map in a Markdown file`, () =>
      Effect.gen(function* () {
        const agent = yield* loadOne(`${webfetch}\n${row.yaml}`)
        row.check(agent)
        expect(Permission.evaluate("webfetch", "x", agent.permissions).effect).toBe("deny")
        // Only `request` may put anything in the request body.
        expect(agent.request.body).toEqual(row.key === "request" ? { seed: 1 } : {})
      }),
    )

    it.live(`keeps ${row.key} beside a tools map in orbit.json`, () =>
      Effect.gen(function* () {
        const input = { agents: { a: { tools: { webfetch: false }, [row.key]: row.json } } }
        const result = ConfigNormalize.normalize(input)
        if (result.type !== "normalized") throw new Error("expected normalized config")
        expect(result.diagnostics).toEqual([])
        const agents = yield* load({}, () => [jsonDocument(input)])
        const agent = yield* get(agents, "a")
        if (!agent) throw new Error("expected the agent a")
        row.check(agent)
        expect(Permission.evaluate("webfetch", "x", agent.permissions).effect).toBe("deny")
        expect(agent.request.body).toEqual(row.key === "request" ? { seed: 1 } : {})
      }),
    )
  }

  it.live("keeps the body as the prompt when the front matter also has a prompt", () =>
    Effect.gen(function* () {
      const agents = yield* load({ "agents/a.md": md(`${webfetch}\nprompt: Front`) })
      const agent = yield* get(agents, "a")
      expect(agent?.system).toBe("Body.")
    }),
  )

  it.effect("does not take a name inherited from Object.prototype for a foreign key", () =>
    Effect.sync(() => expect(LegacyAgent.prepare({ constructor: 1, toString: 2 }).notes).toEqual([])),
  )

  it.live("still sends a key that neither schema knows to the request body", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne(`${webfetch}\ntemperature: 0.2`)
      expect(agent.request.body).toEqual({ temperature: 0.2 })
    }),
  )
})

describe("agent definition: a bad field beside a tools map", () => {
  const deny = [{ action: "Bash", resource: "*", effect: "deny" }]
  const denyYaml = "permissions:\n  - action: Bash\n    resource: '*'\n    effect: deny"
  // The shared keys and the legacy-only ones that fail, and the models that must survive; each sits beside a tools map
  // and a Bash deny, which must stay in every cell, in both doors.
  const rows: { name: string; key: string; at?: string; yaml: string; json: unknown; model?: unknown }[] = [
    { name: "steps of zero", key: "steps", yaml: "steps: 0", json: 0 },
    { name: "a temperature that is no number", key: "temperature", yaml: "temperature: warm", json: "warm" },
    {
      name: "a tool value that is no boolean",
      key: "tools",
      at: "tools.webfetch",
      yaml: "tools:\n  webfetch: maybe",
      json: { webfetch: "maybe" },
    },
    {
      name: "a valid structured model",
      key: "model",
      yaml: "model:\n  providerID: acme\n  model: big",
      json: { providerID: "acme", model: "big" },
      model: { providerID: "acme", id: "big" },
    },
    {
      name: "a model with a variant in its name",
      key: "model",
      yaml: "model: acme/big#high",
      json: "acme/big#high",
      model: { providerID: "acme", id: "big", variant: "high" },
    },
  ]
  const bad = (row: (typeof rows)[number]) => row.model === undefined

  for (const row of rows) {
    it.live(`keeps the Bash deny beside ${row.name} in a Markdown file`, () =>
      Effect.gen(function* () {
        const logs: string[] = []
        const front = `${row.key === "tools" ? "" : "tools:\n  webfetch: false\n"}${row.yaml}\n${denyYaml}`
        const agent = yield* loadOne(front).pipe(Effect.provide(logged(logs)))
        expect(Permission.evaluate("Bash", "x", agent.permissions).effect).toBe("deny")
        if (row.model) expect(agent.model).toMatchObject(row.model)
        if (bad(row)) expect(logs.some((line) => line.includes(`"${row.at ?? row.key}"`))).toBe(true)
      }),
    )

    it.live(`keeps the Bash deny beside ${row.name} in orbit.json`, () =>
      Effect.gen(function* () {
        const tools = row.key === "tools" ? row.json : { webfetch: false }
        const input = {
          agents: { a: { tools, permissions: deny, ...(row.key === "tools" ? {} : { [row.key]: row.json }) } },
        }
        const result = ConfigNormalize.normalize(input)
        if (result.type !== "normalized") throw new Error("expected normalized config")
        // The bad field is reported at its own path and nothing else is.
        expect(result.diagnostics.map((item) => item.path.join("."))).toEqual(bad(row) ? [`agents.a.${row.at ?? row.key}`] : [])
        const agent = yield* get(yield* load({}, () => [jsonDocument(input)]), "a")
        if (!agent) throw new Error("expected the agent a")
        expect(Permission.evaluate("Bash", "x", agent.permissions).effect).toBe("deny")
        if (row.model) expect(agent.model).toMatchObject(row.model)
      }),
    )
  }

  it.live("puts a native rule after the one migrated from a tools map", () =>
    Effect.gen(function* () {
      const markdown = yield* loadOne(
        "tools:\n  webfetch: false\npermissions:\n  - action: webfetch\n    resource: '*'\n    effect: allow",
      )
      expect(Permission.evaluate("webfetch", "x", markdown.permissions).effect).toBe("allow")
      const input = {
        agents: {
          a: { tools: { webfetch: false }, permissions: [{ action: "webfetch", resource: "*", effect: "allow" }] },
        },
      }
      const agent = yield* get(yield* load({}, () => [jsonDocument(input)]), "a")
      expect(agent && Permission.evaluate("webfetch", "x", agent.permissions).effect).toBe("allow")
    }),
  )

  it.live("merges a legacy temperature with a native request body", () =>
    Effect.gen(function* () {
      const markdown = yield* loadOne("tools:\n  webfetch: false\ntemperature: 0.2\nrequest:\n  body:\n    seed: 1")
      expect(markdown.request.body).toEqual({ temperature: 0.2, seed: 1 })
      const input = { agents: { a: { tools: { webfetch: false }, temperature: 0.2, request: { body: { seed: 1 } } } } }
      const agent = yield* get(yield* load({}, () => [jsonDocument(input)]), "a")
      expect(agent?.request.body).toEqual({ temperature: 0.2, seed: 1 })
    }),
  )
})

describe("agent definition: keys written for another product in orbit.json", () => {
  const foreign = {
    disallowedTools: "shell",
    maxTurns: 3,
    permissionMode: "plan",
    mcpServers: ["x"],
    initialPrompt: "hi",
  }
  const entries = [
    { name: "an entry with a tools map", entry: { tools: { webfetch: false }, ...foreign } },
    { name: "an entry without one", entry: { description: "x", ...foreign } },
  ]
  for (const item of entries)
    it.live(`reports each key once and keeps it out of the request in ${item.name}`, () =>
      Effect.gen(function* () {
        const input = { agents: { a: item.entry } }
        const result = ConfigNormalize.normalize(input)
        if (result.type !== "normalized") throw new Error("expected normalized config")
        expect(result.diagnostics.map((diagnostic) => diagnostic.path.join(".")).toSorted()).toEqual(
          Object.keys(foreign)
            .map((key) => `agents.a.${key}`)
            .toSorted(),
        )
        expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes('"disallowed_tools"'))).toBe(true)
        const agent = yield* get(yield* load({}, () => [jsonDocument(input)]), "a")
        expect(agent?.request.body).toEqual({})
        expect(agent?.tools).toBeUndefined()
      }),
    )
})

describe("agent definition: a variant beside a model tier", () => {
  it.live("uses it as the effort in a Markdown file", () =>
    Effect.gen(function* () {
      expect<unknown>((yield* loadOne("model: small\nvariant: high")).effort).toBe("high")
    }),
  )

  it.live("uses it as the effort in orbit.json, with a tools map or without", () =>
    Effect.gen(function* () {
      for (const entry of [
        { model: "small", variant: "high" },
        { tools: { webfetch: false }, model: "small", variant: "high" },
      ]) {
        const input = { agents: { a: entry } }
        const agent = yield* get(yield* load({}, () => [jsonDocument(input)]), "a")
        expect<unknown>(agent?.effort).toBe("high")
      }
    }),
  )

  it.live("says so when a variant that is no string is ignored", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const agent = yield* loadOne("model: small\nvariant: 3").pipe(Effect.provide(logged(logs)))
      expect<unknown>(agent.effort).toBeUndefined()
      expect(logs.some((line) => line.includes("ignored it"))).toBe(true)
    }),
  )
})

const logged = (logs: string[]) =>
  Logger.layer([
    Logger.make(({ message }) => {
      logs.push(String(message))
    }),
  ])

describe("agent definition: a file shaped for another product", () => {
  it.live("loads a file with a name and a tools string", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne('name: a\ndescription: Reads\ntools: "read, grep"')
      expect(agent.tools?.allow).toEqual(["read", "grep"])
      expect(agent.request.body).toEqual({})
    }),
  )

  it.live("loads a file with a name and a tools list", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("name: a\ndescription: Reads\ntools: [read, grep]")
      expect(agent.tools?.allow).toEqual(["read", "grep"])
    }),
  )

  it.live("keeps disallowed_tools, skills and memory beside a name", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("name: a\ndisallowed_tools: shell\nskills: review\nmemory: user")
      expect(agent).toMatchObject({ tools: { deny: ["shell"] }, skills: ["review"], memory: "user" })
      expect(agent.request.body).toEqual({})
    }),
  )

  it.live("keeps a tools list beside a key that only the legacy format knows", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("tools: [read]\ntemperature: 0.3")
      expect(agent.tools?.allow).toEqual(["read"])
      expect(agent.request.body).toEqual({ temperature: 0.3 })
    }),
  )

  it.live("says so when a name differs from the path", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      yield* loadOne("name: other\ndescription: x").pipe(Effect.provide(logged(logs)))
      expect(logs.some((line) => line.includes('ignored "name"'))).toBe(true)
    }),
  )

  it.live("keeps a legacy file whose legacy fields are all invalid, and reports each", () =>
    Effect.gen(function* () {
      const logs: string[] = []
      const agents = yield* load({
        "agents/a.md": md("temperature: warm\ndescription: x\ntools:\n  edit: maybe"),
      }).pipe(Effect.provide(logged(logs)))
      expect((yield* get(agents, "a"))?.description).toBe("x")
      expect(logs.filter((line) => line.includes("dropped the invalid")).length).toBe(2)
    }),
  )

  it.live("keeps a model tier beside a variant, as the tier and an effort", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("model: small\nvariant: high")
      expect(agent.modelTier).toBe("small")
      expect<unknown>(agent.effort).toBe("high")
    }),
  )

  it.live("keeps a given effort over the variant of a tier", () =>
    Effect.gen(function* () {
      const agent = yield* loadOne("model: large\nvariant: high\neffort: low")
      expect(agent).toMatchObject({ modelTier: "large", effort: "low" })
    }),
  )
})
