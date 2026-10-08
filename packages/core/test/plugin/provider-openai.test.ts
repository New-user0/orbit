import { Money } from "@orbit/schema/money"
import { Agent } from "@orbit/schema/agent"
import { Session } from "@orbit/core/session"
import { OpenAIResponses } from "@orbit/ai/protocols/openai-responses"
import { describe, expect } from "bun:test"
import { ConfigProvider, DateTime, Effect } from "effect"
import { Credential } from "@orbit/core/credential"
import { Integration } from "@orbit/core/integration"
import { Location } from "@orbit/core/location"
import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { GithubCopilotPlugin } from "@orbit/core/plugin/provider/github-copilot"
import { OpenAIPlugin } from "@orbit/core/plugin/provider/openai"
import { Project } from "@orbit/core/project"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionModelRequest } from "@orbit/core/session/model-request"
import { SessionModelTransport } from "@orbit/core/session/model-transport"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { testEffect } from "../lib/effect"
import { stubSnapshot } from "../lib/tool"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenAIPlugin.effect(host)
})

const addGithubCopilotPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* GithubCopilotPlugin.effect(host)
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const request = Effect.fn(function* (
  providerID: Provider.ID,
  baseURL: string,
  sessionID = Session.ID.make("ses_test"),
) {
  const hooks = yield* PluginHooks.Service
  const event = yield* hooks.trigger("session", "model.request", {
    sessionID,
    agent: Agent.ID.make("build"),
    model: Model.Ref.make({ providerID, id: Model.ID.make("gpt-5.5") }),
    kind: "primary",
    baseURL,
    headers: {},
  })
  return {
    baseURL: event.baseURL,
    headers: event.headers,
    hasHttpHooks:
      (yield* hooks.has("session", "http.request", providerID)) ||
      (yield* hooks.has("session", "http.response", providerID)),
  }
})

describe("OpenAIPlugin", () => {
  it.effect("keeps the full OpenAI catalog under an API key connection", () =>
    Effect.gen(function* () {
      const catalog = yield* Provider.Service
      const models = yield* Model.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((catalog) => {
        catalog.update(Provider.ID.openai, (draft) => {
          draft.package = "@orbit/ai/providers/openai"
        })
        catalog.models.update(Provider.ID.openai, Model.ID.make("gpt-5.5"), (model) => {
          model.limit = { context: 1_050_000, input: 922_000, output: 128_000 }
        })
        catalog.models.update(Provider.ID.openai, Model.ID.make("gpt-4.1"), () => {})
      })
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "sk-test" }),
      })
      yield* addPlugin()

      const direct = yield* request(Provider.ID.openai, "https://api.openai.com/v1")

      const provider = required(yield* catalog.get(Provider.ID.openai))
      const model = required(yield* models.get(Provider.ID.openai, Model.ID.make("gpt-5.5")))
      expect(model.package).toBe("@orbit/ai/providers/openai")
      expect(model.enabled).toBe(true)
      expect(model.limit).toEqual({ context: 1_050_000, input: 922_000, output: 128_000 })
      expect(provider.settings?.transport).toBe("websocket")
      expect(model.settings?.transport).toBeUndefined()
      expect(direct.headers).not.toHaveProperty("originator")
      expect(direct.baseURL).toBe("https://api.openai.com/v1")
      expect(direct.hasHttpHooks).toBe(false)
      expect(provider.headers).not.toHaveProperty("originator")
      expect(required(yield* models.get(Provider.ID.openai, Model.ID.make("gpt-4.1"))).enabled).toBe(true)
    }),
  )

  // OpenAI omits its default output limit, but a configured output_token_cap is the user's own request and stays.
  const limitCases = [
    { provider: Provider.ID.openai, kind: "primary", cap: undefined, expected: undefined },
    { provider: Provider.ID.openai, kind: "primary", cap: 8000, expected: 8000 },
    // A cap above the model's own 128,000-token maximum lowers nothing, so the default stays omitted.
    { provider: Provider.ID.openai, kind: "primary", cap: 200_000, expected: undefined },
    { provider: Provider.ID.openai, kind: "compaction", cap: 8000, expected: undefined },
    { provider: Provider.ID.azure, kind: "primary", cap: undefined, expected: 32_000 },
    { provider: Provider.ID.azure, kind: "primary", cap: 8000, expected: 8000 },
    { provider: Provider.ID.azure, kind: "compaction", cap: undefined, expected: 32_000 },
  ] as const
  for (const row of limitCases)
    it.effect(`${row.provider} ${row.kind} with cap ${row.cap ?? "unset"} asks for ${row.expected ?? "no limit"}`, () =>
      Effect.gen(function* () {
        yield* addPlugin()
        const requests = yield* SessionModelRequest.Service
        const prepared = yield* requests[row.kind]({
          session: Session.Info.make({
            id: Session.ID.make("ses_limit"),
            projectID: Project.ID.global,
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
            location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
          }),
          agent: Agent.ID.make("build"),
          model: SessionRunnerModel.resolved(
            OpenAIResponses.route.with({ id: `${row.provider}-responses`, provider: row.provider }).model({
              id: "gpt-5.5",
            }),
            {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: [],
              limit: { context: 200_000, output: 32_000 },
            },
          ),
          system: [],
          messages: [],
          outputTokenCap: row.cap,
        })
        expect(prepared.request.generation?.maxTokens).toBe(row.expected)
      }).pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, {
          bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
          close: () => Effect.void,
          closeAll: Effect.void,
        }),
      ),
    )

  it.effect("selects WebSocket only from explicit policy", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "sk-test" }),
      })
      yield* addPlugin()
      yield* addGithubCopilotPlugin()
      const executor = { execute: () => Effect.die("unused WebSocket execution") }
      const transport = SessionModelTransport.Service.of({
        bind: () => executor,
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const sessionID = Session.ID.make("ses_websocket_hooks")
      const agentID = Agent.ID.make("build")
      const route = OpenAIResponses.route.with({
        id: "deployment-responses",
        provider: Provider.ID.azure,
      })
      const prepare = (preference?: Provider.Transport) =>
        Effect.gen(function* () {
          const model = SessionRunnerModel.resolved(route.model({ id: "gpt-5.5" }), {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [],
            limit: { context: 200_000, output: 32_000 },
            transport: preference,
          })
          const requests = yield* SessionModelRequest.Service
          return yield* requests.primary({
            session: Session.Info.make({
              id: sessionID,
              projectID: Project.ID.global,
              cost: Money.USD.zero,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
              location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
            }),
            agent: agentID,
            model,
            tools: stubSnapshot({ definitions: [], execute: () => Effect.die("unused tool execution") }),
            system: [],
            messages: [],
            webSocket: "session",
          })
        }).pipe(
          Effect.provide(SessionModelRequest.layer),
          Effect.provideService(SessionModelTransport.Service, transport),
        )

      const prepared = yield* prepare("websocket")
      const defaulted = yield* prepare()
      const disabled = yield* prepare("http")

      expect(prepared.options.webSocket).toBe(executor)
      expect(prepared.options.http).toBeUndefined()
      expect(defaulted.options.webSocket).toBeUndefined()
      expect(disabled.options.webSocket).toBeUndefined()
    }),
  )
})
