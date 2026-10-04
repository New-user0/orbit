import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Provider } from "@orbit/core/provider"

describe("Provider", () => {
  test("loads bundled native provider entrypoints", async () => {
    const packages = [
      "@orbit/ai/providers/baseten",
      "@orbit/ai/providers/cerebras",
      "@orbit/ai/providers/cloudflare-ai-gateway",
      "@orbit/ai/providers/cloudflare-workers-ai",
      "@orbit/ai/providers/deepinfra",
      "@orbit/ai/providers/deepseek",
      "@orbit/ai/providers/fireworks",
      "@orbit/ai/providers/google-vertex",
      "@orbit/ai/providers/google-vertex/gemini",
      "@orbit/ai/providers/google-vertex/chat",
      "@orbit/ai/providers/google-vertex/responses",
      "@orbit/ai/providers/google-vertex/messages",
      "@orbit/ai/providers/groq",
      "@orbit/ai/providers/mistral",
      "@orbit/ai/providers/togetherai",
    ]

    for (const specifier of packages) {
      const loaded = await Effect.runPromise(Provider.loadPackage(specifier))
      expect(loaded.model).toBeFunction()
    }
  })

  test("passes flat settings to native packages without Core settings", () => {
    expect(
      Provider.nativeSettings({
        apiKey: "secret",
        reasoningEffort: "high",
        chunkTimeout: 1000,
        compaction: { type: "native" },
        transport: "websocket",
      }),
    ).toEqual({
      apiKey: "secret",
      reasoningEffort: "high",
    })
  })

  test("inherits shared and loose settings without provider-only policies", () => {
    expect(
      Provider.modelSettings({
        timeout: 60_000,
        chunkTimeout: 30_000,
        transport: "websocket",
        compaction: { type: "native" },
        reasoningEffort: "high",
      }),
    ).toEqual({
      compaction: { type: "native" },
      reasoningEffort: "high",
    })
  })
})
