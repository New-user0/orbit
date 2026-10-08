import { describe, expect, test } from "bun:test"
import { Effect, Exit, Logger, Stream } from "effect"
import { AIError, FinishReason, LLMEvent, UnknownProviderError } from "../src/schema/index.js"
import { ToolStream } from "../src/protocols/utils/tool-stream.js"
import { it } from "./lib/effect.js"

const ADAPTER = "test-route"

describe("ToolStream", () => {
  it.effect("starts from OpenAI-style deltas and finalizes parsed input", () =>
    Effect.gen(function* () {
      const first = ToolStream.appendOrStart(
        ADAPTER,
        ToolStream.empty<number>(),
        0,
        { id: "call_1", name: "lookup", text: '{"query"' },
        "missing tool",
      )
      if (ToolStream.isError(first)) return yield* first
      const second = ToolStream.appendOrStart(ADAPTER, first.tools, 0, { text: ':"weather"}' }, "missing tool")
      if (ToolStream.isError(second)) return yield* second
      const finished = yield* ToolStream.finish(ADAPTER, second.tools, 0)

      expect(first.events).toEqual([
        { type: "tool-input-start", id: "call_1", name: "lookup" },
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: '{"query"', input: {} },
      ])
      expect(second.events).toEqual([
        { type: "tool-input-delta", id: "call_1", name: "lookup", text: ':"weather"}', input: { query: "weather" } },
      ])
      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_1", name: "lookup" },
          { type: "tool-call", id: "call_1", name: "lookup", input: { query: "weather" } },
        ],
      })
    }),
  )

  test("exposes cumulative partial string values", () => {
    const result = ToolStream.appendOrStart(
      ADAPTER,
      ToolStream.empty<number>(),
      0,
      { id: "call_1", name: "lookup", text: '{"query":"wea' },
      "missing tool",
    )
    if (ToolStream.isError(result)) throw result

    expect(result.events.at(-1)).toEqual({
      type: "tool-input-delta",
      id: "call_1",
      name: "lookup",
      text: '{"query":"wea',
      input: { query: "wea" },
    })
  })

  test("defaults partial input to an empty object when the accumulated value cannot be parsed", () => {
    const result = ToolStream.appendOrStart(
      ADAPTER,
      ToolStream.empty<number>(),
      0,
      { id: "call_1", name: "lookup", text: "x" },
      "missing tool",
    )
    if (ToolStream.isError(result)) throw result

    expect(result.events).toEqual([
      { type: "tool-input-start", id: "call_1", name: "lookup" },
      { type: "tool-input-delta", id: "call_1", name: "lookup", text: "x", input: {} },
    ])
  })

  it.effect("keeps accumulated identity when later deltas contain empty strings", () =>
    Effect.gen(function* () {
      const first = ToolStream.appendOrStart(
        ADAPTER,
        ToolStream.empty<number>(),
        0,
        { id: "call_1", name: "lookup", text: '{"query"' },
        "missing tool",
      )
      if (ToolStream.isError(first)) return yield* first
      const second = ToolStream.appendOrStart(
        ADAPTER,
        first.tools,
        0,
        { id: "", name: "", text: ':"weather"}' },
        "missing tool",
      )
      if (ToolStream.isError(second)) return yield* second
      const finished = yield* ToolStream.finish(ADAPTER, second.tools, 0)

      expect(finished.events).toEqual([
        { type: "tool-input-end", id: "call_1", name: "lookup" },
        { type: "tool-call", id: "call_1", name: "lookup", input: { query: "weather" } },
      ])
    }),
  )

  test("fails appendExisting when the provider skipped the tool start", () => {
    const error = ToolStream.appendExisting(ADAPTER, ToolStream.empty<number>(), 0, "{}", "missing tool")

    expect(error).toBeInstanceOf(AIError)
    if (ToolStream.isError(error)) expect(error.message).toBe("missing tool")
  })

  it.effect("uses final input override without losing accumulated deltas", () =>
    Effect.gen(function* () {
      const tools = ToolStream.start(ToolStream.empty<string>(), "item_1", {
        id: "call_1",
        name: "lookup",
        input: '{"query":"partial"}',
      })
      const finished = yield* ToolStream.finishWithInput(ADAPTER, tools, "item_1", '{"query":"final"}')

      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_1", name: "lookup" },
          { type: "tool-call", id: "call_1", name: "lookup", input: { query: "final" } },
        ],
      })
    }),
  )

  it.effect("finalizes incomplete local input using the partial JSON parser", () =>
    Effect.gen(function* () {
      const tools = ToolStream.start(ToolStream.empty<string>(), "item_1", {
        id: "call_1",
        name: "lookup",
        input: '{"query":"partial',
      })
      const finished = yield* ToolStream.finish(ADAPTER, tools, "item_1")

      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_1", name: "lookup" },
          { type: "tool-call", id: "call_1", name: "lookup", input: { query: "partial" }, partialInput: true },
        ],
      })
    }),
  )

  it.effect("repairs malformed string escapes in final local input", () =>
    Effect.gen(function* () {
      const tools = ToolStream.start(ToolStream.empty<string>(), "item_1", {
        id: "call_1",
        name: "lookup",
        input: '{"path":"A\\H","text":"first\tsecond"}',
      })
      const finished = yield* ToolStream.finish(ADAPTER, tools, "item_1")

      expect(finished.events).toEqual([
        { type: "tool-input-end", id: "call_1", name: "lookup" },
        {
          type: "tool-call",
          id: "call_1",
          name: "lookup",
          input: { path: "A\\H", text: "first\tsecond" },
          partialInput: true,
        },
      ])
    }),
  )

  it.effect("defaults unrecoverable local input to an empty object", () =>
    Effect.gen(function* () {
      const tools = ToolStream.start(ToolStream.empty<string>(), "item_1", {
        id: "call_1",
        name: "lookup",
        input: "invalid",
      })
      const finished = yield* ToolStream.finish(ADAPTER, tools, "item_1")

      expect(finished.events).toEqual([
        { type: "tool-input-end", id: "call_1", name: "lookup" },
        { type: "tool-call", id: "call_1", name: "lookup", input: {}, partialInput: true },
      ])
    }),
  )

  it.effect("recovers incomplete input alongside valid parallel tool calls", () =>
    Effect.gen(function* () {
      const valid = ToolStream.start(ToolStream.empty<number>(), 0, {
        id: "call_valid",
        name: "lookup",
        input: '{"query":"weather"}',
      })
      const tools = ToolStream.start(valid, 1, {
        id: "call_invalid",
        name: "lookup",
        input: '{"query":"partial',
      })
      const finished = yield* ToolStream.finishAll(ADAPTER, tools)

      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_valid", name: "lookup" },
          { type: "tool-call", id: "call_valid", name: "lookup", input: { query: "weather" } },
          { type: "tool-input-end", id: "call_invalid", name: "lookup" },
          { type: "tool-call", id: "call_invalid", name: "lookup", input: { query: "partial" }, partialInput: true },
        ],
      })
    }),
  )

  it.effect("keeps malformed provider-executed input terminal", () =>
    Effect.gen(function* () {
      const tools = ToolStream.start(ToolStream.empty<string>(), "item_1", {
        id: "call_1",
        name: "web_search",
        input: '{"query":"partial',
        providerExecuted: true,
      })
      const result = yield* Effect.exit(ToolStream.finish(ADAPTER, tools, "item_1"))

      expect(result._tag).toBe("Failure")
    }),
  )

  it.effect("preserves providerExecuted and clears all tools", () =>
    Effect.gen(function* () {
      const first: ToolStream.State<number> = ToolStream.start(ToolStream.empty<number>(), 0, {
        id: "call_1",
        name: "lookup",
        input: "{}",
      })
      const tools = ToolStream.start(first, 1, {
        id: "call_2",
        name: "web_search",
        input: '{"query":"docs"}',
        providerExecuted: true,
      })
      const finished = yield* ToolStream.finishAll(ADAPTER, tools)

      expect(finished).toEqual({
        tools: {},
        events: [
          { type: "tool-input-end", id: "call_1", name: "lookup" },
          { type: "tool-call", id: "call_1", name: "lookup", input: {} },
          { type: "tool-input-end", id: "call_2", name: "web_search" },
          {
            type: "tool-call",
            id: "call_2",
            name: "web_search",
            input: { query: "docs" },
            providerExecuted: true,
          },
        ],
      })
    }),
  )
})

describe("ToolStream partial input marker", () => {
  const started = (input: string, providerExecuted?: boolean) =>
    ToolStream.start(ToolStream.empty<string>(), "item_1", { id: "call_1", name: "write", input, providerExecuted })
  // Every way a call is finalized goes through the same decision, so each one is checked against the same inputs.
  const finalizers = {
    finish: (input: string, providerExecuted?: boolean) =>
      ToolStream.finish(ADAPTER, started(input, providerExecuted), "item_1"),
    finishWithInput: (input: string, providerExecuted?: boolean) =>
      ToolStream.finishWithInput(ADAPTER, started("", providerExecuted), "item_1", input),
    finishAll: (input: string, providerExecuted?: boolean) =>
      ToolStream.finishAll(ADAPTER, started(input, providerExecuted)),
  }
  const inputs: ReadonlyArray<{ name: string; input: string; marked: boolean; hostedFails?: boolean }> = [
    { name: "complete JSON", input: '{"path":"a.ts"}', marked: false },
    // Marked for a local call so it waits for the finish. A provider-executed one already ran: nothing is left to hold.
    { name: "no arguments", input: "", marked: true, hostedFails: false },
    { name: "JSON cut off in a string", input: '{"path":"a.ts","content":"par', marked: true },
    { name: "JSON cut off after a key", input: '{"path":', marked: true },
    { name: "a malformed escape", input: '{"path":"A\\H"}', marked: true },
    { name: "text that is not JSON", input: "invalid", marked: true },
  ]

  Object.entries(finalizers).forEach(([finalizer, finalize]) => {
    inputs.forEach((fixture) => {
      it.effect(`${finalizer} ${fixture.marked ? "marks" : "does not mark"} ${fixture.name}`, () =>
        Effect.gen(function* () {
          const calls = ((yield* finalize(fixture.input)).events ?? []).filter(LLMEvent.is.toolCall)

          expect(calls).toHaveLength(1)
          expect(calls[0].partialInput).toBe(fixture.marked ? true : undefined)
        }),
      )

      it.effect(
        `${finalizer} keeps provider-executed ${fixture.name} ${(fixture.hostedFails ?? fixture.marked) ? "terminal" : "unmarked"}`,
        () =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(finalize(fixture.input, true))

            if (fixture.hostedFails ?? fixture.marked) return expect(Exit.isFailure(exit)).toBe(true)
            const calls = Exit.isSuccess(exit) ? (exit.value.events ?? []).filter(LLMEvent.is.toolCall) : []
            expect(calls).toHaveLength(1)
            expect(calls[0].partialInput).toBeUndefined()
          }),
      )
    })
  })
})

describe("ToolStream.gateOnFinish", () => {
  const input = (id: string) => [
    LLMEvent.toolInputStart({ id, name: "write" }),
    LLMEvent.toolInputEnd({ id, name: "write" }),
  ]
  const recovered = (id: string) =>
    LLMEvent.toolCall({ id, name: "write", input: { path: "a.ts" }, partialInput: true })
  const whole = (id: string) => LLMEvent.toolCall({ id, name: "read", input: { path: "b.ts" } })
  const hosted = (id: string) =>
    LLMEvent.toolCall({ id, name: "web_search", input: { query: "q" }, providerExecuted: true })
  const stepFinish = (normalized: FinishReason) => LLMEvent.stepFinish({ index: 0, reason: { normalized } })
  const finish = (normalized: FinishReason) => LLMEvent.finish({ reason: { normalized } })
  const failure = new AIError({ reason: new UnknownProviderError({ message: "stream failed" }) })

  const gate = (events: Stream.Stream<LLMEvent, AIError>) =>
    Effect.gen(function* () {
      const seen: LLMEvent[] = []
      const exit = yield* events.pipe(
        ToolStream.gateOnFinish,
        Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
        Effect.exit,
      )
      return { seen, exit }
    })
  const script = (...events: LLMEvent[]) => Stream.fromIterable(events)

  const verdicts = {
    "tool-calls": "released",
    stop: "released",
    length: "dropped",
    "content-filter": "dropped",
    error: "dropped",
    unknown: "dropped",
  } satisfies Record<FinishReason, "released" | "dropped">

  FinishReason.literals.forEach((reason) => {
    it.effect(`${verdicts[reason]} a recovered call when the response finishes with ${reason}`, () =>
      Effect.gen(function* () {
        const call = recovered("call_1")
        const result = yield* gate(
          script(LLMEvent.stepStart({ index: 0 }), ...input("call_1"), call, stepFinish(reason), finish(reason)),
        )

        expect(Exit.isSuccess(result.exit)).toBe(true)
        expect(result.seen).toEqual([
          LLMEvent.stepStart({ index: 0 }),
          ...input("call_1"),
          // A released call is the event right before the step finish, and a dropped one leaves only its input events.
          ...(verdicts[reason] === "released" ? [call] : []),
          stepFinish(reason),
          finish(reason),
        ])
      }),
    )
  })

  it.effect("drops a recovered call when the stream fails before a finish", () =>
    Effect.gen(function* () {
      const result = yield* gate(
        script(...input("call_1"), recovered("call_1")).pipe(Stream.concat(Stream.fail(failure))),
      )

      expect(result.seen).toEqual(input("call_1"))
      expect(result.exit).toEqual(Exit.fail(failure))
    }),
  )

  it.effect("drops a recovered call when the stream ends without a finish", () =>
    Effect.gen(function* () {
      const result = yield* gate(script(...input("call_1"), recovered("call_1")))

      expect(result.seen).toEqual(input("call_1"))
      expect(Exit.isSuccess(result.exit)).toBe(true)
    }),
  )

  it.effect("passes calls without the marker unchanged and in order", () =>
    Effect.gen(function* () {
      const [first, second, search] = [whole("call_1"), whole("call_3"), hosted("call_4")]
      const held = recovered("call_2")
      const result = yield* gate(script(first, held, second, search, stepFinish("tool-calls"), finish("tool-calls")))

      expect(result.seen).toEqual([first, second, search, held, stepFinish("tool-calls"), finish("tool-calls")])
      expect(result.seen.slice(0, 3)).toEqual([first, second, search])
      expect(result.seen[0]).toBe(first)
    }),
  )

  it.effect("passes unmarked calls when the response is cut off", () =>
    Effect.gen(function* () {
      const result = yield* gate(script(whole("call_1"), recovered("call_2"), stepFinish("length"), finish("length")))

      expect(result.seen).toEqual([whole("call_1"), stepFinish("length"), finish("length")])
    }),
  )

  it.effect("releases several recovered calls in the order they arrived", () =>
    Effect.gen(function* () {
      const calls = ["call_1", "call_2", "call_3"].map(recovered)
      const result = yield* gate(script(...calls, stepFinish("stop"), finish("stop")))

      expect(result.seen).toEqual([...calls, stepFinish("stop"), finish("stop")])
    }),
  )

  it.effect("passes a recovered call that arrives after a releasing finish", () =>
    Effect.gen(function* () {
      const late = recovered("call_late")

      // Nothing is left to wait for, so the call is not held for a finish that never comes.
      expect((yield* gate(script(stepFinish("tool-calls"), finish("tool-calls"), late))).seen).toEqual([
        stepFinish("tool-calls"),
        finish("tool-calls"),
        late,
      ])
      expect((yield* gate(script(stepFinish("stop"), late, finish("stop")))).seen).toEqual([
        stepFinish("stop"),
        late,
        finish("stop"),
      ])
    }),
  )

  it.effect("keeps holding a recovered call that arrives after a finish that dropped", () =>
    Effect.gen(function* () {
      const late = recovered("call_late")

      expect((yield* gate(script(stepFinish("length"), late))).seen).toEqual([stepFinish("length")])
      // The latest finish decides, so an earlier clean finish does not vouch for a later cut-off one.
      expect((yield* gate(script(stepFinish("tool-calls"), stepFinish("length"), late))).seen).toEqual([
        stepFinish("tool-calls"),
        stepFinish("length"),
      ])
    }),
  )

  // Each step is decided by its own finish. A hand-scripted or multi-step stream is the only way to reach this: every
  // route ends its response after one step.
  const steps = [
    {
      name: "a step that dropped, then one that released",
      finishes: ["length", "tool-calls"],
      released: [false, true],
    },
    {
      name: "a step that released, then one that dropped",
      finishes: ["tool-calls", "length"],
      released: [true, false],
    },
    {
      name: "a step that released, then one that released",
      finishes: ["stop", "tool-calls"],
      released: [true, true],
    },
    {
      name: "a step that dropped, then one that dropped",
      finishes: ["unknown", "content-filter"],
      released: [false, false],
    },
  ] as const
  steps.forEach((row) => {
    it.effect(`decides a recovered call by the finish of its own step: ${row.name}`, () =>
      Effect.gen(function* () {
        const calls = [recovered("call_1"), recovered("call_2")]
        const result = yield* gate(
          script(
            ...row.finishes.flatMap((reason, index) => [
              LLMEvent.stepStart({ index }),
              calls[index],
              stepFinish(reason),
            ]),
          ),
        )

        expect(result.seen).toEqual(
          row.finishes.flatMap((reason, index) => [
            LLMEvent.stepStart({ index }),
            ...(row.released[index] ? [calls[index]] : []),
            stepFinish(reason),
          ]),
        )
      }),
    )
  })

  it.effect("holds a recovered call in a new step even after a releasing finish let a late one through", () =>
    Effect.gen(function* () {
      const [late, next] = [recovered("call_late"), recovered("call_next")]
      const result = yield* gate(
        script(
          LLMEvent.stepStart({ index: 0 }),
          stepFinish("tool-calls"),
          late,
          LLMEvent.stepStart({ index: 1 }),
          next,
          stepFinish("length"),
        ),
      )

      expect(result.seen).toEqual([
        LLMEvent.stepStart({ index: 0 }),
        stepFinish("tool-calls"),
        late,
        LLMEvent.stepStart({ index: 1 }),
        stepFinish("length"),
      ])
    }),
  )

  it.effect("lets the finish event decide when a stream has no step finish", () =>
    Effect.gen(function* () {
      const call = recovered("call_1")

      expect((yield* gate(script(call, finish("tool-calls")))).seen).toEqual([call, finish("tool-calls")])
      expect((yield* gate(script(call, finish("length")))).seen).toEqual([finish("length")])
    }),
  )

  it.effect("logs one warning for the calls it drops, and none for calls it releases or never held", () =>
    Effect.gen(function* () {
      const warnings: string[] = []
      const logger = Logger.make((entry) => {
        if (entry.logLevel !== "Warn") return
        warnings.push(String(Array.isArray(entry.message) ? entry.message[0] : entry.message))
      })
      yield* Effect.gen(function* () {
        yield* gate(script(recovered("call_1"), recovered("call_2"), stepFinish("length"), finish("length")))
        yield* gate(script(recovered("call_1"), stepFinish("tool-calls"), finish("tool-calls")))
        yield* gate(script(whole("call_1"), stepFinish("length"), finish("length")))
      }).pipe(Effect.provide(Logger.layer([logger])))

      expect(warnings).toEqual([
        'Dropped 2 tool call(s) rebuilt from incomplete input: the response finished with "length"',
      ])
    }),
  )
})
