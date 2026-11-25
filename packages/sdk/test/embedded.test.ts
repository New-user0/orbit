import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { LanguageModel, LLMClient } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { TestLLM } from "@orbit/ai/testing"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { makeMemoryDriver } from "@orbit/core/environment/index"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { WorkspaceDriver } from "@orbit/core/workspace/driver"
import { Deferred, Effect, Fiber, Latch, Layer, Option, Schedule, Stream } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import type { OrbitEvent } from "../src/effect"

const it = testEffect(Layer.empty)
type Sdk = typeof import("../src/effect")
type Fixture = { readonly directory: string; readonly sdk: Sdk }

const withEmbedded = <A, E, R>(prefix: string, f: (fixture: Fixture) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(prefix)),
    (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((directory) =>
      Effect.promise(() => import("../src/effect")).pipe(
        Effect.flatMap((sdk) => f({ directory: directory.path, sdk })),
      ),
    ),
  )

const sessionID = (fixture: Fixture) => fixture.sdk.Session.ID.create()

const location = (fixture: Fixture) =>
  fixture.sdk.Location.Ref.make({ directory: fixture.sdk.AbsolutePath.make(fixture.directory) })

for (const selection of ["explicit", "default"] as const) {
  it.live(`generate.text uses configured providers with ${selection} model selection`, () =>
    withEmbedded("orbit-embedded-generate-", (fixture) =>
      Effect.gen(function* () {
        const llm = yield* TestLLM.Test.pipe(
          Effect.provide(TestLLM.testLayer({ fallback: TestLLM.text("ready", "answer") })),
        )
        const orbit = yield* fixture.sdk.Orbit.create(
          {
            config: {
              directory: fixture.directory,
              project: false,
              content: JSON.stringify({
                model: "custom/fictional-chat",
                providers: {
                  custom: {
                    package: "aisdk:@ai-sdk/openai-compatible",
                    settings: { baseURL: "https://provider.example/v1" },
                    models: { "fictional-chat": {} },
                  },
                },
              }),
            },
            models: { fetch: false },
            fs: { filewatcher: false },
            trust: { implicit: true },
          },
          {
            overrides: [llmClient.replace(Layer.succeed(LLMClient.Service, llm))],
          },
        )

        // model.list answers once the Location's plugins are active, so its first answer already holds the model.
        const listed = yield* orbit.model.list({ location: location(fixture) })
        expect(listed.data.some((model) => model.providerID === "custom" && model.id === "fictional-chat")).toBe(true)

        const result = yield* orbit.generate.text({
          prompt: "Say ready",
          ...(selection === "explicit"
            ? {
                model: fixture.sdk.Model.Ref.make({
                  providerID: fixture.sdk.Provider.ID.make("custom"),
                  id: fixture.sdk.Model.ID.make("fictional-chat"),
                }),
              }
            : {}),
        })

        expect(result.text).toBe("ready")
        const requests = yield* llm.requests()
        expect(requests).toHaveLength(1)
        expect(requests[0]?.model).toMatchObject({ provider: "custom", id: "fictional-chat" })
      }),
    ),
  )
}

it.live(
  "embedded client uses the real router and handlers",
  () =>
    withEmbedded("orbit-embedded-", (fixture) =>
      Effect.gen(function* () {
        const orbit = yield* fixture.sdk.Orbit.create({ events: { persist: true } , trust: { implicit: true } })
        const id = sessionID(fixture)
        const model = fixture.sdk.Model.Ref.make({
          id: fixture.sdk.Model.ID.make("embedded"),
          providerID: fixture.sdk.Provider.ID.make("test"),
        })

        const created = yield* orbit.sessions.create({
          id,
          agent: fixture.sdk.Agent.ID.make("build"),
          location: location(fixture),
        })
        yield* orbit.sessions.switchModel({ sessionID: id, model })
        const selected = yield* orbit.sessions.get({ sessionID: id })
        const page = yield* orbit.sessions.list({ directory: fixture.sdk.AbsolutePath.make(fixture.directory) })
        const active = yield* orbit.sessions.active()
        const admitted = yield* orbit.sessions.prompt({
          sessionID: id,
          text: "Do not run",
          resume: false,
        })
        const context = yield* orbit.sessions.context({ sessionID: id })
        const pendingAfterAdmit = yield* orbit.sessions.inbox.list({ sessionID: id })
        yield* orbit.sessions.instructions.entry.put({ sessionID: id, key: "deploy-target", value: "production" })
        yield* orbit.sessions.instructions.entry.put({ sessionID: id, key: "flags", value: { beta: true } })
        const contextEntries = yield* orbit.sessions.instructions.entry.list({ sessionID: id })
        yield* orbit.sessions.instructions.entry.remove({ sessionID: id, key: "flags" })
        const remainingContextEntries = yield* orbit.sessions.instructions.entry.list({ sessionID: id })
        const wake = yield* orbit.sessions.prompt({
          sessionID: id,
          text: "Promote this input",
        })
        const prompted = yield* orbit.sessions.log({ sessionID: id, follow: true }).pipe(
          Stream.filter((event) => event.type === "session.inbox.delivered" && event.data.inboxID === wake.id),
          Stream.runHead,
          Effect.timeout("10 seconds"),
          Effect.map(Option.getOrThrow),
        )
        const wakeContext = yield* orbit.sessions.context({ sessionID: id })
        const pendingAfterPromote = yield* orbit.sessions.inbox.list({ sessionID: id })
        const event = yield* orbit.sessions.log({ sessionID: id }).pipe(
          Stream.filter((item) => item.type === "session.model.selected"),
          Stream.take(1),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        )
        const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
          Option.getOrThrow,
        )
        const message = yield* orbit.sessions.message.get({ sessionID: id, messageID: modelMessage.id })
        yield* orbit.sessions.interrupt({ sessionID: id })
        const other = yield* orbit.sessions.create({ location: location(fixture) })
        const missingSessionID = fixture.sdk.Session.ID.create()
        const missing = yield* Effect.all(
          [
            orbit.sessions.log({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
            orbit.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
            orbit.sessions.message.get({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
            orbit.sessions.instructions.entry.list({ sessionID: missingSessionID }).pipe(Effect.flip),
            orbit.sessions.inbox.list({ sessionID: missingSessionID }).pipe(Effect.flip),
          ],
          { concurrency: "unbounded" },
        )
        const missingMessage = yield* Effect.flip(
          orbit.sessions.message.get({
            sessionID: other.id,
            messageID: modelMessage.id,
          }),
        )

        expect(created.id).toBe(id)
        expect(selected.model?.id).toBe(model.id)
        expect(selected.model?.providerID).toBe(model.providerID)
        expect(page.data.some((session) => session.id === id)).toBe(true)
        expect(active).toEqual({})
        expect(admitted.sessionID).toBe(id)
        expect(pendingAfterAdmit).toContainEqual(
          expect.objectContaining({ id: admitted.id, type: "user", delivery: "steer" }),
        )
        expect(prompted.type).toBe("session.inbox.delivered")
        expect(pendingAfterPromote.map((item) => item.id)).not.toContainAnyValues([admitted.id, wake.id])
        expect(wakeContext).toContainEqual(expect.objectContaining({ id: wake.id, type: "user" }))
        expect(contextEntries).toEqual([
          { key: "deploy-target", value: "production" },
          { key: "flags", value: { beta: true } },
        ])
        expect(remainingContextEntries).toEqual([{ key: "deploy-target", value: "production" }])
        expect(context.some((message) => message.type === "model-switched")).toBe(true)
        expect(event).toMatchObject({ type: "session.model.selected", durable: { seq: 1 } })
        expect(message).toEqual(modelMessage)
        expect(missing.map((error) => error._tag)).toEqual([
          "SessionNotFoundError",
          "SessionNotFoundError",
          "SessionNotFoundError",
          "SessionNotFoundError",
          "SessionNotFoundError",
        ])
        expect(missingMessage._tag).toBe("MessageNotFoundError")
      }),
    ),
  10_000,
)

for (const implicit of [false, true]) {
  it.live(
    `embedded host ${implicit ? "applies" : "reads none of"} a project's config with implicit trust ${implicit ? "on" : "off"}`,
    () =>
      withEmbedded("orbit-embedded-trust-", (fixture) =>
        Effect.gen(function* () {
          const project = path.join(fixture.directory, "project")
          const configDirectory = path.join(fixture.directory, "config")
          const file = path.join(project, "orbit.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(project, { recursive: true })
            await fs.mkdir(configDirectory)
            await fs.writeFile(
              file,
              JSON.stringify({
                username: "dev",
                hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo ready" }] }] },
              }),
            )
          })
          const orbit = yield* fixture.sdk.Orbit.create({
            config: { directory: configDirectory, content: "{}" },
            models: { fetch: false },
            fs: { filewatcher: false },
            trust: { implicit },
          })

          const entries = yield* orbit.config.get({ location: { directory: project } })
          const document = entries.find((entry) => entry.type === "document" && entry.path === file)
          // The host decides: a host that sets nothing trusts nothing on its own, and reads nothing of the folder
          // (trust-first).
          if (!implicit) return expect(document).toBeUndefined()
          if (document?.type !== "document") throw new Error("Expected the project's config document")
          expect(document.info.username).toBeDefined()
          expect(document.trusted).toBeUndefined()
          expect(document.info.hooks).toBeDefined()
        }),
      ),
  )
}

it.live("embedded client exposes plugin-backed web search", () =>
  withEmbedded("orbit-embedded-websearch-", (fixture) =>
    Effect.gen(function* () {
      // The host's config lives in the fixture's folder, so the row reads neither the machine's global config nor its
      // model catalog.
      const orbit = yield* fixture.sdk.Orbit.create({
        config: { directory: fixture.directory, project: false, content: "{}" },
        models: { fetch: false },
        fs: { filewatcher: false },
        trust: { implicit: true },
      })
      const providerID = fixture.sdk.WebSearch.ID.make("embedded-websearch")
      yield* orbit.plugin({
        id: `embedded-websearch-${crypto.randomUUID()}`,
        effect: (ctx) =>
          ctx.websearch.transform((editor) => {
            editor.add({
              id: providerID,
              name: "Embedded web search",
              execute: (input) =>
                Effect.succeed([{ url: "https://example.com", content: `Found ${input.query}`, time: {} }]),
            })
          }),
      })

      const result = yield* orbit.websearch.query({
        query: "orbit",
        providerID,
        location: location(fixture),
      })

      expect(result.data).toEqual({
        providerID,
        results: [{ url: "https://example.com", content: "Found orbit", time: {} }],
      })
    }),
  ),
)

type Embedded = Effect.Success<ReturnType<Sdk["Orbit"]["create"]>>

// A Location boots on the first request that names it and activates its plugins in the background. A route that reads
// what plugins contribute answers from that request on, as the agent, command and skill routes do, so the first answer
// already holds the contribution: no client has to retry until the activation it cannot see has finished.
const firstAnswers: ReadonlyArray<{
  readonly name: string
  readonly ask: (orbit: Embedded, fixture: Fixture) => Effect.Effect<unknown, unknown>
  readonly expected: unknown
}> = [
  {
    name: "websearch.providers lists the provider a plugin adds",
    ask: (orbit: Embedded, fixture: Fixture) =>
      orbit.websearch
        .providers({ location: location(fixture) })
        .pipe(Effect.map((page) => page.data.map((provider) => provider.id))),
    expected: expect.arrayContaining(["first-answer-websearch"]),
  },
  {
    name: "websearch.query reaches the provider a plugin adds",
    ask: (orbit: Embedded, fixture: Fixture) =>
      orbit.websearch
        .query({
          query: "orbit",
          providerID: fixture.sdk.WebSearch.ID.make("first-answer-websearch"),
          location: location(fixture),
        })
        .pipe(Effect.map((answer) => answer.data.providerID)),
    expected: "first-answer-websearch",
  },
  {
    name: "model.list lists the model a configured provider supplies",
    ask: (orbit: Embedded, fixture: Fixture) =>
      orbit.model
        .list({ location: location(fixture) })
        .pipe(Effect.map((page) => page.data.map((model) => `${model.providerID}/${model.id}`))),
    expected: expect.arrayContaining(["custom/fictional-chat"]),
  },
  {
    name: "model.default names the model the config chooses",
    ask: (orbit: Embedded, fixture: Fixture) =>
      orbit.model
        .default({ location: location(fixture) })
        .pipe(Effect.map((answer) => answer.data && `${answer.data.providerID}/${answer.data.id}`)),
    expected: "custom/fictional-chat",
  },
]

// An embedded host whose config supplies one model, with a plugin that adds one web search provider.
const prepareFirstAnswer = (fixture: Fixture) =>
  Effect.gen(function* () {
    const orbit = yield* fixture.sdk.Orbit.create({
      config: {
        directory: fixture.directory,
        project: false,
        content: JSON.stringify({
          model: "custom/fictional-chat",
          providers: {
            custom: {
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { baseURL: "https://provider.example/v1" },
              models: { "fictional-chat": {} },
            },
          },
        }),
      },
      models: { fetch: false },
      fs: { filewatcher: false },
      trust: { implicit: true },
    })
    yield* orbit.plugin({
      id: `first-answer-websearch-${crypto.randomUUID()}`,
      effect: (ctx) =>
        ctx.websearch.transform((editor) => {
          editor.add({
            id: fixture.sdk.WebSearch.ID.make("first-answer-websearch"),
            name: "First answer web search",
            execute: () => Effect.succeed([{ url: "https://example.com", content: "found", time: {} }]),
          })
        }),
    })
    return orbit
  })

for (const row of firstAnswers) {
  it.live(`the first request to a fresh Location: ${row.name}`, () =>
    withEmbedded("orbit-embedded-first-answer-", (fixture) =>
      Effect.gen(function* () {
        const orbit = yield* prepareFirstAnswer(fixture)
        // No retry and no wait: the request below is the one that boots the Location.
        expect(yield* row.ask(orbit, fixture)).toEqual(row.expected)
      }),
    ),
  )

  // The control: the same set-up answers with the contribution once activation has had time, so the row above fails
  // only because its answer comes before activation, not because the set-up is wrong.
  it.live(
    `control, once the Location has activated its plugins: ${row.name}`,
    () =>
      withEmbedded("orbit-embedded-first-answer-", (fixture) =>
        Effect.gen(function* () {
          const orbit = yield* prepareFirstAnswer(fixture)
          // Asked until the answer holds the contribution: a busy runner may take a while to activate.
          yield* row.ask(orbit, fixture).pipe(
            Effect.flatMap((value) => Effect.try(() => expect(value).toEqual(row.expected))),
            Effect.retry(Schedule.spaced("50 millis")),
            Effect.timeout("20 seconds"),
          )
        }),
      ),
    30_000,
  )
}

it.live(
  "Location-owned runner events reach the ready global client",
  () =>
    withEmbedded("orbit-embedded-events-", (fixture) =>
      Effect.gen(function* () {
        const orbit = yield* fixture.sdk.Orbit.create({ trust: { implicit: true } })
        const id = sessionID(fixture)
        const connected = yield* Latch.make(false)
        const prompted = yield* Deferred.make<Extract<OrbitEvent, { type: "session.inbox.delivered" }>>()

        yield* orbit.events.subscribe().pipe(
          Stream.runForEach((event) =>
            event.type === "server.connected"
              ? connected.open
              : event.type === "session.inbox.delivered" && event.data.sessionID === id
                ? Deferred.succeed(prompted, event).pipe(Effect.asVoid)
                : Effect.void,
          ),
          Effect.forkScoped,
        )
        yield* connected.await
        yield* orbit.sessions.create({ id, location: location(fixture) })
        yield* orbit.sessions.prompt({
          sessionID: id,
          text: "Observe this input",
        })

        const event = yield* Deferred.await(prompted).pipe(Effect.timeout("4 seconds"))
        expect(event.durable).toEqual(expect.objectContaining({ aggregateID: id, seq: expect.any(Number) }))
      }),
    ),
  10_000,
)

it.live(
  "independent embedded hosts do not share live notifications",
  () =>
    withEmbedded("orbit-embedded-hosts-", (fixture) =>
      Effect.gen(function* () {
        const first = yield* fixture.sdk.Orbit.create({ trust: { implicit: true } })
        const second = yield* fixture.sdk.Orbit.create({ trust: { implicit: true } })
        const id = sessionID(fixture)
        const firstReady = yield* Latch.make(false)
        const secondReady = yield* Latch.make(false)
        const firstEvent = yield* Latch.make(false)
        const secondEvent = yield* Latch.make(false)
        const observe = (ready: Latch.Latch, event: Latch.Latch) =>
          Stream.runForEach((notification: OrbitEvent) =>
            notification.type === "server.connected"
              ? ready.open
              : notification.type === "session.agent.selected" && notification.data.sessionID === id
                ? event.open
                : Effect.void,
          )

        yield* first.events.subscribe().pipe(observe(firstReady, firstEvent), Effect.forkScoped)
        yield* second.events.subscribe().pipe(observe(secondReady, secondEvent), Effect.forkScoped)
        yield* Effect.all([firstReady.await, secondReady.await], { discard: true })
        yield* first.sessions.create({ id, location: location(fixture) })
        yield* first.sessions.switchAgent({ sessionID: id, agent: fixture.sdk.Agent.ID.make("plan") })

        yield* firstEvent.await.pipe(Effect.timeout("2 seconds"))
        expect(Option.isNone(yield* secondEvent.await.pipe(Effect.timeoutOption("100 millis")))).toBe(true)
      }),
    ),
  10_000,
)

it.live("embedded client is available as a Layer service", () =>
  withEmbedded("orbit-embedded-layer-", (fixture) => {
    const id = sessionID(fixture)
    return Effect.gen(function* () {
      const orbit = yield* fixture.sdk.Orbit.Service
      const created = yield* orbit.sessions.create({ id, location: location(fixture) })
      expect(created.id).toBe(id)
    }).pipe(Effect.provide(fixture.sdk.Orbit.layer({ trust: { implicit: true } })))
  }),
)

it.live("configures workspace providers through the SDK facade", () =>
  withEmbedded("orbit-embedded-workspace-", (fixture) =>
    Effect.gen(function* () {
      const calls: Array<{ readonly operation: string; readonly workspaceID: string }> = []
      const driver = WorkspaceDriver.make({
        create: ({ workspaceID }) => {
          calls.push({ operation: "create", workspaceID })
          return Effect.succeed({ binding: { externalID: workspaceID } })
        },
        connect: ({ workspaceID }) => {
          calls.push({ operation: "connect", workspaceID })
          return Effect.succeed(makeMemoryDriver())
        },
        suspendForIdle: () => Effect.void,
        destroy: ({ workspaceID }) => {
          calls.push({ operation: "destroy", workspaceID })
          return Effect.void
        },
      })
      const orbit = yield* fixture.sdk.Orbit.create({ workspaceProviders: { fake: driver } , trust: { implicit: true } })
      const requestedID = fixture.sdk.Workspace.ID.create()
      const workspaceID = yield* orbit.workspace.create({ id: requestedID, provider: "fake" })

      expect(workspaceID).toBe(requestedID)
      expect(yield* orbit.workspace.create({ id: requestedID, provider: "fake" })).toBe(requestedID)
      expect(calls).toEqual([])

      const workspace = yield* orbit.workspace.provision({ workspaceID })

      expect(workspace.provider).toBe("fake")
      expect(workspace.binding).toEqual({ externalID: workspace.id })
      expect(calls).toEqual([{ operation: "create", workspaceID: workspace.id }])

      const workspaceLocation = fixture.sdk.Location.Ref.make({
        directory: fixture.sdk.AbsolutePath.make("/"),
        workspaceID: workspace.id,
      })
      // A filesystem root is trusted only by a grant until the host stops, never implicitly; `sessions.create` asks what
      // the `session.create` route asks (trust-first).
      yield* orbit.location.trust.update({
        location: { directory: fixture.sdk.AbsolutePath.make("/") },
        trust: true,
        persist: false,
      })
      const session = yield* orbit.sessions.create({ location: workspaceLocation })
      expect(session.location.workspaceID).toBe(workspace.id)

      expect(yield* orbit.workspace.destroy({ workspaceID: workspace.id })).toEqual({ destroyed: true })
      expect(calls.map((call) => call.operation)).toEqual(["create", "destroy"])
      expect(yield* orbit.workspace.destroy({ workspaceID: workspace.id })).toEqual({ destroyed: false })
      expect(calls.map((call) => call.operation)).toEqual(["create", "destroy"])
    }),
  ),
)

const workspaceModelScenario = (fixture: Fixture, policy: "eager" | "lazy") =>
  Effect.gen(function* () {
    const calls: string[] = []
    const createStarted = yield* Deferred.make<void>()
    const createRelease = yield* Deferred.make<void>()
    const modelStarted = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(createRelease, undefined).pipe(Effect.asVoid))
    const model = LanguageModel.make({ id: "workspace-test", provider: "test", route: OpenAIChat.route })
    const client = TestLLM.testLayer({
      fallback: TestLLM.text("ready", "answer"),
      transformRequest: (request) => {
        Deferred.doneUnsafe(modelStarted, Effect.void)
        return request
      },
    })
    const models = Layer.mock(SessionRunnerModel.Service, {
      resolve: () =>
        Effect.succeed(
          SessionRunnerModel.resolved(model, {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [],
            limit: { context: 100_000, output: 1_000 },
          }),
        ),
    })
    const driver = WorkspaceDriver.make({
      create: ({ workspaceID }) => {
        calls.push("create")
        return Deferred.succeed(createStarted, undefined).pipe(
          Effect.andThen(Deferred.await(createRelease)),
          Effect.as({ binding: { workspaceID } }),
        )
      },
      connect: () => {
        calls.push("connect")
        return Effect.succeed(makeMemoryDriver())
      },
      suspendForIdle: () => Effect.void,
      destroy: () => Effect.void,
    })
    const configDirectory = path.join(fixture.directory, "config")
    yield* Effect.promise(() => fs.mkdir(configDirectory))
    const orbit = yield* fixture.sdk.Orbit.create(
      {
        config: { directory: configDirectory, project: false, content: "{}" },
        workspaceProviders: { fake: driver },
        trust: { implicit: true },
      },
      {
        overrides: [llmClient.replace(client), SessionRunnerModel.node.replace(models)],
      },
    )
    const workspaceID = yield* orbit.workspace.create({ provider: "fake" })
    const provisioning =
      policy === "eager"
        ? yield* orbit.workspace.provision({ workspaceID }).pipe(Effect.forkScoped({ startImmediately: true }))
        : undefined
    if (provisioning) {
      yield* Deferred.await(createStarted).pipe(
        Effect.timeoutOrElse({ duration: "4 seconds", orElse: () => Effect.die("provider create did not start") }),
      )
    }

    const session = yield* orbit.sessions.create({
      location: fixture.sdk.Location.Ref.make({
        directory: fixture.sdk.AbsolutePath.make(fixture.directory),
        workspaceID,
      }),
    })
    yield* orbit.sessions.prompt({ sessionID: session.id, text: "Answer without using tools" })
    yield* Deferred.await(modelStarted).pipe(
      Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("model stream did not start") }),
    )

    if (!provisioning) {
      expect(calls).toEqual([])
      return
    }
    expect(provisioning.pollUnsafe()).toBeUndefined()
    expect(calls).toEqual(["create"])
    yield* Deferred.succeed(createRelease, undefined)
    expect((yield* Fiber.join(provisioning)).binding).toEqual({ workspaceID })
    expect(calls).toEqual(["create"])
  })

it.live(
  "starts model execution while eager workspace provisioning is blocked",
  () => withEmbedded("orbit-embedded-workspace-eager-", (fixture) => workspaceModelScenario(fixture, "eager")),
  15_000,
)

it.live(
  "starts model execution without provisioning a lazy workspace",
  () => withEmbedded("orbit-embedded-workspace-lazy-", (fixture) => workspaceModelScenario(fixture, "lazy")),
  15_000,
)

it.live(
  "blocks the model-selected first tool on lazy provisioning",
  () =>
    withEmbedded("orbit-embedded-workspace-tool-", (fixture) =>
      Effect.gen(function* () {
        const calls: string[] = []
        const createStarted = yield* Deferred.make<void>()
        const createRelease = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(createRelease, undefined).pipe(Effect.asVoid))
        const model = LanguageModel.make({ id: "workspace-tool-test", provider: "test", route: OpenAIChat.route })
        // The first tool-advertising request selects the shell tool; everything else
        // (including title generation, which carries no tools) answers with text.
        let toolIssued = false
        const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
        yield* llm.serve((request) => {
          const wantsTool = !toolIssued && request.tools.some((tool) => tool.name === "Bash")
          if (!wantsTool) return TestLLM.text("done", "answer")
          toolIssued = true
          return TestLLM.tool("call-shell", "Bash", { command: "echo hi" })
        })
        const models = Layer.mock(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(model, {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: [],
                limit: { context: 100_000, output: 1_000 },
              }),
            ),
        })
        const driver = WorkspaceDriver.make({
          create: ({ workspaceID }) => {
            calls.push("create")
            return Deferred.succeed(createStarted, undefined).pipe(
              Effect.andThen(Deferred.await(createRelease)),
              Effect.as({ binding: { workspaceID } }),
            )
          },
          connect: () => {
            calls.push("connect")
            return Effect.succeed(makeMemoryDriver())
          },
          suspendForIdle: () => Effect.void,
          destroy: () => Effect.void,
        })
        const configDirectory = path.join(fixture.directory, "config")
        yield* Effect.promise(() => fs.mkdir(configDirectory))
        const orbit = yield* fixture.sdk.Orbit.create(
          {
            config: { directory: configDirectory, project: false, content: "{}" },
            workspaceProviders: { fake: driver },
            trust: { implicit: true },
          },
          {
            overrides: [
              llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
              SessionRunnerModel.node.replace(models),
            ],
          },
        )
        const workspaceID = yield* orbit.workspace.create({ provider: "fake" })
        const session = yield* orbit.sessions.create({
          location: fixture.sdk.Location.Ref.make({
            directory: fixture.sdk.AbsolutePath.make(fixture.directory),
            workspaceID,
          }),
        })
        expect(calls).toEqual([])

        yield* orbit.sessions.prompt({ sessionID: session.id, text: "Run echo" })
        // The model-selected shell tool is the first execution-plane demand: it alone
        // starts provisioning and blocks inside the tool call until the provider is ready.
        yield* Deferred.await(createStarted).pipe(
          Effect.timeoutOrElse({ duration: "8 seconds", orElse: () => Effect.die("first tool did not provision") }),
        )
        expect(calls).toEqual(["create"])

        yield* Deferred.succeed(createRelease, undefined)
        yield* orbit.sessions.wait({ sessionID: session.id })
        // Provisioning settled, the workspace connected, and the turn completed. The
        // memory driver rejects the actual spawn, which surfaces to the model as an
        // ordinary tool error before the final text response.
        expect(calls).toEqual(["create", "connect"])
        expect(toolIssued).toBe(true)
      }),
    ),
  15_000,
)

it.live("preserves unknown workspace provider errors", () =>
  withEmbedded("orbit-embedded-workspace-provider-", (fixture) =>
    Effect.gen(function* () {
      const orbit = yield* fixture.sdk.Orbit.create({ trust: { implicit: true } })
      const error = yield* orbit.workspace.create({ provider: "missing" }).pipe(Effect.flip)
      expect(error).toEqual(new WorkspaceDriver.ProviderNotFound({ provider: "missing" }))
    }),
  ),
)
