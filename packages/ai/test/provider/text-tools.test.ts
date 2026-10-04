import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { LanguageModel, LLM, LLMClient, Message, ToolCallPart } from "../../src/index.js"
import { OpenAICompatible } from "../../src/providers/openai-compatible.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { weatherTool } from "../recorded-scenarios.js"

const native = OpenAICompatible.configure({ apiKey: "test", baseURL: "https://local.example/v1" }).model("small")
const model = LanguageModel.update(native, { compatibility: { toolCalling: "text" } })

const reply = (...texts: string[]) =>
  [
    ...texts.map((text) => ({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("") + "data: [DONE]\n\n"

describe("text tool calling", () => {
  it.effect("describes tools in the prompt and replays tool history as text", () =>
    Effect.gen(function* () {
      const compiled = yield* compileRequest(
        LLM.request({
          model,
          system: "Be brief.",
          tools: [weatherTool],
          messages: [
            Message.user("Weather in Paris?"),
            Message.assistant([ToolCallPart.make({ id: "c1", name: "get_weather", input: { city: "Paris" } })]),
            Message.tool({ id: "c1", name: "get_weather", result: { temperature: 21 } }),
            Message.tool({ id: "c2", name: "get_weather", result: "boom", resultType: "error" }),
          ],
        }),
      )
      const body = compiled.body as { tools?: unknown; messages: Array<{ role: string; content: unknown }> }

      expect(body.tools).toBeUndefined()
      expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"])
      expect(String(body.messages[0]?.content)).toContain("Be brief.")
      expect(String(body.messages[0]?.content)).toContain("### get_weather")
      expect(JSON.stringify(body.messages[2]?.content)).toContain(
        '<tool_call>\\n{\\"name\\":\\"get_weather\\",\\"arguments\\":{\\"city\\":\\"Paris\\"}}\\n</tool_call>',
      )
      const results = JSON.stringify(body.messages[3]?.content)
      expect(results).toContain('<tool_response name=\\"get_weather\\">\\n{\\"temperature\\":21}\\n</tool_response>')
      expect(results).toContain("Error: boom")
    }),
  )

  it.effect("leaves models with native tool calling unchanged", () =>
    Effect.gen(function* () {
      const compiled = yield* compileRequest(LLM.request({ model: native, prompt: "Hi", tools: [weatherTool] }))
      expect((compiled.body as { tools?: unknown[] }).tools).toHaveLength(1)
    }),
  )

  it.effect("turns tool-call blocks split across chunks into tool calls", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({ model, prompt: "Weather in Paris?", tools: [weatherTool] }),
      ).pipe(
        Effect.provide(
          fixedResponse(
            reply(
              "Let me check.<tool_",
              'call>\n{"name": "get_weather", "argu',
              'ments": {"city": "Paris"}}\n</tool_call>',
              '<tool_call>{"name": "get_weather", "parameters": "{\\"city\\": \\"Rome\\"}"}',
            ),
          ),
        ),
      )

      expect(response.text).toBe("Let me check.")
      expect(response.toolCalls.map((call) => [call.name, call.input])).toEqual([
        ["get_weather", { city: "Paris" }],
        ["get_weather", { city: "Rome" }],
      ])
      expect(response.finishReason.normalized).toBe("tool-calls")
    }),
  )

  it.effect("keeps text that only looks like the start of a tag", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Hi", tools: [weatherTool] })).pipe(
        Effect.provide(fixedResponse(reply("a < b and <tool", "box> stays text"))),
      )
      expect(response.text).toBe("a < b and <toolbox> stays text")
      expect(response.toolCalls).toEqual([])
      expect(response.finishReason.normalized).toBe("stop")
    }),
  )

  it.effect("reports a block that is not valid JSON as a malformed tool input", () =>
    Effect.gen(function* () {
      const events = yield* LLMClient.stream(LLM.request({ model, prompt: "Hi", tools: [weatherTool] })).pipe(
        Stream.runCollect,
        Effect.provide(
          fixedResponse(reply('<tool_call>{"name": "get_weather", "arguments": {city: Paris}}</tool_call>')),
        ),
      )
      expect(events.filter((event) => event.type === "tool-input-error")).toMatchObject([
        { type: "tool-input-error", name: "get_weather" },
      ])
    }),
  )
})
