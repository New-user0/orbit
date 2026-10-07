import { describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { Provider } from "@orbit/core/provider"
import { tmpdir } from "./fixture/tmpdir"

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

  // provider-compiled.test.ts covers the same specifiers inside a compiled binary, where a name is never looked up.
  test("loads a package from a file: URL and reports a name that is neither built in nor installed", async () => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "provider.mjs")
    await Bun.write(file, "export const model = () => ({})\n")

    const loaded = await Effect.runPromise(Provider.loadPackage(pathToFileURL(file).href))
    expect(loaded.model).toBeFunction()

    const missing = await Effect.runPromise(
      Provider.loadPackage("orbit-provider-that-is-not-installed").pipe(Effect.flip),
    )
    expect(String(missing.cause)).toBe("Error: Provider package orbit-provider-that-is-not-installed is not installed")
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
