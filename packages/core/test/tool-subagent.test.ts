import { describe, expect } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { TestLLM } from "@orbit/ai/testing"
import path from "path"
import { Money } from "@orbit/schema/money"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNodePlatform } from "@orbit/core/effect/app-node-platform"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { makeGlobalNode, makeLocationNode } from "@orbit/util/effect/app-node"
import { Database } from "@orbit/core/database/database"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Location } from "@orbit/core/location"
import { Model } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Agent } from "@orbit/core/agent"
import { Job } from "@orbit/core/job"
import { KV } from "@orbit/core/kv"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionRestart } from "@orbit/core/session/execution/restart"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionStore } from "@orbit/core/session/store"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Permission } from "@orbit/core/permission"
import { AgentInstructions } from "@orbit/core/agent/instructions"
import { SubagentTool } from "@orbit/core/tool/plugin/subagent"
import { ShellTool } from "@orbit/core/tool/plugin/shell"
import { Shell } from "@orbit/core/shell"
import { ShellSelect } from "@orbit/core/shell/select"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ProjectTrust } from "@orbit/core/project-trust"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { FSUtil } from "@orbit/util/fs-util"
import { filesystem } from "@orbit/util/effect/app-node-platform"
import { WorkflowTool } from "@orbit/core/tool/plugin/workflow"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Tool } from "@orbit/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity, toolTraits } from "./lib/tool"

const childText = "child final response"
const completedOutput = (sessionID: Session.ID) =>
  `<subagent sessionID="${sessionID}" state="completed">\n${childText}\n</subagent>`
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const overrideModel = Model.Ref.make({
  id: Model.ID.make("override"),
  providerID: Provider.ID.make("test"),
  variant: Model.VariantID.make("fast"),
})
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        if ((yield* store.get(sessionID))?.title?.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: childText,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const subagentPluginSupervisor = makeLocationNode({
  name: "test/subagent-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      // The session hooks are wired for real, so a hook these plugins register reaches the request.
      const session: Partial<Context["session"]> = {
        hook: (name, callback) => hooks.register("session", name, callback),
      }
      yield* registerToolPlugin(SubagentTool.Plugin, { session }, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(WorkflowTool.Plugin, { session }, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [Agent.node, Config.node, Model.node, Permission.node, Session.node, Job.node, Tool.node, PluginHooks.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(subagentPluginSupervisor)]),
)
const completionIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, SessionRestart.node, KV.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PluginSupervisor.node.replace(subagentPluginSupervisor),
    LayerNodePlatform.llmClient.replace(TestLLM.testLayer({ fallback: TestLLM.text(childText, "completion") })),
    SessionRunnerModel.node.replace(
      Layer.succeed(SessionRunnerModel.Service, {
        resolve: () =>
          Effect.succeed(
            SessionRunnerModel.resolved(
              LanguageModel.make({ id: "child", provider: "test", route: OpenAIChat.route }),
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

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
    yield* Provider.Service.use((providers) =>
      providers.transform((editor) => {
        editor.models.update(overrideModel.providerID, overrideModel.id, (model) => {
          model.variants = [{ id: Model.VariantID.make("fast") }]
        })
        editor.models.update(Provider.ID.make("test"), Model.ID.make("plain"), () => {})
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        editor.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        editor.update(Agent.ID.make("primary"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("SubagentTool", () => {
  completionIt.live("admits one durable completion across live delivery and restart replay", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: parentModel,
            title: "Completion recipient",
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          expect(yield* toolTraits(registry, "Agent")).toMatchObject({
            readOnly: false,
            concurrencySafe: true,
            interruptBehavior: "block",
          })
          expect(yield* toolTraits(registry, "Workflow")).toMatchObject({
            readOnly: false,
            concurrencySafe: false,
            interruptBehavior: "block",
          })
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const admitted = yield* Deferred.make<Job.Background>()
          const notifications: SessionMessage.ID[] = []
          yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
            Effect.gen(function* () {
              if (event.data.sessionID !== parent.id || event.data.item.type !== "synthetic") return
              notifications.push(event.data.inboxID)
              const marker = (yield* jobs.pendingBackground).find((job) => job.notificationID === event.data.inboxID)
              // The marker must survive until admission commits, not merely until delivery starts.
              expect(marker?.status).toBe("completed")
              if (marker) yield* Deferred.succeed(admitted, marker)
            }),
          )

          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-completion-replay",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review", background: true },
            },
          })
          const marker = yield* Deferred.await(admitted)
          yield* jobs.pendingBackground.pipe(Effect.repeat({ until: (pending) => pending.length === 0 }))
          yield* sessions.wait(parent.id)
          const messages = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(messages).toEqual([
            expect.objectContaining({
              id: marker.notificationID,
              description: "background review",
              text: `<subagent sessionID="${outputSessionID(result.metadata)}" state="completed" description="background review">\n${childText}\n</subagent>`,
              metadata: {
                source: "subagent",
                childID: outputSessionID(result.metadata),
                agent: "reviewer",
                state: "completed",
              },
            }),
          ])

          // Reproduce a crash after admission but before acknowledgment using the real persisted marker.
          const kv = yield* KV.Service
          yield* kv.set(`job.background/${marker.notificationID}`, marker)
          const restart = yield* SessionRestart.Service
          yield* restart.resumeSuspendedSessions
          yield* sessions.wait(parent.id)
          expect(notifications).toEqual([marker.notificationID])
          expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toEqual(
            messages,
          )
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )

  for (const count of [0, 1, 5])
    it.live(`sends the static Agent and Workflow descriptions after the session hooks with ${count} startable agents`, () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const session = yield* (yield* Session.Service).create({
              location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            })
            yield* withSubagent(session.location)
            const locations = yield* LocationServiceMap.Service
            yield* Agent.Service.use((agents) =>
              agents.transform((editor) => {
                for (let index = 0; index < count; index++)
                  editor.update(Agent.ID.make(`helper${index}`), (agent) => {
                    agent.mode = "subagent"
                    agent.description = `Helper number ${index}`
                  })
              }),
            ).pipe(Effect.provide(locations.get(session.location)))
            const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(session.location)))
            // The hook event is the request about to be sent; a hook that adds the list changes these descriptions.
            for (const name of ["context", "compaction", "generate"] as const) {
              const event = {
                sessionID: session.id,
                agent: toolIdentity.agent,
                model: parentModel,
                system: [],
                messages: [],
                tools: {
                  [SubagentTool.name]: { description: SubagentTool.description, input: { type: "object" } },
                  [WorkflowTool.name]: { description: WorkflowTool.description, input: { type: "object" } },
                },
                options: {},
              }
              yield* hooks.trigger("session", name, event as never)
              expect(event.tools[SubagentTool.name].description).toBe(SubagentTool.description)
              expect(event.tools[WorkflowTool.name].description).toBe(WorkflowTool.description)
              expect(JSON.stringify(event.tools)).not.toContain("Helper number")
            }
          }),
        ),
      ),
    )

  productionIt.live("registers globally while resolving agents from the caller location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location })
          yield* withSubagent(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          expect((yield* registry.snapshot()).definitions.map((tool) => tool.name)).toContain(SubagentTool.name)
          // The agent list lives in `core/agent-guidance`: the definitions are the static module text, whatever agents exist.
          const definitions = (yield* registry.snapshot()).definitions
          expect(definitions.find((tool) => tool.name === SubagentTool.name)?.description).toBe(SubagentTool.description)
          expect(definitions.find((tool) => tool.name === WorkflowTool.name)?.description).toBe(WorkflowTool.description)
          expect(SubagentTool.description).toContain("roster of startable agents")
          expect(SubagentTool.name).toBe(AgentInstructions.NAME)
          expect(
            definitions
              .filter((tool) => tool.name === SubagentTool.name || tool.name === WorkflowTool.name)
              .map((tool) => tool.description)
              .join("\n"),
          ).not.toContain("- reviewer")
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-primary",
                name: SubagentTool.name,
                input: { agent: "primary", description: "primary", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: { type: "tool.execution", message: "Agent primary cannot run as a subagent" },
          })
        }),
      ),
    ),
  )

  it.live("prevents subagents from launching subagents by default", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent" })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-nested-subagent",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("Subagent depth limit reached (1)"),
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  // A block of a later document hides only the keys it sets: the depth stands past a block about another key.
  for (const [name, local] of [
    ["allows nested subagents up to the configured depth", undefined],
    ["keeps the configured depth past a later block about another key", { experimental: { allow_local_fetch: false } }],
  ] as const)
  it.live(name, () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "orbit.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          if (local)
            yield* Effect.promise(() => Bun.write(path.join(dir.path, "orbit.local.json"), JSON.stringify(local)))
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-configured-nested-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "nested", prompt: "should run" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining(childText) }],
          })
          expect(settled.metadata).toEqual({
            sessionID: outputSessionID(settled.metadata),
            status: "completed",
          })
          expect((yield* sessions.get(outputSessionID(settled.metadata))).parentID).toBe(parent.id)
        }),
      ),
    ),
  )

  it.live("runs a foreground child session and returns the final assistant text", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const progress: Tool.Metadata[] = []

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            progress: (update) => Effect.sync(() => progress.push(update)),
            call: {
              type: "tool-call",
              id: "call-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this", model: "", sessionID: "" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining(childText) }],
          })
          const child = yield* sessions.get(outputSessionID(settled.metadata))
          expect(settled.content).toEqual([{ type: "text", text: completedOutput(child.id) }])
          expect(settled.metadata).toEqual({ sessionID: child.id, status: "completed" })
          expect(progress[0]).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "review this",
          )
          // The parent agent's words are marked, so a steer into the child is framed as the agent's, not the person's.
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.metadata).toEqual(
            { origin: "agent" },
          )

          const fallback = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-fallback",
              name: SubagentTool.name,
              input: { agent: "fallback", description: "fallback", prompt: "fallback" },
            },
          })
          const fallbackChild = yield* sessions.get(outputSessionID(fallback.metadata))
          expect(fallbackChild).toMatchObject({ parentID: parent.id, model: parentModel })
        }),
      ),
    ),
  )

  it.live("continues an existing child session", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-first",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-second",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue this",
                sessionID: childID,
                model: "",
              },
            },
          })

          expect(outputSessionID(second.metadata)).toBe(childID)
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect((yield* sessions.get(childID)).title).toBe("review")
          expect(
            (yield* sessions.inbox(childID)).flatMap((message) =>
              message.type === "user" ? [message.payload.text] : [],
            ),
          ).toEqual(["review this", "continue this"])
          expect(second.content).toEqual([{ type: "text", text: completedOutput(childID) }])
        }),
      ),
    ),
  )

  it.live("steers a running child session in the background", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          yield* jobs.start({ id: child.id, type: SubagentTool.name, run: Effect.never })

          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-running-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue while running",
                sessionID: child.id,
                background: true,
              },
            },
          })

          expect(result).toMatchObject({
            status: "completed",
            metadata: { sessionID: child.id, status: "running" },
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "continue while running",
          )
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          yield* jobs.cancel(child.id)
        }),
      ),
    ),
  )

  it.live("rejects unrelated children and switches agents on continuation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const otherParent = yield* sessions.create({ location, model: parentModel })
          const unrelated = yield* sessions.create({
            parentID: otherParent.id,
            title: "other review",
            agent: Agent.ID.make("reviewer"),
          })
          const switched = yield* sessions.create({
            parentID: parent.id,
            title: "fallback review",
            agent: Agent.ID.make("fallback"),
            model: parentModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (sessionID: Session.ID, id: string, agent = "reviewer") =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent, description: "follow up", prompt: "continue", sessionID },
              },
            })

          const missing = Session.ID.create()
          expect(yield* call(missing, "call-missing-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session not found: ${missing}`,
            },
          })
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-malformed-child-id",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "follow up", prompt: "continue", sessionID: "placeholder" },
              },
            }),
          ).toMatchObject({
            status: "error",
            error: { message: expect.stringContaining('sessionID: Expected a string starting with "ses"') },
          })
          expect(yield* call(parent.id, "call-parent-id")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${parent.id} is not a child of the current session`,
            },
          })
          expect(yield* call(unrelated.id, "call-unrelated-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${unrelated.id} is not a child of the current session`,
            },
          })
          expect(yield* call(switched.id, "call-switched-child")).toMatchObject({
            status: "completed",
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "reviewer",
            model: childModel,
          })
          // Switching to an agent without a configured model keeps the child's current model.
          expect(yield* call(switched.id, "call-modelless-switch", "fallback")).toMatchObject({
            status: "completed",
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "fallback",
            model: childModel,
          })
        }),
      ),
    ),
  )

  it.live("runs the child on an explicitly requested model", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "review", prompt: "review this", ...input },
              },
            })

          // The requested model beats the agent's configured model.
          const spawned = yield* call("call-override", { model: "test/override#fast", sessionID: "" })
          expect(spawned).toMatchObject({ status: "completed", metadata: { status: "completed" } })
          const child = yield* sessions.get(outputSessionID(spawned.metadata))
          expect(child).toMatchObject({ agent: "reviewer", model: overrideModel })

          // Continuing with a model switches the existing child even when the agent is unchanged.
          const continued = yield* call("call-override-continue", { sessionID: child.id, model: "test/override" })
          expect(continued).toMatchObject({ status: "completed", metadata: { sessionID: child.id } })
          expect((yield* sessions.get(child.id)).model).toEqual({
            id: overrideModel.id,
            providerID: overrideModel.providerID,
            variant: Model.VariantID.make("default"),
          })

          const failures = [
            ["not-a-ref", 'Invalid model "not-a-ref". Use "providerID/modelID" or "providerID/modelID#variant".'],
            ["test/missing", 'Model "test/missing" is not available. Use the models tool to see what is available.'],
            ["test/override#slow", 'Variant "slow" is not available for "test/override". Available: fast.'],
            ["test/plain#high", 'Model "test/plain" has no variants. Omit the variant.'],
          ] as const
          for (const [model, message] of failures) {
            expect(yield* call(`call-${model}`, { model })).toEqual({
              status: "error",
              error: { type: "tool.execution", message },
            })
          }
        }),
      ),
    ),
  )

  it.live("returns child runner failures as tool errors", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-subagent-failure",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "fail review", prompt: "please fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("No model is available for session"),
            },
          })
        }),
      ),
    ),
  )

  it.live("notifies once when background work completes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-background-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review", background: true },
            },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toMatchObject({
            status: "running",
          })
          expect(settled.metadata).toEqual({ sessionID: childID, status: "running" })
          expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(`Session ${childID}`) }])
          expect(settled.content).toEqual([
            { type: "text", text: expect.stringContaining("Take on work the subagent is not covering") },
          ])

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("synthetic")
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission?.data.item.payload.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(admission?.data.item.payload).toMatchObject({
            description: "background review",
            metadata: {
              source: "subagent",
              childID,
              agent: "reviewer",
              state: "completed",
            },
          })
          const database = yield* Database.Service
          yield* SessionInbox.promote(database.db, bus, parent.id, "steer")
          const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(synthetic).toHaveLength(1)
          expect(synthetic[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(synthetic[0]?.text).toContain(childText)
        }),
      ),
    ),
  )
})

describe("SubagentTool in Plan mode", () => {
  const plan = Agent.ID.make("plan")

  /** A project whose orbit.json holds `config`, opened as a Location. */
  const inProject = <A, E, R>(config: unknown, body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.promise(() => Bun.write(path.join(dir.path, "orbit.json"), JSON.stringify(config))).pipe(
          Effect.andThen(body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    )

  /** Waits for the built-in plugins, so the real agents and tools exist, and returns the Location's tool registry. */
  const activate = (location: Location.Ref) =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
      return yield* Tool.Service.pipe(Effect.provide(locations.get(location)))
    })

  const call = (registry: Tool.Interface, sessionID: Session.ID, caller: Agent.ID, name: string, input: unknown) =>
    executeTool(registry, {
      sessionID,
      ...toolIdentity,
      agent: caller,
      call: { type: "tool-call", id: `call-${caller}-${name}`, name, input },
    })

  const spawn = (registry: Tool.Interface, sessionID: Session.ID, caller: Agent.ID, agent: string) =>
    call(registry, sessionID, caller, SubagentTool.name, { agent, description: `${agent} task`, prompt: "do the task" })

  const refusal = (allowed: string, agent: string) => ({
    status: "error" as const,
    error: {
      type: "permission.rejected",
      message: `Plan mode only allows read-only subagents: ${allowed}. Agent ${agent} cannot be spawned until Plan mode ends.`,
    },
  })

  productionIt.live("admits only read-only subagents", () =>
    inProject({}, (location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel, agent: plan })
        const registry = yield* activate(parent.location)

        expect(yield* spawn(registry, parent.id, plan, "general")).toEqual(refusal("explore", "general"))
        // Primary and unknown agents get the same answer, which tells the model what it may use instead.
        expect(yield* spawn(registry, parent.id, plan, "build")).toEqual(refusal("explore", "build"))
        expect(yield* spawn(registry, parent.id, plan, "missing")).toEqual(refusal("explore", "missing"))
        expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)

        const explored = yield* spawn(registry, parent.id, plan, "explore")
        expect(explored).toMatchObject({ status: "completed", metadata: { status: "completed" } })
        expect(yield* sessions.get(outputSessionID(explored.metadata))).toMatchObject({
          parentID: parent.id,
          agent: "explore",
        })
      }),
    ),
  )

  productionIt.live("keeps the limit when config grants every permission", () =>
    inProject({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }, (location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel, agent: plan })
        const registry = yield* activate(parent.location)
        const locations = yield* LocationServiceMap.Service
        const agents = yield* Agent.Service.pipe(Effect.provide(locations.get(parent.location)))
        const planAgent = yield* agents.get(plan)

        // The config rule lands after the Plan agent's own rules, so rules alone cannot hold the limit.
        expect(Permission.evaluate("edit", "src/index.ts", planAgent?.permissions ?? []).effect).toBe("allow")
        expect(yield* spawn(registry, parent.id, plan, "general")).toEqual(refusal("explore", "general"))
        expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        expect(yield* spawn(registry, parent.id, plan, "explore")).toMatchObject({ status: "completed" })
      }),
    ),
  )

  productionIt.live("changes nothing outside Plan mode", () =>
    inProject({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }, (location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel })
        const registry = yield* activate(parent.location)

        yield* Effect.forEach(["general", "explore"], (agent) =>
          Effect.gen(function* () {
            const spawned = yield* spawn(registry, parent.id, toolIdentity.agent, agent)
            expect(spawned).toMatchObject({ status: "completed", metadata: { status: "completed" } })
            expect(yield* sessions.get(outputSessionID(spawned.metadata))).toMatchObject({ agent })
          }),
        )
      }),
    ),
  )

  productionIt.live("also admits plan when its mode lets it run as a subagent", () =>
    inProject({ agents: { plan: { mode: "all" } } }, (location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel, agent: plan })
        const registry = yield* activate(parent.location)

        expect(yield* spawn(registry, parent.id, plan, "general")).toEqual(refusal("explore, plan", "general"))
        const planned = yield* spawn(registry, parent.id, plan, "plan")
        expect(planned).toMatchObject({ status: "completed", metadata: { status: "completed" } })
        expect(yield* sessions.get(outputSessionID(planned.metadata))).toMatchObject({ agent: "plan" })
      }),
    ),
  )

  productionIt.live("applies the same limit to workflow agents", () =>
    inProject({}, (location) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location, model: parentModel, agent: plan })
        const registry = yield* activate(parent.location)
        const run = (agent?: string) =>
          call(registry, parent.id, plan, "Workflow", {
            description: "plan workflow",
            script: `return await tools.agent({ description: "scan", prompt: "scan it"${agent ? `, agent: "${agent}"` : ""} })`,
          })

        // A workflow agent defaults to general, which Plan mode refuses.
        expect(yield* run()).toMatchObject({
          status: "error",
          error: { message: expect.stringContaining("Plan mode only allows read-only subagents: explore.") },
        })
        expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)

        expect(yield* run("explore")).toMatchObject({
          status: "completed",
          content: [{ type: "text", text: expect.stringContaining(childText) }],
        })
        // The brief is the child's first message, with nothing in front of it.
        const child = (yield* sessions.list({ parentID: parent.id })).data[0]
        expect((yield* sessions.inbox(child!.id)).find((message) => message.type === "user")?.payload.text).toBe(
          "scan it",
        )
        // A workflow agent's brief is the parent agent's words too, so it is marked like the Agent tool's.
        expect((yield* sessions.inbox(child!.id)).find((message) => message.type === "user")?.payload.metadata).toEqual({
          origin: "agent",
        })
      }),
    ),
    // A loaded Windows host needs more than the default limit.
    30_000,
  )

  // Class 13. A notice that one of the killed shells left waiting in the child's inbox is withdrawn; the control is a
  // notice of a shell that is not the child's, which stays. Fails without the inbox step: both notices stay.
  it.live(
    "withdraws a waiting notice of a shell killed when its run ends",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const child = yield* sessions.create({
              parentID: parent.id,
              title: "done",
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            })
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const shell = yield* Shell.Service.pipe(Effect.provide(locations.get(parent.location)))
            const childShell = yield* shell.create({
              shell: ShellSelect.resolve({ priority: "compat" }),
              command: process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60",
              timeout: 0,
              metadata: { sessionID: child.id },
            })
            const notice = (shellID: string) =>
              sessions.synthetic({
                sessionID: child.id,
                text: `<shell id="${shellID}" state="waiting">`,
                metadata: { source: "shell", shellID },
                resume: false,
              })
            yield* notice(childShell.id)
            yield* notice("sh_elsewhere")

            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-child-notice",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "done", prompt: "work", sessionID: child.id },
              },
            })

            yield* shell.wait(childShell.id).pipe(Effect.timeout(Duration.seconds(15)))
            const waiting = (yield* sessions.inbox(child.id)).flatMap((item) =>
              item.type === "synthetic" ? [String(item.payload.metadata?.shellID)] : [],
            )
            expect(waiting).toEqual(["sh_elsewhere"])
          }),
        ),
      ),
    30_000,
  )
})

// shell-safety-6 (FU-M3-152): when the run that an Agent call started ends, by completing, by failing or in the
// background, every shell the child session still has running is killed, and none of them reports back to the child.
// The parent's shell is the control: it keeps running.
describe("SubagentTool and the child's shells", () => {
  const idleCommand = process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60"

  const childShells = (input: { title: string; background: boolean }) =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const child = yield* sessions.create({
            parentID: parent.id,
            title: input.title,
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const shell = yield* Shell.Service.pipe(Effect.provide(locations.get(parent.location)))
          const selected = ShellSelect.resolve({ priority: "compat" })
          const start = (sessionID: Session.ID) =>
            shell.create({ shell: selected, command: idleCommand, timeout: 0, metadata: { sessionID } })
          const childShell = yield* start(child.id)
          const parentShell = yield* start(parent.id)

          yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-child-shells",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: input.title,
                prompt: "work",
                sessionID: child.id,
                ...(input.background ? { background: true } : {}),
              },
            },
          })

          // Fails on the base: nothing kills the child's shell, so the wait runs out.
          const ended = yield* shell.wait(childShell.id).pipe(Effect.timeout(Duration.seconds(15)))
          expect(ended.status).toBe("killed")
          expect((yield* shell.get(parentShell.id)).status).toBe("running")
          yield* shell.kill(parentShell.id)
        }),
      ),
    )

  it.live("kills the child's shells when its run ends: a foreground run", () => childShells({ title: "done", background: false }), 30_000)
  it.live("kills the child's shells when its run ends: a failed run", () => childShells({ title: "fail", background: false }), 30_000)
  it.live("kills the child's shells when its run ends: a background run", () => childShells({ title: "detached", background: true }), 30_000)

  // shell-safety-6: with background tasks off, a call that still asks for a background run gets the subagent's final
  // response, as a foreground call does. Fails when the flag is read whatever the setting: the call returns `running`.
  it.live(
    "runs a background request in the foreground when background tasks are off",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Bun.write(path.join(dir.path, "orbit.json"), JSON.stringify({ background_tasks: false })),
            )
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const settled = yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-background-off",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "review", prompt: "review", background: true },
              },
            })
            expect(settled.metadata).toMatchObject({ status: "completed" })
            expect(settled.content).toEqual([
              { type: "text", text: completedOutput(outputSessionID(settled.metadata)) },
            ])
          }),
        ),
      ),
    30_000,
  )
})

const shellSubagentSupervisor = makeLocationNode({
  name: "test/subagent-shell-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const session: Partial<Context["session"]> = {
        hook: (name, callback) => hooks.register("session", name, callback),
      }
      yield* registerToolPlugin(SubagentTool.Plugin, { session }, (name, callback) => hooks.register("tool", name, callback))
      yield* registerToolPlugin(ShellTool.Plugin, { session }, (name, callback) => hooks.register("tool", name, callback))
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    Tool.node,
    PluginHooks.node,
    Environment.node,
    FileAccess.node,
    FSUtil.node,
    Location.node,
    ManagedPolicy.node,
    ProjectTrust.node,
    Shell.node,
    ShellSelect.node,
    PowerShellParse.node,
  ],
})
const shellSubagentIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, filesystem, FSUtil.node, SdkPlugins.node, ManagedPolicy.node]), [
    ...replacements,
    PluginSupervisor.node.replace(shellSubagentSupervisor),
  ]),
)

describe("SubagentTool and the child's shell notifications", () => {
  // Fails on the base: the child's background command is not killed, so the wait runs out. Once it is killed, its
  // completion must not reach the child, whose run has ended and which nothing would read.
  shellSubagentIt.live(
    "drops the child's shell notifications when its run ends",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const sessions = yield* Session.Service
            const parent = yield* sessions.create({ location, model: parentModel })
            yield* withSubagent(parent.location)
            const child = yield* sessions.create({
              parentID: parent.id,
              title: "child",
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            })
            const locations = yield* LocationServiceMap.Service
            const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
            const shell = yield* Shell.Service.pipe(Effect.provide(locations.get(parent.location)))
            const bus = yield* Bus.Service
            const notified: string[] = []
            yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
              Stream.filter((event) => event.data.sessionID === child.id && event.data.item.type === "synthetic"),
              Stream.runForEach((event) =>
                Effect.sync(() => notified.push((event.data.item.payload as { text: string }).text)),
              ),
              Effect.forkScoped({ startImmediately: true }),
            )

            const started = yield* executeTool(registry, {
              sessionID: child.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-child-background-shell",
                name: "Bash",
                input: {
                  command: process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60",
                  run_in_background: true,
                },
              },
            })
            const shellID = started.status === "completed" ? started.metadata?.shellID : undefined
            if (typeof shellID !== "string") throw new Error("Expected a background shell")

            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-child-run",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "child", prompt: "work", sessionID: child.id },
              },
            })

            const ended = yield* shell.wait(Shell.ID.make(shellID)).pipe(Effect.timeout(Duration.seconds(15)))
            expect(ended.status).toBe("killed")
            yield* Effect.sleep(Duration.seconds(1))
            expect(notified.filter((text) => text.includes(`<shell id="${shellID}"`))).toEqual([])
          }),
        ),
      ),
    30_000,
  )
})
