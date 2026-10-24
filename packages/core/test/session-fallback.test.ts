import { expect } from "bun:test"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Agent } from "@orbit/core/agent"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instructions } from "@orbit/core/instructions/index"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { Model } from "@orbit/core/model"
import { Project } from "@orbit/core/project"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Tool } from "@orbit/core/tool"
import { Document, Info } from "@orbit/schema/config"
import { Effect, Layer, Logger, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { noMemory } from "./lib/memory"
import { noScratchpad } from "./lib/scratchpad"
import { noVcsSnapshot } from "./lib/vcs-snapshot"
import { stubSnapshot } from "./lib/tool"

const sessionID = SessionSchema.ID.make("ses_fallback_test")

// Every model is available except the one named "missing"; a session without a model gets "primary".
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) =>
    session.model?.id === "missing"
      ? Effect.fail(
          new SessionRunnerModel.ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          }),
        )
      : Effect.succeed(
          SessionRunnerModel.resolved(
            LanguageModel.make({
              id: session.model?.id ?? "primary",
              provider: session.model?.providerID ?? "test",
              route: OpenAIChat.route,
            }),
            {
              ...(session.model?.variant ? { variant: session.model.variant } : {}),
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: [],
              limit: { context: 200_000, output: 32_000 },
            },
          ),
        ),
})

const empty = Instructions.empty

// One instance, shared by the app and the test, so the test can change the entries the app reads.
const config = Config.testLayer()

const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(
      LayerNode.group([Database.node, Project.node, SessionStore.node, Agent.node, SessionContext.node]),
      [
        Config.node.replace(config),
        SessionRunnerModel.node.replace(models),
        InstructionBuiltIns.node.replace(
          Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(empty), preferences: () => Effect.succeed(empty) }),
        ),
        noScratchpad,
        noMemory,
        noVcsSnapshot,
        InstructionDiscovery.node.replace(
          Layer.mock(InstructionDiscovery.Service, { project: true, global: true, load: () => Effect.succeed(empty) }),
        ),
        SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(empty) })),
        ReferenceInstructions.node.replace(
          Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(empty) }),
        ),
        McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(empty) })),
        PluginSupervisor.node.replace(Layer.empty),
        Tool.node.replace(
          Layer.mock(Tool.Service, {
            snapshot: () =>
              Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
          }),
        ),
        Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      ],
    ),
  ),
)

const setup = (fallback: string | undefined) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const projects = yield* Project.Service
    const store = yield* SessionStore.Service
    const entries = yield* Config.Test
    yield* entries.setEntries(
      fallback === undefined
        ? []
        : [new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ fallback_model: fallback }) })],
    )
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: (yield* projects.resolve(AbsolutePath.make("/project"))).id,
        slug: "fallback-test",
        directory: "/project",
        title: "Fallback test",
        version: "test",
        agent: Agent.ID.make("build"),
      })
      .run()
      .pipe(Effect.orDie)
    const session = yield* store.get(sessionID)
    if (!session) return yield* Effect.die("Session fixture missing")
    return { session, context: yield* SessionContext.Service }
  })

it.effect("resolves the configured fallback model", () =>
  Effect.gen(function* () {
    const { session, context } = yield* setup("acme/backup#high")
    expect((yield* context.resolveFallback(session))?.ref).toEqual(Model.Ref.parse("acme/backup#high"))
  }),
)

it.effect("prefers a requested model over the configured one", () =>
  Effect.gen(function* () {
    const { session, context } = yield* setup("acme/backup")
    const requested = Model.Ref.parse("acme/requested")
    expect((yield* context.resolveFallback(session, requested))?.ref).toEqual(requested)
  }),
)

it.effect("returns nothing when no fallback is set", () =>
  Effect.gen(function* () {
    const { session, context } = yield* setup(undefined)
    expect(yield* context.resolveFallback(session)).toBeUndefined()
  }),
)

const logging = (logged: unknown[]) =>
  Effect.provideService(
    Logger.CurrentLoggers,
    new Set([Logger.make((entry) => logged.push(...[entry.message].flat()))]),
  )

it.effect("returns nothing for an unavailable model and logs one warning", () =>
  Effect.gen(function* () {
    const { session, context } = yield* setup("acme/missing")
    const logged: unknown[] = []
    expect(yield* context.resolveFallback(session).pipe(logging(logged))).toBeUndefined()
    expect(logged.filter((message) => message === "fallback model skipped")).toHaveLength(1)
  }),
)

it.effect("returns nothing for the model the session would default to", () =>
  Effect.gen(function* () {
    const { session, context } = yield* setup("test/primary#high")
    expect(session.model).toBeUndefined()
    expect(yield* context.resolveFallback(session)).toBeUndefined()
  }),
)

it.effect("returns nothing for the session's own model", () =>
  Effect.gen(function* () {
    const { session, context } = yield* setup("acme/backup")
    const logged: unknown[] = []
    expect(
      yield* context.resolveFallback({ ...session, model: Model.Ref.parse("acme/backup") }).pipe(logging(logged)),
    ).toBeUndefined()
    expect(logged).not.toContain("fallback model skipped")
  }),
)

it.effect("treats the session's own model as the same whatever the variant", () =>
  Effect.gen(function* () {
    const { session, context } = yield* setup("acme/backup#high")
    expect(yield* context.resolveFallback({ ...session, model: Model.Ref.parse("acme/backup#low") })).toBeUndefined()
  }),
)
