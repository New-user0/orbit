import { afterAll, beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMClient, ProviderConfigurationError } from "../../src/index.js"
import { classifyProviderFailure } from "../../src/provider-error.js"
import { Tachyon } from "../../src/providers/tachyon.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { runtimeLayer } from "../lib/http.js"

// A local stand-in for the Apigee token endpoint and the Tachyon chat endpoint, with the rules docs/tachyon.md records.
const seen: Array<{ path: string; headers: Headers; body: string }> = []
const state = { tokens: 0, rejectToken: false }
const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const body = await request.text()
    seen.push({ path, headers: request.headers, body })
    if (path === "/oauth/token") {
      if (state.rejectToken)
        return Response.json({ errors: [{ code: "F-EAPIM-IGTWY-E40100", title: "Unauthorized" }] }, { status: 401 })
      state.tokens++
      return Response.json({ token_type: "Bearer", access_token: `token-${state.tokens}`, expires_in: 86399 })
    }
    const missing = ["x-request-id", "x-wf-request-date", "x-wf-api-key", "x-wf-usecase-id"].filter(
      (name) => !request.headers.get(name),
    )
    if (missing.length > 0)
      return Response.json({ errors: [{ code: "W-EAPIM-IGTWY-E50043", title: "Missing Header" }] }, { status: 500 })
    const parsed = JSON.parse(body)
    if (parsed.model === "broken")
      return Response.json({ errors: [{ code: "TAC006", title: "Model Execution Exception" }] }, { status: 400 })
    if (parsed.model === "blocked")
      return Response.json({ errors: [{ code: "TAC010", title: "Blocked by Model Armor" }] }, { status: 424 })
    if ("max_tokens" in parsed && "max_completion_tokens" in parsed)
      return Response.json(
        { errors: [{ code: "TAC006", title: "Model Execution Exception", detail: "bad parameters" }] },
        { status: 400 },
      )
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ]
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const root = `http://127.0.0.1:${gateway.port}`
const connection = {
  baseURL: `${root}/v1`,
  apigeeURL: `${root}/oauth/token`,
  consumerKey: "consumer",
  consumerSecret: "secret",
  apiKey: "api-key",
  usecaseId: "usecase",
}
const live = runtimeLayer(FetchHttpClient.layer)

beforeEach(() => {
  seen.length = 0
  state.rejectToken = false
  Tachyon.invalidate()
  Tachyon.resetBreaker()
})

afterAll(() => gateway.stop(true))

describe("Tachyon", () => {
  it.effect("sends exactly one output ceiling, chosen per model", () =>
    Effect.gen(function* () {
      const fields = (modelID: string) =>
        compileRequest(
          LLM.request({ model: Tachyon.model(modelID, connection), prompt: "Hi", generation: { maxTokens: 64 } }),
        ).pipe(Effect.map((compiled) => Object.keys(compiled.body).filter((key) => key.startsWith("max_"))))

      expect(yield* fields("claude-opus-4-5@20251101")).toEqual(["max_tokens"])
      expect(yield* fields("gpt-5.4")).toEqual(["max_completion_tokens"])
      expect(yield* fields("gpt4o")).toEqual(["max_tokens"])
    }),
  )

  it.live("exchanges one Apigee token and sends the gateway headers on every call", () =>
    Effect.gen(function* () {
      const model = Tachyon.model("claude-opus-4-5@20251101", connection)
      const first = yield* LLMClient.generate(LLM.request({ model, prompt: "Reply with ok" }))
      yield* LLMClient.generate(LLM.request({ model, prompt: "Reply with ok" }))

      expect(first.text).toBe("ok")
      const token = seen.filter((call) => call.path === "/oauth/token")
      expect(token).toHaveLength(1)
      expect(token[0]?.headers.get("authorization")).toBe(`Basic ${btoa("consumer:secret")}`)
      expect(token[0]?.body).toBe("grant_type=client_credentials")
      const chats = seen.filter((call) => call.path === "/v1/chat/completions")
      expect(chats).toHaveLength(2)
      for (const chat of chats) {
        expect(chat.headers.get("authorization")).toMatch(/^Bearer token-\d+$/)
        expect(chat.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
        expect(chat.headers.get("x-wf-request-date")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/)
        expect(chat.headers.get("x-wf-api-key")).toBe("api-key")
        expect(chat.headers.get("x-wf-usecase-id")).toBe("usecase")
      }
      expect(chats[0]?.headers.get("x-request-id")).not.toBe(chats[1]?.headers.get("x-request-id"))
    }).pipe(Effect.provide(live)),
  )

  it.live("exchanges a fresh token after invalidation", () =>
    Effect.gen(function* () {
      const model = Tachyon.model("gpt-5.4", connection)
      yield* LLMClient.generate(LLM.request({ model, prompt: "Hi" }))
      Tachyon.invalidate()
      yield* LLMClient.generate(LLM.request({ model, prompt: "Hi" }))

      expect(seen.filter((call) => call.path === "/oauth/token")).toHaveLength(2)
    }).pipe(Effect.provide(live)),
  )

  it.live("sends Bearer dummy without the API gateway", () =>
    Effect.gen(function* () {
      const model = Tachyon.model("gpt-5.4", {
        baseURL: connection.baseURL,
        apiKey: "api-key",
        usecaseId: "usecase",
        useApiGateway: "false",
      })
      yield* LLMClient.generate(LLM.request({ model, prompt: "Hi" }))

      expect(seen.map((call) => call.path)).toEqual(["/v1/chat/completions"])
      expect(seen[0]?.headers.get("authorization")).toBe("Bearer dummy")
    }).pipe(Effect.provide(live)),
  )

  it.live("reports a rejected token exchange as an authentication failure", () =>
    Effect.gen(function* () {
      state.rejectToken = true
      const error = yield* LLMClient.generate(
        LLM.request({ model: Tachyon.model("gpt-5.4", connection), prompt: "Hi" }),
      ).pipe(Effect.flip)

      expect(error.reason._tag).toBe("Authentication")
      expect(seen.map((call) => call.path)).toEqual(["/oauth/token"])
    }).pipe(Effect.provide(live)),
  )

  it.effect("names every missing connection setting", () =>
    Effect.sync(() => {
      expect(() => Tachyon.model("gpt-5.4", { baseURL: connection.baseURL })).toThrow(ProviderConfigurationError)
      expect(() => Tachyon.model("gpt-5.4", { baseURL: connection.baseURL })).toThrow(
        "Tachyon is missing apiKey, usecaseId, apigeeURL, consumerKey, consumerSecret",
      )
    }),
  )

  it.effect("formats the request date as local time with microseconds", () =>
    Effect.sync(() => {
      expect(Tachyon.requestDate(new Date(2026, 9, 2, 7, 5, 9, 42))).toBe("2026-10-02T07:05:09.042000")
    }),
  )
})

describe("Tachyon model fallback", () => {
  const chats = () => seen.filter((call) => call.path === "/v1/chat/completions").map((call) => JSON.parse(call.body))

  it.live("resends a failed request to the next model with that model's ceiling field", () =>
    Effect.gen(function* () {
      const model = Tachyon.model("broken", { ...connection, fallbackModels: ["gpt-5.4"] })
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Hi", generation: { maxTokens: 64 } }))

      expect(response.text).toBe("ok")
      const [first, second] = chats()
      expect(first).toMatchObject({ model: "broken", max_tokens: 64 })
      expect(second).toMatchObject({ model: "gpt-5.4", max_completion_tokens: 64 })
      expect(second).not.toHaveProperty("max_tokens")
      const ids = seen
        .filter((call) => call.path === "/v1/chat/completions")
        .map((call) => call.headers.get("x-request-id"))
      expect(ids[0]).not.toBe(ids[1])
    }).pipe(Effect.provide(live)),
  )

  it.live("skips a model whose breaker opened after repeated failures", () =>
    Effect.gen(function* () {
      const model = Tachyon.model("broken", { ...connection, fallbackModels: "claude-opus-4-5@20251101" })
      for (const _ of [1, 2, 3, 4]) yield* LLMClient.generate(LLM.request({ model, prompt: "Hi" }))

      expect(chats().map((body) => body.model)).toEqual([
        "broken",
        "claude-opus-4-5@20251101",
        "broken",
        "claude-opus-4-5@20251101",
        "broken",
        "claude-opus-4-5@20251101",
        "claude-opus-4-5@20251101",
      ])
    }).pipe(Effect.provide(live)),
  )

  it.live("does not fall back on a content block", () =>
    Effect.gen(function* () {
      const model = Tachyon.model("blocked", { ...connection, fallbackModels: ["gpt-5.4"] })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Hi" })).pipe(Effect.flip)

      expect(error.reason._tag).toBe("ContentPolicy")
      expect(chats().map((body) => body.model)).toEqual(["blocked"])
    }).pipe(Effect.provide(live)),
  )

  it.live("reports the last failure when every model fails", () =>
    Effect.gen(function* () {
      const model = Tachyon.model("broken", { ...connection, fallbackModels: ["blocked"] })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Hi" })).pipe(Effect.flip)

      expect(error.reason._tag).toBe("ContentPolicy")
      expect(chats().map((body) => body.model)).toEqual(["broken", "blocked"])
    }).pipe(Effect.provide(live)),
  )
})

describe("Tachyon failure classification", () => {
  const classify = (status: number, errors: unknown) =>
    classifyProviderFailure({ message: "Request failed", status, rawBody: JSON.stringify({ errors }) })

  it.effect("never retries model execution failures, invalid headers, or a missing header", () =>
    Effect.sync(() => {
      const crash = classify(400, [{ code: "TAC006", title: "Model Execution Exception", detail: "bad parameters" }])
      expect(crash._tag).toBe("InvalidRequest")
      expect(classify(500, [{ code: "TAC006", title: "Model Execution Exception" }])._tag).toBe("InvalidRequest")
      expect(classify(400, [{ code: "TAC002", title: "Invalid Header Data" }])._tag).toBe("InvalidRequest")
      expect(
        classify(500, [{ id: "1", status: 500, code: "W-EAPIM-IGTWY-E50043", title: "Missing Header" }])._tag,
      ).toBe("InvalidRequest")
    }),
  )

  it.effect("maps Model Armor blocks and Apigee auth codes", () =>
    Effect.sync(() => {
      for (const code of ["TAC010", "TAC011", "TAC012"])
        expect(classify(424, [{ code, title: "Blocked" }])._tag).toBe("ContentPolicy")
      expect(classify(401, [{ code: "F-EAPIM-IGTWY-E40100", title: "Unauthorized" }])._tag).toBe("Authentication")
      expect(classify(403, [{ code: "F-EAPIM-IGTWY-E40300", title: "Forbidden" }])._tag).toBe("Authentication")
      expect(classify(429, [{ code: "TAC429", title: "Too Many Requests" }])._tag).toBe("RateLimit")
    }),
  )
})
