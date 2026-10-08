import { describe, expect } from "bun:test"
import { Effect, Exit, Option, Stream } from "effect"
import { LanguageModel, LLM, LLMEvent, ToolDefinition, type FinishReason, type LLMRequest } from "../../src/index.js"
import { OpenAIChat } from "../../src/protocols/openai-chat.js"
import { configure } from "../../src/providers/openai-compatible-responses.js"
import { Auth, LLMClient } from "../../src/route.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { deltaChunk, toolCallChunk } from "../lib/openai-chunks.js"
import { sseEvents } from "../lib/sse.js"

// A response that never shows it finished must not run a call whose input was rebuilt from cut-off text, and the
// cut-off call must not be what makes the route report `tool-calls`. Two routes could do that: Open Responses for a
// response that calls itself incomplete without a recognized reason, and OpenAI Chat when its compatibility setting
// allows a stream with no finish_reason. Each row ends one of those streams, with controls that prove the call would
// have run.
const tools = [ToolDefinition.make({ name: "write", description: "Write a file", inputSchema: { type: "object" } })]
const cutOff = '{"path":"a.ts","content":"par'
const whole = '{"path":"b.ts","content":"all"}'

const run = (request: LLMRequest, body: string) =>
  Effect.gen(function* () {
    const seen: LLMEvent[] = []
    const exit = yield* LLMClient.stream(request).pipe(
      Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
      Effect.provide(fixedResponse(body)),
      Effect.exit,
    )
    return {
      seen,
      failure: Option.getOrUndefined(Exit.findErrorOption(exit)),
      calls: seen.filter(LLMEvent.is.toolCall),
      finishes: seen.filter(LLMEvent.is.finish),
    }
  })

interface Fixture {
  readonly route: string
  readonly name: string
  readonly request: LLMRequest
  /** A stream with one call per input, in order, ended the way this row ends it. */
  readonly stream: (...inputs: string[]) => string
  /** The same calls, ended the way a response that finished ends. */
  readonly finished: (...inputs: string[]) => string
  /** The raw finish reason the row's last frame carries. */
  readonly raw: string | undefined
  /** What the route reports when every call in the stream is complete. */
  readonly completeCalls: FinishReason
}

const responses = {
  request: LLM.request({
    model: configure({ apiKey: "test-key", baseURL: "https://responses.example.test/v1" }).model("example-model"),
    prompt: "Write it.",
    tools,
  }),
  // The provider closes each item with the arguments it managed to write.
  calls: (inputs: ReadonlyArray<string>) =>
    inputs.flatMap((input, index) => {
      const item = { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "write" }
      return [
        { type: "response.output_item.added", item },
        { type: "response.output_item.done", item: { ...item, arguments: input } },
      ]
    }),
  incomplete: (details: { readonly reason?: string } | null | undefined) => ({
    type: "response.incomplete",
    response: { id: "resp_1", ...(details === undefined ? {} : { incomplete_details: details }) },
  }),
  completed: { type: "response.completed", response: { id: "resp_1" } },
}
const responseRows = [
  { name: "the response is incomplete and says nothing more", details: undefined },
  { name: "the response is incomplete with null details", details: null },
  { name: "the response is incomplete with details that hold no reason", details: {} },
  { name: "the response is incomplete for a reason the route does not know", details: { reason: "interrupted" } },
].map(
  (row): Fixture => ({
    route: "Open Responses",
    name: row.name,
    request: responses.request,
    stream: (...inputs) => sseEvents(...responses.calls(inputs), responses.incomplete(row.details)),
    finished: (...inputs) => sseEvents(...responses.calls(inputs), responses.completed),
    raw: row.details?.reason,
    completeCalls: "unknown",
  }),
)

const chat = {
  request: (requireFinishReason: boolean) =>
    LLM.request({
      model: LanguageModel.update(
        OpenAIChat.route
          .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
          .model({ id: "gpt-4o-mini" }),
        { compatibility: { requireFinishReason } },
      ),
      prompt: "Write it.",
      tools,
    }),
  calls: (inputs: ReadonlyArray<string>) =>
    inputs.map((input, index) => toolCallChunk(`call_${index}`, "write", input, index)),
}
const chatRows = [
  { name: "the stream ends without a finish_reason", end: [] },
  { name: "the last chunk has an empty finish_reason", end: [deltaChunk({}, "")] },
].map(
  (row): Fixture => ({
    route: "OpenAI Chat",
    name: row.name,
    request: chat.request(false),
    stream: (...inputs) => sseEvents(...chat.calls(inputs), ...row.end),
    finished: (...inputs) => sseEvents(...chat.calls(inputs), deltaChunk({}, "tool_calls")),
    raw: undefined,
    // This route has always reported a stream of complete calls as `tool-calls`, finish_reason or not.
    completeCalls: "tool-calls",
  }),
)

describe("a response that does not show it finished", () => {
  ;[...responseRows, ...chatRows].forEach((row) => {
    it.effect(`${row.route} drops a call cut off mid-argument when ${row.name}`, () =>
      Effect.gen(function* () {
        const result = yield* run(row.request, row.stream(cutOff))

        expect(result.failure).toBeUndefined()
        // Counted first: Bun's toEqual takes a list of `undefined` markers for an empty list.
        expect(result.calls).toHaveLength(0)
        // The input stays visible as started and never called, for the consumer to settle.
        expect(result.seen.filter(LLMEvent.is.toolInputEnd)).toHaveLength(1)
        expect(result.finishes).toHaveLength(1)
        expect(result.finishes[0].reason).toEqual({ normalized: "unknown", raw: row.raw })
      }),
    )

    it.effect(`${row.route} runs a complete call beside a cut-off one when ${row.name}`, () =>
      Effect.gen(function* () {
        const result = yield* run(row.request, row.stream(whole, cutOff))

        expect(result.calls).toHaveLength(1)
        expect(result.calls[0]).toMatchObject({ id: "call_0", name: "write", input: { path: "b.ts", content: "all" } })
        expect(result.calls[0].partialInput).toBeUndefined()
        expect(result.seen.filter(LLMEvent.is.toolInputEnd)).toHaveLength(2)
        expect(result.finishes[0].reason.normalized).toBe("unknown")
      }),
    )

    it.effect(`${row.route} still runs a complete call when ${row.name}`, () =>
      Effect.gen(function* () {
        const result = yield* run(row.request, row.stream(whole))

        expect(result.calls).toHaveLength(1)
        expect(result.calls[0]).toMatchObject({ id: "call_0", name: "write", input: { path: "b.ts", content: "all" } })
        expect(result.calls[0].partialInput).toBeUndefined()
        expect(result.finishes[0].reason.normalized).toBe(row.completeCalls)
      }),
    )

    // The control: without it, a dropped call could mean that the fixture never produced one.
    it.effect(`${row.route} runs the same cut-off call once the response finishes`, () =>
      Effect.gen(function* () {
        const result = yield* run(row.request, row.finished(cutOff))

        expect(result.calls).toHaveLength(1)
        expect(result.calls[0]).toMatchObject({
          id: "call_0",
          name: "write",
          input: { path: "a.ts", content: "par" },
          partialInput: true,
        })
        expect(result.finishes[0].reason.normalized).toBe("tool-calls")
      }),
    )
  })

  it.effect("OpenAI Chat fails a stream without a finish_reason by default and never calls the cut-off call", () =>
    Effect.gen(function* () {
      const result = yield* run(chat.request(true), sseEvents(...chat.calls([cutOff])))

      expect(result.failure).toMatchObject({
        reason: { _tag: "InvalidProviderOutput", classification: "incomplete-stream" },
      })
      expect(result.calls).toHaveLength(0)
      expect(result.finishes).toHaveLength(0)
    }),
  )
})
