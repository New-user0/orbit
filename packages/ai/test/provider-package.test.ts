import { describe, expect, test } from "bun:test"
import { model } from "@orbit/ai/providers/openai"
import { HttpOptions, LLM } from "../src/index.js"
import { AnthropicMessages } from "../src/protocols/anthropic-messages.js"
import { Endpoint } from "../src/route/endpoint.js"

const configuration = (provider: string, message: string) =>
  expect.objectContaining({ _tag: "ProviderConfiguration", provider, message })

describe("provider package entrypoints", () => {
  test("semantic API aliases expose the same contract", async () => {
    const modules = await Promise.all([
      import("@orbit/ai/providers/openai"),
      import("@orbit/ai/providers/openai/responses"),
      import("@orbit/ai/providers/openai/chat"),
      import("@orbit/ai/providers/anthropic"),
      import("@orbit/ai/providers/anthropic-compatible"),
      import("@orbit/ai/providers/openai-compatible"),
      import("@orbit/ai/providers/openai-compatible/responses"),
      import("@orbit/ai/providers/amazon-bedrock"),
      import("@orbit/ai/providers/azure"),
      import("@orbit/ai/providers/azure/responses"),
      import("@orbit/ai/providers/azure/chat"),
      import("@orbit/ai/providers/google"),
      import("@orbit/ai/providers/google-vertex"),
      import("@orbit/ai/providers/google-vertex/gemini"),
      import("@orbit/ai/providers/google-vertex/chat"),
      import("@orbit/ai/providers/google-vertex/responses"),
      import("@orbit/ai/providers/google-vertex/messages"),
      import("@orbit/ai/providers/openrouter"),
      import("@orbit/ai/providers/amazon-bedrock/mantle"),
      import("@orbit/ai/providers/amazon-bedrock/mantle/chat"),
      import("@orbit/ai/providers/amazon-bedrock/mantle/responses"),
      import("@orbit/ai/providers/togetherai"),
      import("@orbit/ai/providers/cerebras"),
      import("@orbit/ai/providers/deepinfra"),
      import("@orbit/ai/providers/groq"),
      import("@orbit/ai/providers/baseten"),
      import("@orbit/ai/providers/deepseek"),
      import("@orbit/ai/providers/fireworks"),
      import("@orbit/ai/providers/cloudflare-ai-gateway"),
      import("@orbit/ai/providers/cloudflare-workers-ai"),
      import("@orbit/ai/providers/minimax"),
      import("@orbit/ai/providers/minimax/messages"),
      import("@orbit/ai/providers/minimax/chat"),
      import("@orbit/ai/providers/minimax/responses"),
      import("@orbit/ai/providers/moonshot"),
      import("@orbit/ai/providers/moonshot/chat"),
      import("@orbit/ai/providers/moonshot/messages"),
      import("@orbit/ai/providers/moonshot/responses"),
      import("@orbit/ai/providers/zai"),
      import("@orbit/ai/providers/zai/chat"),
      import("@orbit/ai/providers/zai-coding-plan"),
      import("@orbit/ai/providers/zai-coding-plan/chat"),
      import("@orbit/ai/providers/zai-coding-plan/messages"),
      import("@orbit/ai/providers/zai-coding-plan/responses"),
      import("@orbit/ai/providers/alibaba"),
      import("@orbit/ai/providers/alibaba/chat"),
      import("@orbit/ai/providers/alibaba/messages"),
      import("@orbit/ai/providers/alibaba/responses"),
    ])

    for (const module of modules) expect(module.model).toBeFunction()
    expect(modules[0].model).toBe(modules[1].model)
    expect(modules[8].model).toBe(modules[9].model)
    expect(modules[12].model).toBe(modules[13].model)
    expect(modules[18].model).toBe(modules[20].model)
    expect(modules[18].model).not.toBe(modules[19].model)
  })

  test("maps Alibaba API entrypoints onto explicit regional routes", async () => {
    const modules = await Promise.all([
      import("@orbit/ai/providers/alibaba"),
      import("@orbit/ai/providers/alibaba/chat"),
      import("@orbit/ai/providers/alibaba/messages"),
      import("@orbit/ai/providers/alibaba/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    const settings = {
      region: "eu-central-1",
      workspaceID: "llm-fixture",
      apiKey: "fixture",
      headers: { "x-test": "fixture" },
      body: { extension: true },
    }
    const routes = ["alibaba-chat", "alibaba-chat", "alibaba-messages", "alibaba-responses"]
    modules.forEach((module, index) => {
      const model = module.model("qwen3.8-max", settings)
      expect(model.provider).toBe("alibaba")
      expect(model.route.id).toBe(routes[index])
      expect(model.route.endpoint.baseURL).toBe(
        `https://llm-fixture.eu-central-1.maas.aliyuncs.com/${index === 2 ? "apps/anthropic/v1" : "compatible-mode/v1"}`,
      )
      expect(model.route.defaults.headers).toEqual(settings.headers)
      expect(model.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps Moonshot API entrypoints onto provider-owned routes", async () => {
    const modules = await Promise.all([
      import("@orbit/ai/providers/moonshot"),
      import("@orbit/ai/providers/moonshot/chat"),
      import("@orbit/ai/providers/moonshot/messages"),
      import("@orbit/ai/providers/moonshot/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    const settings = {
      apiKey: "fixture",
      baseURL: "https://gateway.example/v1",
      headers: { "x-application": "fixture" },
      body: { future_option: true },
    }
    const routes = ["moonshot-chat", "moonshot-chat", "moonshot-messages", "moonshot-responses"]
    modules.forEach((module, index) => {
      const selected = module.model("kimi-k3", settings)
      expect(selected.provider).toBe("moonshotai")
      expect(selected.route.id).toBe(routes[index])
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps MiniMax API entrypoints onto provider-owned routes", async () => {
    const modules = await Promise.all([
      import("@orbit/ai/providers/minimax"),
      import("@orbit/ai/providers/minimax/messages"),
      import("@orbit/ai/providers/minimax/chat"),
      import("@orbit/ai/providers/minimax/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    const settings = {
      apiKey: "fixture",
      baseURL: "https://gateway.example/v1",
      headers: { "x-application": "orbit" },
      body: { service_tier: "priority" },
    }
    const routes = ["minimax-messages", "minimax-messages", "minimax-chat", "minimax-responses"]
    modules.forEach((module, index) => {
      const selected = module.model("MiniMax-M3", settings)
      expect(selected.provider).toBe("minimax")
      expect(selected.route.id).toBe(routes[index])
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps ZAI and Coding Plan entrypoints onto distinct provider-owned routes", async () => {
    const modules = await Promise.all([
      import("@orbit/ai/providers/zai"),
      import("@orbit/ai/providers/zai/chat"),
      import("@orbit/ai/providers/zai-coding-plan"),
      import("@orbit/ai/providers/zai-coding-plan/chat"),
      import("@orbit/ai/providers/zai-coding-plan/messages"),
      import("@orbit/ai/providers/zai-coding-plan/responses"),
    ])
    expect(modules[0].model).toBe(modules[1].model)
    expect(modules[2].model).toBe(modules[3].model)
    const routes = [
      "zai-chat",
      "zai-chat",
      "zai-coding-chat",
      "zai-coding-chat",
      "zai-coding-messages",
      "zai-coding-responses",
    ]
    const settings = {
      apiKey: "fixture",
      baseURL: "https://gateway.example/custom",
      headers: { "x-test": "fixture" },
      body: { extension: true },
    }
    modules.forEach((module, index) => {
      const selected = module.model("glm-5.3", settings)
      expect(selected.provider).toBe(index < 2 ? "zai" : "zai-coding-plan")
      expect(selected.route.id).toBe(routes[index])
      expect(selected.route.endpoint.baseURL).toBe(settings.baseURL)
      expect(selected.route.defaults.headers).toEqual(settings.headers)
      expect(selected.route.defaults.http?.body).toEqual(settings.body)
    })
  })

  test("maps DeepInfra package settings onto its native executable model", async () => {
    const DeepInfra = await import("@orbit/ai/providers/deepinfra")
    const settings = {
      apiKey: "fixture",
      baseURL: "https://provider.example.test/v1/",
      headers: { "x-application": "orbit" },
      body: { service_tier: "priority" },
      reasoningEffort: "high" as const,
    }
    const deepinfra = DeepInfra.model("google/gemma-3-27b-it", settings)

    expect(deepinfra.route.id).toBe("deepinfra-chat")
    expect(deepinfra.route.endpoint.baseURL).toBe("https://provider.example.test/v1/openai")
    expect(deepinfra.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
    expect(deepinfra.route.defaults.headers).toEqual(settings.headers)
    expect(deepinfra.route.defaults.http?.body).toEqual(settings.body)
  })

  test("maps Cloudflare package settings onto provider-owned models", async () => {
    const modules = await Promise.all([
      import("@orbit/ai/providers/cloudflare-ai-gateway"),
      import("@orbit/ai/providers/cloudflare-workers-ai"),
    ])
    for (const provider of modules) {
      const selected = provider.model("provider-model", {
        accountId: "account",
        apiKey: "fixture",
        headers: { "x-application": "orbit" },
        body: { custom: true },
        reasoningEffort: "high",
      })
      expect(selected.provider).toBe(provider.id)
      expect(selected.route.endpoint.baseURL).toBe(provider.baseURL({ accountId: "account" }))
      expect(selected.route.defaults.headers).toMatchObject({ "x-application": "orbit" })
      expect(selected.route.defaults.http?.body).toEqual({ custom: true })
      expect(selected.route.defaults.providerOptions).toEqual({ reasoningEffort: "high" })
    }
  })

  test("maps package settings onto the executable model", () => {
    const selected = model("gpt-5", {
      apiKey: "fixture",
      baseURL: "https://api.openai.test/v1",
      headers: { "x-application": "orbit" },
      body: { service_tier: "priority" },
      unrelatedInheritedSetting: true,
    })

    expect(selected.route.id).toBe("openai-responses")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "orbit" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
  })

  test("maps OpenAI-compatible Responses settings onto the executable model", async () => {
    const OpenAICompatibleResponses = await import("@orbit/ai/providers/openai-compatible/responses")
    const selected = OpenAICompatibleResponses.model("custom-model", {
      apiKey: "fixture",
      baseURL: "https://responses.example.test/v1",
      provider: "example",
      headers: { "x-application": "orbit" },
      body: { service_tier: "priority" },
      reasoningEffort: "low",
      store: true,
    })

    expect(String(selected.provider)).toBe("example")
    expect(selected.route.id).toBe("openai-compatible-responses")
    expect(selected.route.endpoint).toMatchObject({
      baseURL: "https://responses.example.test/v1",
      path: "/responses",
    })
    expect(selected.route.defaults.headers).toEqual({ "x-application": "orbit" })
    expect(selected.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(selected.route.defaults.providerOptions).toEqual({
      reasoningEffort: "low",
      store: true,
      include: ["reasoning.encrypted_content"],
    })
  })

  test("maps Anthropic-compatible settings onto the executable model", async () => {
    const AnthropicCompatible = await import("@orbit/ai/providers/anthropic-compatible")
    const selected = AnthropicCompatible.model("compatible-model", {
      apiKey: "fixture",
      baseURL: "https://messages.example.test/v1",
      provider: "example",
      headers: { "x-application": "orbit" },
      body: { metadata: { user_id: "user_1" } },
      effort: "low",
    })

    expect(String(selected.provider)).toBe("example")
    expect(selected.route.id).toBe("anthropic-compatible-messages")
    expect(selected.route.protocol).toBe("anthropic-messages")
    expect(selected.route.providerMetadataKey).toBe("example")
    expect(selected.route.endpoint).toMatchObject({
      baseURL: "https://messages.example.test/v1",
    })
    expect(
      Endpoint.render(selected.route.endpoint, { request: LLM.request({ model: selected }), body: {} }).toString(),
    ).toBe("https://messages.example.test/v1/messages")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "orbit" })
    expect(selected.route.defaults.http?.body).toEqual({ metadata: { user_id: "user_1" } })
    expect(selected.route.defaults.providerOptions).toEqual({ effort: "low" })
  })

  test("maps Anthropic provider options onto the executable model", async () => {
    const Anthropic = await import("@orbit/ai/providers/anthropic")
    const selected = Anthropic.model("claude-sonnet-4-6", {
      apiKey: "fixture",
      thinking: { type: "adaptive" },
    })

    expect(selected.route.id).toBe("anthropic-messages")
    expect(selected.route.defaults.providerOptions).toEqual({ thinking: { type: "adaptive" } })
  })

  test("gives the first-party default endpoint a 90 s stream idle limit and no other endpoint", async () => {
    const Anthropic = await import("@orbit/ai/providers/anthropic")
    const AnthropicCompatible = await import("@orbit/ai/providers/anthropic-compatible")
    const at = (baseURL?: string) => Anthropic.model("claude-sonnet-4-6", { apiKey: "fixture", baseURL })
    const defaultEndpoint = [
      at(),
      at(AnthropicMessages.DEFAULT_BASE_URL),
      // The route renders its base URL without trailing slashes, so this is the same endpoint.
      at(`${AnthropicMessages.DEFAULT_BASE_URL}//`),
      Anthropic.configure({ apiKey: "fixture" }).model("claude-sonnet-4-6"),
      Anthropic.provider.model("claude-sonnet-4-6"),
    ]
    // A gateway or proxy can buffer a stream or drop its pings, so every other URL keeps the transport default.
    const elsewhere = [
      at("https://proxy.example.test/v1"),
      at("https://api.anthropic.com/v2"),
      at("https://api.anthropic.com"),
      at("http://api.anthropic.com/v1"),
      AnthropicCompatible.model("compatible-model", { apiKey: "fixture", baseURL: AnthropicMessages.DEFAULT_BASE_URL }),
    ]

    expect(AnthropicMessages.STREAM_IDLE_TIMEOUT_MS).toBe(90_000)
    expect(defaultEndpoint.map((selected) => selected.route.defaults.http?.chunkTimeout)).toEqual(
      defaultEndpoint.map(() => 90_000),
    )
    expect(elsewhere.map((selected) => selected.route.defaults.http?.chunkTimeout)).toEqual(
      elsewhere.map(() => undefined),
    )
  })

  test("lets the caller's http options replace the first-party stream idle limit", async () => {
    const Anthropic = await import("@orbit/ai/providers/anthropic")
    const http = (input?: HttpOptions.Input) =>
      Anthropic.configure({ apiKey: "fixture", http: input }).model("claude-sonnet-4-6").route.defaults.http

    expect(http({ chunkTimeout: 600_000 })?.chunkTimeout).toBe(600_000)
    expect(http({ chunkTimeout: false })?.chunkTimeout).toBe(false)
    expect(http(new HttpOptions({ chunkTimeout: 30_000 }))?.chunkTimeout).toBe(30_000)
    // Options that leave the limit unnamed keep it, and keep their own fields.
    expect(http({ headerTimeout: 1_000 })).toMatchObject({ chunkTimeout: 90_000, headerTimeout: 1_000 })
    expect(http(new HttpOptions({ headers: { "x-test": "1" } }))).toMatchObject({
      chunkTimeout: 90_000,
      headers: { "x-test": "1" },
    })
  })

  test("requires an Anthropic-compatible base URL at runtime", async () => {
    const AnthropicCompatible = await import("@orbit/ai/providers/anthropic-compatible")
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally bypasses static required-option checks.
      Reflect.apply(AnthropicCompatible.model, undefined, ["compatible-model", { apiKey: "fixture" }]),
    ).toThrow(configuration("anthropic-compatible", "Anthropic-compatible providers require a baseURL"))
  })

  test("rejects conflicting Anthropic-compatible auth settings at runtime", async () => {
    const Anthropic = await import("@orbit/ai/providers/anthropic")
    const AnthropicCompatible = await import("@orbit/ai/providers/anthropic-compatible")
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes a statically invalid option combination.
      Reflect.apply(AnthropicCompatible.model, undefined, [
        "compatible-model",
        {
          apiKey: "fixture",
          authToken: "token",
          baseURL: "https://messages.example.test/v1",
        },
      ]),
    ).toThrow(configuration("anthropic-compatible", "Anthropic-compatible apiKey cannot be combined with authToken"))
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes a statically invalid option combination.
      Reflect.apply(Anthropic.model, undefined, ["claude-sonnet-4-6", { apiKey: "fixture", authToken: "token" }]),
    ).toThrow(configuration("anthropic", "Anthropic apiKey cannot be combined with authToken"))
  })

  test("maps legacy OpenAI organization and project settings to headers", () => {
    const selected = model("gpt-5", {
      apiKey: "fixture",
      organization: "org_123",
      project: "proj_123",
    })

    expect(selected.route.defaults.headers).toMatchObject({
      "OpenAI-Organization": "org_123",
      "OpenAI-Project": "proj_123",
    })
  })

  test("selects Azure API entrypoints with the same model contract", async () => {
    const Azure = await import("@orbit/ai/providers/azure")
    const AzureChat = await import("@orbit/ai/providers/azure/chat")
    const AzureResponses = await import("@orbit/ai/providers/azure/responses")
    const settings = {
      apiKey: "fixture",
      resourceName: "orbit-test",
      headers: { "x-application": "orbit" },
      body: { service_tier: "priority" },
    }

    const responses = AzureResponses.model("deployment", settings)
    const chat = AzureChat.model("deployment", settings)

    expect(Azure.model("deployment", settings).route.id).toBe("azure-openai-responses")
    expect(responses.route.id).toBe("azure-openai-responses")
    expect(responses.route.endpoint.baseURL).toBe("https://orbit-test.openai.azure.com/openai/v1")
    expect(responses.route.defaults.headers).toEqual({ "x-application": "orbit" })
    expect(responses.route.defaults.http?.body).toEqual({ service_tier: "priority" })
    expect(chat.route.id).toBe("azure-openai-chat")
  })

  test("constructs Azure deployment URLs and preserves custom gateway URLs", async () => {
    const Azure = await import("@orbit/ai/providers/azure")
    const deployment = Azure.model("custom-deployment", {
      apiKey: "fixture",
      resourceName: "orbit-test",
      apiVersion: "2025-01-01-preview",
      useDeploymentBasedUrls: true,
    })
    const gateway = Azure.model("gateway-model", {
      apiKey: "fixture",
      baseURL: "https://gateway.example/azure/",
    })

    expect(deployment.route.endpoint).toMatchObject({
      baseURL: "https://orbit-test.openai.azure.com/openai/deployments/custom-deployment",
      query: { "api-version": "2025-01-01-preview" },
    })
    expect(gateway.route.endpoint.baseURL).toBe("https://gateway.example/azure")
    expect(gateway.route.endpoint.query).toBeUndefined()
  })

  test("maps Google package settings onto the Gemini model", async () => {
    const Google = await import("@orbit/ai/providers/google")
    const selected = Google.model("gemini-2.5-flash", {
      apiKey: "fixture",
      baseURL: "https://generativelanguage.test/v1beta",
      headers: { "x-application": "orbit" },
      body: { safetySettings: [] },
      thinkingConfig: { thinkingBudget: 1_024 },
    })

    expect(selected.route.id).toBe("gemini")
    expect(selected.route.endpoint.baseURL).toBe("https://generativelanguage.test/v1beta")
    expect(selected.route.defaults.headers).toEqual({ "x-application": "orbit" })
    expect(selected.route.defaults.http?.body).toEqual({ safetySettings: [] })
    expect(selected.route.defaults.providerOptions).toEqual({ thinkingConfig: { thinkingBudget: 1_024 } })
  })

  test("selects Vertex entrypoints with the same model contract", async () => {
    const GoogleVertex = await import("@orbit/ai/providers/google-vertex")
    const GoogleVertexGemini = await import("@orbit/ai/providers/google-vertex/gemini")
    const GoogleVertexChat = await import("@orbit/ai/providers/google-vertex/chat")
    const GoogleVertexResponses = await import("@orbit/ai/providers/google-vertex/responses")
    const GoogleVertexMessages = await import("@orbit/ai/providers/google-vertex/messages")
    const gemini = GoogleVertex.model("gemini-3.5-flash", {
      apiKey: "fixture",
      headers: { "x-application": "orbit" },
      body: { safetySettings: [] },
    })
    const messages = GoogleVertexMessages.model("claude-sonnet-4-6", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })
    const chat = GoogleVertexChat.model("deepseek-ai/deepseek-v3.2-maas", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })
    const responses = GoogleVertexResponses.model("xai/grok-4.20-reasoning", {
      accessToken: "fixture",
      location: "global",
      project: "vertex-project",
    })

    expect(GoogleVertexGemini.model).toBe(GoogleVertex.model)
    expect(gemini.route.id).toBe("google-vertex-gemini")
    expect(gemini.route.protocol).toBe("gemini")
    expect(gemini.route.endpoint.baseURL).toBe("https://aiplatform.googleapis.com/v1/publishers/google")
    expect(gemini.route.defaults.headers).toEqual({ "x-application": "orbit" })
    expect(gemini.route.defaults.http?.body).toEqual({ safetySettings: [] })
    expect(
      GoogleVertex.model("gemini-3.5-flash", {
        accessToken: "fixture",
        location: "eu",
        project: "vertex-project",
      }).route.endpoint.baseURL,
    ).toBe("https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/vertex-project/locations/eu/publishers/google")
    expect(messages.route.id).toBe("google-vertex-messages")
    expect(messages.route.protocol).toBe("anthropic-messages")
    expect(messages.route.endpoint.baseURL).toBe(
      "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/anthropic/models",
    )
    expect(chat.route.id).toBe("google-vertex-chat")
    expect(chat.route.protocol).toBe("openai-chat")
    expect(chat.route.endpoint).toMatchObject({
      baseURL: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
      path: "/chat/completions",
    })
    expect(responses.route.id).toBe("google-vertex-responses")
    expect(responses.route.protocol).toBe("open-responses")
    expect(responses.route.endpoint).toMatchObject({
      baseURL: "https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/endpoints/openapi",
      path: "/responses",
    })
    expect(responses.route.defaults.providerOptions).toEqual({
      store: false,
      include: ["reasoning.encrypted_content"],
    })
  })

  test("rejects conflicting Vertex auth settings at runtime", async () => {
    const GoogleVertex = await import("@orbit/ai/providers/google-vertex")
    const GoogleVertexChat = await import("@orbit/ai/providers/google-vertex/chat")
    const GoogleVertexMessages = await import("@orbit/ai/providers/google-vertex/messages")
    const GoogleVertexResponses = await import("@orbit/ai/providers/google-vertex/responses")
    const Providers = await import("@orbit/ai/providers")
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes a statically invalid option combination.
      Reflect.apply(GoogleVertex.model, undefined, [
        "gemini-3.5-flash",
        { accessToken: "token", apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex apiKey cannot be combined with accessToken or auth"))
    // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes a statically invalid option combination.
    const configured = Reflect.apply(GoogleVertex.configure, undefined, [
      { accessToken: "token", auth: {}, project: "vertex-project" },
    ])
    expect(() => configured.model("gemini-3.5-flash")).toThrow(
      configuration("google-vertex", "Google Vertex accessToken cannot be combined with auth"),
    )
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes an unsupported authentication option.
      Reflect.apply(GoogleVertexMessages.model, undefined, [
        "claude-sonnet-4-6",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Messages does not support API keys"))
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes an unsupported authentication option.
      Reflect.apply(Providers.GoogleVertexMessages.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Messages does not support API keys"))
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes an unsupported authentication option.
      Reflect.apply(GoogleVertexChat.model, undefined, [
        "deepseek-ai/deepseek-v3.2-maas",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Chat does not support API keys"))
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes an unsupported authentication option.
      Reflect.apply(Providers.GoogleVertexChat.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Chat does not support API keys"))
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes an unsupported authentication option.
      Reflect.apply(GoogleVertexResponses.model, undefined, [
        "xai/grok-4.20-reasoning",
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Responses does not support API keys"))
    expect(() =>
      // oxlint-disable-next-line no-restricted-globals -- This test intentionally passes an unsupported authentication option.
      Reflect.apply(Providers.GoogleVertexResponses.configure, undefined, [
        { apiKey: "fixture", project: "vertex-project" },
      ]),
    ).toThrow(configuration("google-vertex", "Google Vertex Responses does not support API keys"))
  })
})
