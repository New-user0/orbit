import { expect } from "bun:test"
import { Agent } from "@orbit/core/agent"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { PluginPromise } from "@orbit/core/plugin/promise"
import { Tool } from "@orbit/core/tool"
import { ToolTraits } from "@orbit/core/tool/traits"
import type { Info, ToolEditor } from "@orbit/plugin/promise/tool"
import { Session } from "@orbit/schema/session"
import { SessionMessage } from "@orbit/schema/session-message"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { invalidTraits } from "../lib/tool"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.live("Promise tool executors receive interruption through their AbortSignal", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const started = yield* Deferred.make<AbortSignal>()
    yield* PluginPromise.fromPromise({
      id: "cancel-tool",
      async setup(context) {
        await context.tool.transform((editor) =>
          editor.add({
            name: "wait",
            description: "Wait until cancelled",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: (_input, context) =>
              new Promise<never>((_resolve, reject) => {
                context.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
                Effect.runSync(Deferred.succeed(started, context.signal))
              }),
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    const fiber = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_promise_tool_cancel"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_promise_tool_cancel"),
        call: { type: "tool-call", id: "call_promise_tool_cancel", name: "wait", input: {} },
      })
      .pipe(Effect.forkScoped)
    const signal = yield* Deferred.await(started)
    expect(signal.aborted).toBe(false)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(signal.aborted).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }),
)

const Mode = Schema.Struct({ mode: Schema.String })
const identity = {
  sessionID: Session.ID.make("ses_promise_tool_traits"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_promise_tool_traits"),
}
const call = (name: string, mode: string) => ({
  type: "tool-call" as const,
  id: `call_${name}_${mode}`,
  name,
  input: { mode },
})

// A Promise plugin that declares traits with each form a predicate may take: a boolean, a sync function and a Promise.
const classified = (seen: Array<Tool.ResolvedTraits>): Info<typeof Mode> => ({
  name: "classified",
  description: "Declares its traits",
  input: Mode,
  options: { codemode: false },
  traits: {
    readOnly: (input) => input.mode === "read",
    concurrencySafe: async (input) => input.mode !== "write",
    destructive: false,
    openWorld: true,
    displayName: "Classified",
  },
  execute: async (_input, context) => {
    seen.push(context.traits)
    return { content: "ok" }
  },
})

it.live("Promise tool predicates, in every form, reach the snapshot and the tool's context", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const seen: Array<Tool.ResolvedTraits> = []
    yield* PluginPromise.fromPromise({
      id: "classified-tool",
      async setup(context) {
        await context.tool.transform((editor) => editor.add(classified(seen)))
      },
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    expect(yield* snapshot.traits({ call: call("classified", "read") })).toEqual({
      ...ToolTraits.defaults,
      readOnly: true,
      concurrencySafe: true,
      openWorld: true,
      displayName: "Classified",
    })
    expect(yield* snapshot.traits({ call: call("classified", "write") })).toEqual({
      ...ToolTraits.defaults,
      concurrencySafe: false,
      openWorld: true,
      displayName: "Classified",
    })
    expect(snapshot.describe("classified")).toEqual({
      openWorld: true,
      requiresUserInteraction: false,
      cancelSiblingsOnFailure: false,
      interruptBehavior: "block",
      displayName: "Classified",
    })

    yield* snapshot.execute({ ...identity, call: call("classified", "read") })
    expect(seen).toEqual([
      { ...ToolTraits.defaults, readOnly: true, concurrencySafe: true, openWorld: true, displayName: "Classified" },
    ])
  }),
)

it.live("a Promise predicate that rejects or throws makes the call take the conservative traits", () => {
  const logger = Logger.map(Logger.formatStructured, () => {})
  return Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* PluginPromise.fromPromise({
      id: "broken-traits",
      async setup(context) {
        await context.tool.transform((editor) => {
          editor.add({
            ...classified([]),
            name: "rejects",
            traits: { readOnly: true, openWorld: true, destructive: () => Promise.reject(new Error("boom")) },
          })
          editor.add({
            ...classified([]),
            name: "throws",
            traits: {
              readOnly: true,
              cancelSiblingsOnFailure: true,
              concurrencySafe: () => {
                throw new Error("boom")
              },
            },
          })
          editor.add({
            ...classified([]),
            name: "answers",
            traits: { readOnly: () => "yes" as never, displayName: "Answers" },
          })
        })
      },
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    // What a tool declares about itself holds for the call, and everything that depends on the call is withheld.
    expect(yield* snapshot.traits({ call: call("rejects", "read") })).toEqual({
      ...ToolTraits.conservative,
      openWorld: true,
    })
    expect(yield* snapshot.traits({ call: call("throws", "read") })).toEqual({
      ...ToolTraits.conservative,
      cancelSiblingsOnFailure: true,
    })
    expect(yield* snapshot.traits({ call: call("answers", "read") })).toEqual({
      ...ToolTraits.conservative,
      displayName: "Answers",
    })
  }).pipe(Effect.provide(Logger.layer([logger])))
})

// The adapter converts a Promise plugin's traits before the registry sees them. Whatever the registry refuses must still
// reach it, so the plugin stays active, the tools beside the bad one register, and one line says what was skipped.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

for (const [name, traits, problem] of invalidTraits) {
  it.live(`a Promise plugin that adds a tool with ${name} stays active and registers the tools beside it`, () => {
    const output: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      output.push(entry.message)
    })
    return Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const tools = yield* Tool.Service
      const exit = yield* PluginPromise.fromPromise({
        id: "invalid-traits-add",
        async setup(context) {
          await context.tool.transform((editor) => {
            editor.add({ ...classified([]), name: "before" })
            editor.add({ ...classified([]), name: "broken", traits } as unknown as Info)
            editor.add({ ...classified([]), name: "after" })
          })
        },
      })
        .effect(yield* PluginHost.make(plugins))
        .pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(output).toEqual([
        [
          "Skipping invalid tool registration",
          { name: "broken", namespace: undefined, error: `Invalid tool traits broken: ${problem}` },
        ],
      ])
      const snapshot = yield* tools.snapshot()
      expect(snapshot.describe("before")).toBeDefined()
      expect(snapshot.describe("after")).toBeDefined()
      expect(snapshot.describe("broken")).toBeUndefined()
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live(`a Promise plugin update that leaves ${name} keeps the earlier definition and the plugin active`, () => {
    const output: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      output.push(entry.message)
    })
    return Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const tools = yield* Tool.Service
      const exit = yield* PluginPromise.fromPromise({
        id: "invalid-traits-update",
        async setup(context) {
          await context.tool.transform((editor) => editor.add(classified([])))
          await context.tool.transform((editor) => {
            editor.update("classified", (tool) => {
              tool.description = "Updated"
              Object.assign(tool, { traits: isRecord(traits) ? { ...tool.traits, ...traits } : traits })
            })
            editor.add({ ...classified([]), name: "after" })
          })
        },
      })
        .effect(yield* PluginHost.make(plugins))
        .pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(output).toEqual([
        [
          "Skipping invalid tool registration",
          { name: "classified", namespace: undefined, error: `Invalid tool traits classified: ${problem}` },
        ],
      ])
      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.find((definition) => definition.name === "classified")?.description).toBe(
        "Declares its traits",
      )
      expect(yield* snapshot.traits({ call: call("classified", "read") })).toEqual({
        ...ToolTraits.defaults,
        readOnly: true,
        concurrencySafe: true,
        openWorld: true,
        displayName: "Classified",
      })
      expect(snapshot.describe("after")).toBeDefined()
    }).pipe(Effect.provide(Logger.layer([logger])))
  })
}

it.live("Promise plugins read tools back with Promise predicates, and updates keep them working", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    const seen: Array<Tool.ResolvedTraits> = []
    // Each transform replays on every later registration, so these hold what the last replay read.
    const read: { listed?: Info; got?: Info; hosted?: Info } = {}
    yield* PluginPromise.fromPromise({
      id: "readback-tool",
      async setup(context) {
        await context.tool.transform((editor) => editor.add(classified(seen)))
        await context.tool.transform((editor: ToolEditor) => {
          read.listed = editor.list().find((tool) => tool.id === "classified")
          read.got = editor.get("classified")
          editor.update("classified", (tool) => {
            // The traits read back are written again, and must still work for the host.
            tool.traits = { ...tool.traits, displayName: "Updated", openWorld: false }
          })
        })
        read.hosted = (await context.tool.list()).find((tool) => tool.id === "classified")
      },
    }).effect(yield* PluginHost.make(plugins))

    for (const tool of [read.listed, read.got, read.hosted]) {
      // A Promise plugin never sees an Effect: a function predicate answers with a Promise, a boolean stays one.
      const answer = tool?.traits?.readOnly
      expect(typeof answer).toBe("function")
      if (typeof answer !== "function") continue
      const pending = answer({ mode: "read" })
      expect(pending).toBeInstanceOf(Promise)
      expect(yield* Effect.promise(async () => pending)).toBe(true)
      expect(yield* Effect.promise(async () => answer({ mode: "other" }))).toBe(false)
      expect(tool?.traits?.destructive).toBe(false)
    }
    // The editor read the tool before the update, and the host's list reads it after.
    expect([read.listed, read.got].map((tool) => tool?.traits?.displayName)).toEqual(["Classified", "Classified"])
    expect(read.hosted?.traits?.displayName).toBe("Updated")

    const snapshot = yield* tools.snapshot()
    expect(yield* snapshot.traits({ call: call("classified", "read") })).toEqual({
      ...ToolTraits.defaults,
      readOnly: true,
      concurrencySafe: true,
      displayName: "Updated",
    })
    expect(yield* snapshot.traits({ call: call("classified", "write") })).toMatchObject({
      readOnly: false,
      concurrencySafe: false,
    })
  }),
)

it.live("a Promise plugin update can remove the traits of a tool", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const tools = yield* Tool.Service
    yield* PluginPromise.fromPromise({
      id: "strip-traits",
      async setup(context) {
        await context.tool.transform((editor) => editor.add(classified([])))
        await context.tool.transform((editor) =>
          editor.update("classified", (tool) => {
            delete tool.traits
          }),
        )
      },
    }).effect(yield* PluginHost.make(plugins))

    const snapshot = yield* tools.snapshot()
    expect(yield* snapshot.traits({ call: call("classified", "read") })).toEqual(ToolTraits.defaults)
    expect(snapshot.describe("classified")).toStrictEqual({
      openWorld: false,
      requiresUserInteraction: false,
      cancelSiblingsOnFailure: false,
      interruptBehavior: "block",
    })
  }),
)
