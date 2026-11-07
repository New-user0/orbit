import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols/openai-chat"
import { TestLLM } from "@orbit/ai/testing"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNodePlatform } from "@orbit/core/effect/app-node-platform"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Model } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("Review complete", "review") })
// Every folder is trusted, as the core tests run, unless a test builds the stack for a folder that is not.
const stack = (trusted: boolean) =>
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(LayerNode.group([Session.node, LocationServiceMap.node, Global.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      Watcher.node.replace(Watcher.configured({ enabled: false })),
      LayerNodePlatform.llmClient.replace(llmLayer),
      ...(trusted ? [] : [WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false }))]),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: (session) =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: session.model?.id ?? "parent", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  )
const it = testEffect(stack(true))
const untrusted = testEffect(stack(false))

const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })

describe("command subagents", () => {
  for (const fixture of [
    {
      name: "native JSON",
      format: "json",
      command: { subagent: true, agent: "build", model: "test/override" },
      agent: "build",
      model: "override",
    },
    {
      name: "legacy Markdown",
      format: "markdown",
      command: { subtask: true, agent: "build" },
      agent: "build",
      model: "parent",
    },
    {
      name: "subagent mode by default",
      format: "json",
      command: { agent: "reviewer" },
      agent: "reviewer",
      model: "child",
    },
  ] as const) {
    it.live(`runs ${fixture.name} in the background without switching the parent`, () =>
      Effect.gen(function* () {
        const parent = yield* project(fixture.command, fixture.format)
        const sessions = yield* Session.Service
        const llm = yield* TestLLM.Test
        const gate = yield* llm.gate()

        // This must return while the child's model is still blocked.
        yield* sessions.command({ sessionID: parent.id, command: "review", text: "changes" })
        yield* gate.started
        const children = (yield* sessions.list({ parentID: parent.id })).data
        expect(children).toHaveLength(1)
        const child = children[0]
        if (!child) return yield* Effect.die("Expected a child session")
        expect(child).toMatchObject({ agent: fixture.agent, model: { id: fixture.model }, title: "Review code" })
        expect(yield* sessions.get(parent.id)).toMatchObject({ agent: "build", model: parentModel })
        expect(yield* sessions.context(parent.id)).toEqual([])
        expect(yield* llm.requests()).toHaveLength(1)
        expect((yield* sessions.context(child.id)).filter((message) => message.type === "user")).toMatchObject([
          { text: "Review changes: ready" },
        ])
        yield* gate.release
        yield* llm.wait(2)
        yield* sessions.wait(parent.id)
        const notices = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
        expect(notices).toMatchObject([{ metadata: { source: "subagent", childID: child.id, state: "completed" } }])
        expect(notices[0]?.text).toContain("Review complete")
      }),
    )
  }

  // The keyword boosts the turn that a person's own prompt starts. A command run in the thread is that prompt; a
  // command run as a subagent hands its text to a child as a prompt the harness wrote.
  for (const fixture of [
    { name: "runs in the thread", subagent: false },
    { name: "runs as a subagent", subagent: true },
  ] as const)
    it.live(`a command that ${fixture.name} and holds the effort keyword puts the note in the right session`, () =>
      Effect.gen(function* () {
        const parent = yield* project(
          { subagent: fixture.subagent, template: "Think hard, ultrathink: $ARGUMENTS" },
          "json",
        )
        const sessions = yield* Session.Service
        const llm = yield* TestLLM.Test
        yield* sessions.command({ sessionID: parent.id, command: "review", text: "changes" })
        yield* llm.wait(1)
        yield* sessions.wait(parent.id)
        const children = (yield* sessions.list({ parentID: parent.id })).data
        expect(children).toHaveLength(fixture.subagent ? 1 : 0)
        const effort = (messages: unknown) =>
          JSON.stringify(messages).split("asked for a high level of reasoning effort").length - 1
        const child = children[0]
        if (child) yield* sessions.wait(child.id)
        const requests = yield* llm.requests()
        // The first request is the child's when the command forks, and the thread's otherwise.
        expect(effort(requests[0]?.messages)).toBe(fixture.subagent ? 0 : 1)
      }),
    )

  it.live("subagent: false overrides subagent mode and the legacy alias", () =>
    Effect.gen(function* () {
      const parent = yield* project({ subagent: false, subtask: true, agent: "reviewer" }, "json")
      const sessions = yield* Session.Service
      yield* sessions.command({ sessionID: parent.id, command: "review", text: "changes" })
      yield* sessions.wait(parent.id)
      expect((yield* sessions.list({ parentID: parent.id })).data).toEqual([])
      expect(yield* sessions.get(parent.id)).toMatchObject({
        agent: "reviewer",
        model: { id: "child" },
      })
      expect((yield* sessions.context(parent.id)).filter((message) => message.type === "user")).toMatchObject([
        { text: "Review changes: ready" },
      ])
    }),
  )
})

// An agent's own rules come after the user's and win, so which agent a command runs as is a choice between sets of
// rules, which a folder that is not trusted does not get to make. Since trust-first a folder that is not trusted has no
// commands at all, because none of its files are read. The user's config asks before every edit, and has an agent that
// allows them.
describe("the agent of a command from a folder that is not trusted", () => {
  const folders = [{ name: "a trusted folder", harness: it, agent: "autopilot", child: "autopilot" }] as const

  for (const folder of folders)
    folder.harness.live(`runs a command file in ${folder.name} as ${folder.agent}`, () =>
      Effect.gen(function* () {
        const parent = yield* setup(["agent: autopilot"])
        const sessions = yield* Session.Service
        yield* sessions.command({ sessionID: parent.id, command: "setup", text: "" })
        yield* sessions.wait(parent.id)
        expect(yield* sessions.get(parent.id)).toMatchObject({ agent: folder.agent })
        expect((yield* sessions.list({ parentID: parent.id })).data).toEqual([])
        expect((yield* sessions.context(parent.id)).filter((message) => message.type === "user")).toMatchObject([
          { text: "Set up the project" },
        ])
      }),
    )

  for (const folder of folders)
    folder.harness.live(`runs a command's subtask in ${folder.name} as ${folder.child}`, () =>
      Effect.gen(function* () {
        const parent = yield* setup(["agent: autopilot", "subtask: true"])
        const sessions = yield* Session.Service
        const llm = yield* TestLLM.Test
        yield* sessions.command({ sessionID: parent.id, command: "setup", text: "" })
        yield* llm.wait(1)
        const children = (yield* sessions.list({ parentID: parent.id })).data
        expect(children.map((child) => child.agent)).toEqual([Agent.ID.make(folder.child)])
        expect(yield* sessions.get(parent.id)).toMatchObject({ agent: "build" })
      }),
    )

  // Neither a command file nor a command of the folder's `orbit.json` exists while the folder is not trusted, so neither
  // runs, as any agent.
  untrusted.live("finds no command of a folder that is not trusted, from a file or from its config", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      for (const parent of [
        yield* setup(["agent: autopilot"]),
        yield* setup([], { commands: { setup: { template: "Set up the project", agent: "autopilot" } } }),
      ]) {
        const ran = yield* sessions.command({ sessionID: parent.id, command: "setup", text: "" }).pipe(Effect.exit)
        expect(Exit.isFailure(ran)).toBe(true)
        expect(yield* sessions.get(parent.id)).toMatchObject({ agent: "build" })
        expect((yield* sessions.list({ parentID: parent.id })).data).toEqual([])
      }
    }),
  )
})

// A project with `setup` as a command file that has the given front matter, and a session of the build agent. The user's
// own config asks before every edit and defines `autopilot`, which allows them.
function setup(frontmatter: string[], settings: Record<string, unknown> = {}) {
  return Effect.gen(function* () {
    const global = yield* Global.Service
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(async () => {
      await Bun.write(
        path.join(global.config, "orbit.json"),
        JSON.stringify({
          permissions: [{ action: "edit", resource: "*", effect: "ask" }],
          agents: { autopilot: { permissions: [{ action: "edit", resource: "*", effect: "allow" }] } },
        }),
      )
      await Bun.write(path.join(tmp.path, "orbit.json"), JSON.stringify(settings))
      if (frontmatter.length > 0)
        await Bun.write(
          path.join(tmp.path, ".orbit/commands/setup.md"),
          ["---", "description: Set up", ...frontmatter, "---", "Set up the project"].join("\n"),
        )
    })
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "Parent session",
      agent: Agent.ID.make("build"),
      model: parentModel,
    })
  })
}

function project(
  command: { agent?: string; model?: string; subagent?: boolean; subtask?: boolean; template?: string },
  format: "json" | "markdown",
) {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const definition = { description: "Review code", template: "Review $ARGUMENTS: !`printf ready`", ...command }
    yield* Effect.promise(() =>
      Bun.write(
        path.join(tmp.path, "orbit.json"),
        JSON.stringify({
          agents: { reviewer: { mode: "subagent", model: "test/child" } },
          ...(format === "markdown" ? {} : { commands: { review: definition } }),
        }),
      ),
    )
    if (format === "markdown")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tmp.path, ".orbit/commands/review.md"),
          [
            "---",
            "description: Review code",
            ...Object.entries(command).map(([key, value]) => `${key}: ${value}`),
            "---",
            definition.template,
          ].join("\n"),
        ),
      )
    const sessions = yield* Session.Service
    return yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      title: "Parent session",
      agent: Agent.ID.make("build"),
      model: parentModel,
    })
  })
}
