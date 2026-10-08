import { describe, expect } from "bun:test"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Image } from "@orbit/core/image"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionModelRequest } from "@orbit/core/session/model-request"
import { SessionModelTransport } from "@orbit/core/session/model-transport"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { Tool } from "@orbit/core/tool"
import { ToolTraits } from "@orbit/core/tool/traits"
import { Money } from "@orbit/schema/money"
import type { Info } from "@orbit/schema/tool"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, SchemaGetter } from "effect"
import { testEffect } from "./lib/effect"
import { allowAllPermission } from "./lib/permission"
import { invalidTraits } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const registryLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, PluginHooks.node]), [
  Image.node.replace(Layer.mock(Image.Service, { normalize: () => Effect.die("unused") })),
  Permission.node.replace(allowAllPermission),
])
const it = testEffect(registryLayer)

// "5" decodes to 5, so a predicate that compares numbers proves it was handed the decoded value.
const Input = Schema.Struct({ count: Schema.FiniteFromString })
type Echo = Info<typeof Input>

const sessionID = Session.ID.make("ses_traits")
const identity = { agent: Agent.ID.make("build"), messageID: SessionMessage.ID.make("msg_traits") }
const toolCall = (name: string, input: unknown = { count: "5" }) => ({
  type: "tool-call" as const,
  id: `call-${name}`,
  name,
  input,
})
const make = (traits?: Echo["traits"], seen?: Array<Tool.ResolvedTraits>): Echo => ({
  name: "echo",
  description: "Echo the count",
  input: Input,
  execute: ({ count }, context) =>
    Effect.sync(() => void seen?.push(context.traits)).pipe(Effect.as({ content: String(count) })),
  traits,
})
const register = (service: Tool.Interface, tool: Info) =>
  service.transform((editor) => editor.add({ ...tool, options: { codemode: false } }))

// What a tool says about itself whatever the call is.
const fixed = {
  openWorld: true,
  requiresUserInteraction: true,
  cancelSiblingsOnFailure: true,
  interruptBehavior: "cancel",
  maxResultChars: Infinity,
  searchHint: "find a count",
  displayName: "Counter",
} satisfies NonNullable<Echo["traits"]>

const declared = {
  readOnly: true,
  concurrencySafe: true,
  destructive: false,
  ...fixed,
} satisfies NonNullable<Echo["traits"]>

// A call of that tool whose traits cannot be resolved: what it says about itself still holds, and the answers that
// depend on the call are the conservative ones.
const withheld = {
  ...fixed,
  readOnly: false,
  concurrencySafe: false,
  destructive: true,
  interruptBehavior: "block",
} satisfies Tool.ResolvedTraits

describe("ToolTraits", () => {
  it.effect("pins the default and conservative records", () =>
    Effect.sync(() => {
      expect(ToolTraits.defaults).toEqual({
        readOnly: false,
        concurrencySafe: false,
        destructive: false,
        openWorld: false,
        requiresUserInteraction: false,
        cancelSiblingsOnFailure: false,
        interruptBehavior: "block",
      })
      expect(ToolTraits.conservative).toEqual({
        readOnly: false,
        concurrencySafe: false,
        destructive: true,
        openWorld: false,
        requiresUserInteraction: false,
        cancelSiblingsOnFailure: false,
        interruptBehavior: "block",
      })
    }),
  )

  it.effect("resolves a tool without traits to the defaults and copies static traits", () =>
    Effect.gen(function* () {
      expect(yield* ToolTraits.resolve(make(), { count: 5 })).toEqual(ToolTraits.defaults)
      expect(yield* ToolTraits.resolve(make({}), { count: 5 })).toEqual(ToolTraits.defaults)
      expect(yield* ToolTraits.resolve(make(declared), { count: 5 })).toEqual(declared)
      // Optional traits are present only when declared, and a false boolean is a declaration.
      const partial = yield* ToolTraits.resolve(make({ readOnly: false, openWorld: false }), { count: 5 })
      expect(Object.keys(partial).toSorted()).toEqual(Object.keys(ToolTraits.defaults).toSorted())
    }),
  )

  it.effect("returns a fresh record, never the shared constants", () =>
    Effect.gen(function* () {
      const first = yield* ToolTraits.resolve(make(), { count: 5 })
      expect(first).not.toBe(ToolTraits.defaults)
      expect(yield* ToolTraits.resolve(make(), { count: 5 })).not.toBe(first)
      expect(yield* ToolTraits.resolve(make({ readOnly: () => Effect.fail("boom") }), { count: 5 })).not.toBe(
        ToolTraits.conservative,
      )
      expect(ToolTraits.conservativeFor(make())).not.toBe(ToolTraits.conservative)
      expect(ToolTraits.conservativeFor(make())).not.toBe(ToolTraits.conservativeFor(make()))
    }).pipe(Effect.provide(Logger.layer([]))),
  )

  it.effect("keeps the shared records out of reach of a write", () =>
    Effect.sync(() => {
      // One stray write would otherwise make every later unresolvable call read-only or parallel. Frozen is checked
      // first so that a failure here never lets the write below reach the real record.
      for (const shared of [ToolTraits.defaults, ToolTraits.conservative]) {
        expect(Object.isFrozen(shared)).toBe(true)
        expect(() => {
          ;(shared as { readOnly: boolean }).readOnly = true
        }).toThrow(TypeError)
        expect(shared.readOnly).toBe(false)
      }
    }),
  )

  it.effect("keeps what a tool declares about itself in the conservative traits of one of its calls", () =>
    Effect.sync(() => {
      expect(ToolTraits.conservativeFor(make(declared))).toEqual(withheld)
      expect(ToolTraits.conservativeFor(make({ readOnly: true, concurrencySafe: true }))).toEqual(
        ToolTraits.conservative,
      )
      // Optional traits are present only when declared.
      expect(ToolTraits.conservativeFor(make())).toStrictEqual({ ...ToolTraits.conservative })
    }),
  )

  it.effect("evaluates predicates, direct or from an Effect, on the decoded input", () =>
    Effect.gen(function* () {
      const inputs: unknown[] = []
      const tool = make({
        readOnly: (input) => {
          inputs.push(input)
          return input.count > 3
        },
        concurrencySafe: (input) => Effect.sync(() => input.count > 3),
        destructive: (input) => input.count < 3,
      })
      expect(yield* ToolTraits.resolve(tool, { count: 5 })).toEqual({
        ...ToolTraits.defaults,
        readOnly: true,
        concurrencySafe: true,
        destructive: false,
      })
      expect(yield* ToolTraits.resolve(tool, { count: 1 })).toEqual({
        ...ToolTraits.defaults,
        readOnly: false,
        concurrencySafe: false,
        destructive: true,
      })
      expect(inputs).toEqual([{ count: 5 }, { count: 1 }])
    }),
  )

  it.effect("types predicates by the decoded input", () =>
    Effect.sync(() => {
      const typed: Echo = make({ readOnly: (input) => input.count > 1 })
      // @ts-expect-error Predicates receive the decoded input, which has no `nope`.
      const wrong: Echo = make({ readOnly: (input) => input.nope })
      // @ts-expect-error A predicate answers with a boolean, not a string.
      const text: Echo = make({ readOnly: () => "yes" })
      expect([typed, wrong, text]).toHaveLength(3)
    }),
  )

  describe("a predicate that cannot be resolved", () => {
    const sync = (message: string) => () => {
      throw new Error(message)
    }
    const cases: ReadonlyArray<readonly [string, Echo["traits"], "readOnly" | "concurrencySafe" | "destructive"]> = [
      ["throws", { readOnly: sync("boom") }, "readOnly"],
      ["fails", { readOnly: () => Effect.fail("boom") }, "readOnly"],
      ["dies", { readOnly: () => Effect.die(new Error("boom")) }, "readOnly"],
      ["answers with a string", { readOnly: () => "yes" as never }, "readOnly"],
      ["answers with a number", { readOnly: () => 1 as never }, "readOnly"],
      ["answers with nothing", { readOnly: () => undefined as never }, "readOnly"],
      ["answers with a Promise", { readOnly: () => Promise.resolve(true) as never }, "readOnly"],
      ["answers through an Effect with a non-boolean", { readOnly: () => Effect.succeed("yes") as never }, "readOnly"],
      ["is not a function or a boolean", { readOnly: "yes" as never }, "readOnly"],
      [
        "fails beside a predicate that answered true",
        { readOnly: true, concurrencySafe: sync("boom") },
        "concurrencySafe",
      ],
      [
        "fails after the others answered true",
        { readOnly: () => true, concurrencySafe: true, destructive: () => Effect.fail("boom") },
        "destructive",
      ],
    ]

    for (const [name, traits, trait] of cases) {
      it.effect(`resolves the call conservatively and logs once when one ${name}`, () => {
        const output: Array<ReadonlyArray<unknown>> = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          output.push(entry.message as ReadonlyArray<unknown>)
        })
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(ToolTraits.resolve(make({ ...traits, ...fixed }), { count: 5 }))
          expect(Exit.isSuccess(exit)).toBe(true)
          // Every answer that depends on the call is conservative, including the ones that came out true. What the tool
          // declares about itself does not depend on the call, so a broken predicate does not take a caution away.
          if (Exit.isSuccess(exit)) expect(exit.value).toEqual(withheld)
          expect(output).toEqual([
            [
              "Tool trait could not be resolved; the call takes the conservative traits",
              expect.objectContaining({ tool: "echo", trait }),
            ],
          ])
        }).pipe(Effect.provide(Logger.layer([logger])))
      })
    }

    it.effect("never leaves a true readOnly in place for the call", () =>
      Effect.gen(function* () {
        const resolved = yield* ToolTraits.resolve(
          make({ readOnly: true, concurrencySafe: true, destructive: () => Effect.fail("boom") }),
          { count: 5 },
        )
        expect(resolved.readOnly).toBe(false)
        expect(resolved.concurrencySafe).toBe(false)
        expect(resolved.destructive).toBe(true)
      }).pipe(Effect.provide(Logger.layer([]))),
    )

    it.effect("passes interrupts through instead of resolving", () =>
      Effect.gen(function* () {
        const output: unknown[] = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          output.push(entry.message)
        })
        yield* Effect.gen(function* () {
          const inside = yield* Effect.exit(
            ToolTraits.resolve(make({ readOnly: () => Effect.interrupt }), { count: 5 }),
          )
          expect(Exit.isFailure(inside) && Cause.hasInterrupts(inside.cause)).toBe(true)

          const started = yield* Deferred.make<void>()
          const fiber = yield* ToolTraits.resolve(
            make({ concurrencySafe: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) }),
            { count: 5 },
          ).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          const outside = yield* Fiber.await(fiber)
          expect(Exit.isFailure(outside) && Cause.hasInterruptsOnly(outside.cause)).toBe(true)
        }).pipe(Effect.provide(Logger.layer([logger])))
        expect(output).toEqual([])
      }),
    )
  })

  describe("registration", () => {
    for (const [name, traits, problem] of invalidTraits) {
      it.effect(`logs and skips a tool with ${name}, and keeps its neighbours`, () => {
        const output: unknown[] = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          output.push(entry.message)
        })
        return Effect.gen(function* () {
          const service = yield* Tool.Service
          yield* service.transform((editor) => {
            editor.add({ ...make(declared), name: "healthy", options: { codemode: false } })
            editor.add({ ...make(), name: "broken", traits, options: { codemode: false } } as unknown as Info)
          })

          expect(output).toEqual([
            [
              "Skipping invalid tool registration",
              { name: "broken", namespace: undefined, error: `Invalid tool traits broken: ${problem}` },
            ],
          ])
          const snapshot = yield* service.snapshot()
          expect(snapshot.definitions.map((definition) => definition.name)).toEqual(["healthy", "execute"])
          expect(snapshot.describe("broken")).toBeUndefined()
          expect(snapshot.describe("healthy")).toBeDefined()
        }).pipe(Effect.provide(Logger.layer([logger])))
      })

      it.effect(`keeps the earlier definition when an update leaves ${name}`, () => {
        const output: unknown[] = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          output.push(entry.message)
        })
        return Effect.gen(function* () {
          const service = yield* Tool.Service
          yield* register(service, make(declared))
          yield* service.transform((editor) => {
            editor.update("echo", (tool) => {
              tool.description = "Updated"
              // The update works on a copy, so a write in place cannot reach the registered traits either.
              if (typeof traits === "object" && traits !== null && !Array.isArray(traits))
                Object.assign(tool.traits!, traits)
              else Object.assign(tool, { traits })
            })
          })

          expect(output).toEqual([
            [
              "Skipping invalid tool registration",
              { name: "echo", namespace: undefined, error: `Invalid tool traits echo: ${problem}` },
            ],
          ])
          const snapshot = yield* service.snapshot()
          expect(snapshot.definitions.find((definition) => definition.name === "echo")?.description).toBe(
            "Echo the count",
          )
          expect(snapshot.describe("echo")).toEqual({
            openWorld: true,
            requiresUserInteraction: true,
            cancelSiblingsOnFailure: true,
            interruptBehavior: "cancel",
            maxResultChars: Infinity,
            searchHint: "find a count",
            displayName: "Counter",
          })
          expect(yield* snapshot.traits({ call: toolCall("echo") })).toEqual(declared)
        }).pipe(Effect.provide(Logger.layer([logger])))
      })
    }

    it.effect("accepts every valid declaration, Infinity included", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* register(service, make(declared))
        yield* register(service, { ...make({ maxResultChars: 1, readOnly: () => true }), name: "small" })
        yield* register(service, { ...make({}), name: "empty" })
        yield* register(service, { ...make(), name: "plain" })
        const snapshot = yield* service.snapshot()
        expect(snapshot.definitions.map((definition) => definition.name)).toEqual([
          "echo",
          "empty",
          "plain",
          "small",
          "execute",
        ])
      }),
    )

    it.effect("clones traits when a tool is added and when it is updated", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        const traits = { openWorld: true }
        yield* service.transform((editor) => editor.add({ ...make(traits), options: { codemode: false } }))
        yield* service.transform((editor) => {
          expect(editor.get("echo")?.traits).toEqual({ openWorld: true })
          expect(editor.get("echo")?.traits).not.toBe(traits)
        })

        yield* service.transform((editor) =>
          editor.update("echo", (tool) => {
            tool.description = "Updated"
          }),
        )
        const snapshot = yield* service.snapshot()
        expect(snapshot.describe("echo")).toEqual({ ...ToolTraits.describe(make()), openWorld: true })
        expect(snapshot.definitions.find((definition) => definition.name === "echo")?.description).toBe("Updated")
      }),
    )

    it.effect("lets an update change, add and remove traits", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* register(service, make({ displayName: "Before", readOnly: true }))
        yield* service.transform((editor) =>
          editor.update("echo", (tool) => {
            tool.traits = { ...tool.traits, displayName: "After", concurrencySafe: (input) => input.count > 3 }
          }),
        )
        const changed = yield* service.snapshot()
        expect(changed.describe("echo")?.displayName).toBe("After")
        expect(yield* changed.traits({ call: toolCall("echo") })).toEqual({
          ...ToolTraits.defaults,
          displayName: "After",
          readOnly: true,
          concurrencySafe: true,
        })

        yield* service.transform((editor) =>
          editor.update("echo", (tool) => {
            tool.traits = undefined
          }),
        )
        const removed = yield* service.snapshot()
        expect(removed.describe("echo")).toStrictEqual(ToolTraits.describe(make()))
        expect(yield* removed.traits({ call: toolCall("echo") })).toEqual(ToolTraits.defaults)
      }),
    )
  })

  describe("Snapshot.traits", () => {
    it.effect("hands predicates the decoded value and does not run hooks", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        const hooks = yield* PluginHooks.Service
        const ran: string[] = []
        yield* hooks.register("tool", "execute.before", (event) => Effect.sync(() => void ran.push(event.tool)))
        const inputs: unknown[] = []
        yield* register(
          service,
          make({
            readOnly: (input) => {
              inputs.push(input)
              return input.count === 5
            },
          }),
        )

        const snapshot = yield* service.snapshot()
        expect((yield* snapshot.traits({ call: toolCall("echo", { count: "5" }) })).readOnly).toBe(true)
        expect((yield* snapshot.traits({ call: toolCall("echo", { count: "6" }) })).readOnly).toBe(false)
        expect(inputs).toEqual([{ count: 5 }, { count: 6 }])
        expect(ran).toEqual([])
      }),
    )

    it.effect("skips decoding for a tool whose traits are fixed", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* register(service, make(declared))
        const snapshot = yield* service.snapshot()
        // The input is not valid, but nothing looks at it, so the answer is the declared one.
        expect(yield* snapshot.traits({ call: toolCall("echo", { count: "not a number" }) })).toEqual(declared)
      }),
    )

    it.effect("resolves what cannot be resolved to the conservative traits without failing", () => {
      const output: unknown[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        output.push(entry.message)
      })
      return Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* register(service, make({ readOnly: (input) => input.count > 1, concurrencySafe: true }))
        yield* register(service, { ...make({ readOnly: true }), name: "other" })
        yield* register(service, { ...make({ ...declared, readOnly: (input) => input.count > 1 }), name: "flagged" })
        const snapshot = yield* service.snapshot()
        const definition = snapshot.definitions.find((candidate) => candidate.name === "echo")!
        const resolve = (name: string, input: unknown, definitions?: ReadonlyMap<string, typeof definition>) =>
          Effect.exit(snapshot.traits({ call: toolCall(name, input), definitions }))

        // A call with no tool behind it has nothing declared to keep: a tool that is unknown, or that this request did
        // not offer, whether or not it is registered.
        for (const exit of [
          yield* resolve("missing", { count: "5" }),
          yield* resolve("echo", { count: "5" }, new Map([["other", definition]])),
          yield* resolve("other", { count: "5" }, new Map([["echo", definition]])),
          yield* resolve("execute", {}, new Map([["echo", definition]])),
        ])
          expect(exit).toEqual(Exit.succeed(ToolTraits.conservative))
        // Input that the schema rejects: the call will fail validation, and nothing about it is read-only. The tool
        // is known, so what it declares about itself holds.
        for (const exit of [
          yield* resolve("echo", { count: "abc" }),
          yield* resolve("echo", {}),
          yield* resolve("echo", null),
        ])
          expect(exit).toEqual(Exit.succeed(ToolTraits.conservative))
        for (const exit of [
          yield* resolve("flagged", { count: "abc" }),
          yield* resolve("flagged", {}),
          yield* resolve("flagged", null),
        ])
          expect(exit).toEqual(Exit.succeed(withheld))
        // A tool that is offered resolves normally, and the log stayed quiet about all of it.
        expect(yield* snapshot.traits({ call: toolCall("echo", { count: "5" }) })).toEqual({
          ...ToolTraits.defaults,
          readOnly: true,
          concurrencySafe: true,
        })
        expect(output).toEqual([])
      }).pipe(Effect.provide(Logger.layer([logger])))
    })

    describe("a schema transformation that throws", () => {
      // The throw is a defect of the tool's schema, not input the schema rejected.
      const Throwing = Schema.Struct({
        count: Schema.String.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transform((): number => {
              throw new Error("decoder threw")
            }),
            encode: SchemaGetter.transform(String),
          }),
        ),
      })
      const thrower: Info<typeof Throwing> = {
        name: "thrower",
        description: "Its schema throws",
        input: Throwing,
        execute: () => Effect.succeed({ content: "unreachable" }),
        traits: { ...fixed, readOnly: (input) => input.count > 1 },
      }

      it.effect("resolves the call conservatively without failing, and logs it once", () => {
        const output: Array<ReadonlyArray<unknown>> = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          output.push(entry.message as ReadonlyArray<unknown>)
        })
        return Effect.gen(function* () {
          const service = yield* Tool.Service
          yield* register(service, thrower)
          const snapshot = yield* service.snapshot()

          const exit = yield* Effect.exit(snapshot.traits({ call: toolCall("thrower", { count: "5" }) }))
          expect(exit).toEqual(Exit.succeed(withheld))
          expect(output).toEqual([
            [
              "Tool input could not be decoded to resolve its traits; the call takes the conservative traits",
              expect.objectContaining({ tool: "thrower" }),
            ],
          ])
        }).pipe(Effect.provide(Logger.layer([logger])))
      })

      it.effect("is told apart from input the schema rejects, which is not logged", () => {
        const output: unknown[] = []
        const logger = Logger.map(Logger.formatStructured, (entry) => {
          output.push(entry.message)
        })
        return Effect.gen(function* () {
          const service = yield* Tool.Service
          yield* register(service, thrower)
          const snapshot = yield* service.snapshot()

          // A missing field never reaches the transformation, so this is a rejection and not a defect.
          expect(yield* Effect.exit(snapshot.traits({ call: toolCall("thrower", {}) }))).toEqual(Exit.succeed(withheld))
          expect(output).toEqual([])
        }).pipe(Effect.provide(Logger.layer([logger])))
      })
    })

    it.effect("passes an interrupt during decoding through instead of resolving", () => {
      const output: unknown[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        output.push(entry.message)
      })
      return Effect.gen(function* () {
        const service = yield* Tool.Service
        const started = yield* Deferred.make<void>()
        // A tool whose schema decodes by running the effect it is given, so a predicate never gets to read the input.
        const decodes = (name: string, decoding: Effect.Effect<number>): Info => ({
          name,
          description: "Its schema runs the effect it was given",
          input: Schema.Struct({
            count: Schema.String.pipe(
              Schema.decodeTo(Schema.Number, {
                decode: SchemaGetter.transformOrFail(() => decoding),
                encode: SchemaGetter.transform(String),
              }),
            ),
          }),
          execute: () => Effect.succeed({ content: "unreachable" }),
          traits: { readOnly: (input) => input.count > 1 },
        })
        yield* register(service, decodes("interrupting", Effect.interrupt))
        yield* register(
          service,
          decodes("waiting", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
        )
        const snapshot = yield* service.snapshot()

        // The schema interrupts itself, so the cause holds an interrupt and must not be resolved away.
        const inside = yield* Effect.exit(snapshot.traits({ call: toolCall("interrupting", { count: "5" }) }))
        expect(Exit.isFailure(inside) && Cause.hasInterrupts(inside.cause)).toBe(true)

        // The call is interrupted from outside while the schema decodes.
        const fiber = yield* snapshot.traits({ call: toolCall("waiting", { count: "5" }) }).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        const outside = yield* Fiber.await(fiber)
        expect(Exit.isFailure(outside) && Cause.hasInterruptsOnly(outside.cause)).toBe(true)
        expect(output).toEqual([])
      }).pipe(Effect.provide(Logger.layer([logger])))
    })

    it.effect("resolves a tool that a context hook renamed to the real tool, and only under the new name", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* register(service, make({ ...declared, readOnly: (input) => input.count > 3 }))
        const snapshot = yield* service.snapshot()
        const real = snapshot.definitions.find((definition) => definition.name === "echo")!
        const advertised = new Map([["renamed_echo", { ...real, description: "Hook-edited" }]])

        expect(yield* snapshot.traits({ call: toolCall("renamed_echo"), definitions: advertised })).toEqual(declared)
        expect(
          (yield* snapshot.traits({ call: toolCall("renamed_echo", { count: "1" }), definitions: advertised }))
            .readOnly,
        ).toBe(false)
        expect(yield* snapshot.traits({ call: toolCall("echo"), definitions: advertised })).toEqual(
          ToolTraits.conservative,
        )
        expect(snapshot.describe("renamed_echo", advertised)).toEqual(ToolTraits.describe(make(declared)))
        expect(snapshot.describe("echo", advertised)).toBeUndefined()
        expect(snapshot.describe("echo")).toEqual(ToolTraits.describe(make(declared)))
      }),
    )
  })

  describe("Snapshot.describe", () => {
    it.effect("returns the static fields with the defaults filled in", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* register(service, make(declared))
        yield* register(service, { ...make({ openWorld: true, displayName: "Plain" }), name: "plain" })
        yield* register(service, { ...make(), name: "bare" })
        const snapshot = yield* service.snapshot()

        expect(snapshot.describe("echo")).toStrictEqual({
          openWorld: true,
          requiresUserInteraction: true,
          cancelSiblingsOnFailure: true,
          interruptBehavior: "cancel",
          maxResultChars: Infinity,
          searchHint: "find a count",
          displayName: "Counter",
        })
        expect(snapshot.describe("plain")).toStrictEqual({
          openWorld: true,
          requiresUserInteraction: false,
          cancelSiblingsOnFailure: false,
          interruptBehavior: "block",
          displayName: "Plain",
        })
        // Optional traits that were never declared are absent, not undefined.
        expect(snapshot.describe("bare")).toStrictEqual({
          openWorld: false,
          requiresUserInteraction: false,
          cancelSiblingsOnFailure: false,
          interruptBehavior: "block",
        })
        expect(snapshot.describe("missing")).toBeUndefined()
        // Predicate traits are not static, so they are not described.
        expect(snapshot.describe("echo")).not.toHaveProperty("readOnly")
      }),
    )

    it.effect("describes only what the execute path would run", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* service.transform((editor) => {
          editor.add({ ...make(declared), name: "direct", options: { codemode: false } })
          editor.add({ ...make(declared), name: "inner" })
        })
        const snapshot = yield* service.snapshot()

        expect(snapshot.describe("direct")).toBeDefined()
        // An inner Code Mode tool is not a tool the model can call by name.
        expect(snapshot.describe("inner")).toBeUndefined()
        expect(yield* snapshot.traits({ call: toolCall("inner") })).toEqual(ToolTraits.conservative)
        // The Code Mode tool is described like any other: it declares that a program can reach the network.
        expect(snapshot.describe("execute")).toStrictEqual({ ...ToolTraits.describe(make()), openWorld: true })
        expect((yield* snapshot.traits({ call: toolCall("execute", { code: "return 1" }) })).readOnly).toBe(false)
      }),
    )

    it.effect("finds a namespaced tool by its effective name only", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* service.transform((editor) =>
          editor.add({ ...make(declared), options: { namespace: "acme", codemode: false } }),
        )
        const snapshot = yield* service.snapshot()

        expect(snapshot.describe("acme_echo")).toEqual(ToolTraits.describe(make(declared)))
        expect(yield* snapshot.traits({ call: toolCall("acme_echo") })).toEqual(declared)
        expect(snapshot.describe("echo")).toBeUndefined()
        expect(yield* snapshot.traits({ call: toolCall("echo") })).toEqual(ToolTraits.conservative)
      }),
    )

    it.effect("treats a tool that the permission rules disable like an unknown tool", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* register(service, make(declared))
        const disabled = yield* service.snapshot([{ action: "echo", resource: "*", effect: "deny" }])
        const enabled = yield* service.snapshot()

        expect(disabled.describe("echo")).toBeUndefined()
        expect(yield* disabled.traits({ call: toolCall("echo") })).toEqual(ToolTraits.conservative)
        expect((yield* enabled.traits({ call: toolCall("echo") })).readOnly).toBe(true)
      }),
    )
  })

  describe("Tool.Context.traits", () => {
    it.effect("carries the traits resolved on the decoded input into execute", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        const seen: Array<Tool.ResolvedTraits> = []
        const inputs: unknown[] = []
        yield* register(
          service,
          make(
            {
              ...declared,
              readOnly: (input) => {
                inputs.push(input)
                return input.count > 3
              },
            },
            seen,
          ),
        )
        const snapshot = yield* service.snapshot()

        yield* snapshot.execute({ sessionID, ...identity, call: toolCall("echo", { count: "5" }) })
        yield* snapshot.execute({ sessionID, ...identity, call: toolCall("echo", { count: "2" }) })
        expect(seen).toEqual([declared, { ...declared, readOnly: false }])
        // The predicate saw what the schema decoded, not the strings the model sent.
        expect(inputs).toEqual([{ count: 5 }, { count: 2 }])
      }),
    )

    it.effect("runs a tool whose predicate is broken, as an unsafe call that keeps its declared cautions", () => {
      const logger = Logger.map(Logger.formatStructured, () => {})
      return Effect.gen(function* () {
        const service = yield* Tool.Service
        const seen: Array<Tool.ResolvedTraits> = []
        yield* register(service, make({ ...fixed, readOnly: true, destructive: () => Effect.fail("boom") }, seen))
        const snapshot = yield* service.snapshot()

        expect((yield* snapshot.execute({ sessionID, ...identity, call: toolCall("echo") })).content).toEqual([
          { type: "text", text: "5" },
        ])
        expect(seen).toEqual([withheld])
      }).pipe(Effect.provide(Logger.layer([logger])))
    })

    it.effect("does not run a tool whose input fails validation, or resolve its predicates", () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        const seen: Array<Tool.ResolvedTraits> = []
        let asked = 0
        yield* register(
          service,
          make(
            {
              readOnly: () => {
                asked++
                return true
              },
            },
            seen,
          ),
        )
        const snapshot = yield* service.snapshot()

        const failure = yield* snapshot
          .execute({ sessionID, ...identity, call: toolCall("echo", { count: "abc" }) })
          .pipe(Effect.flip)
        expect(failure).toBeInstanceOf(Tool.Error)
        expect(seen).toEqual([])
        expect(asked).toBe(0)
      }),
    )
  })
})

describe("SessionModelRequest", () => {
  const full = testEffect(PluginTestLayer)
  const session = Session.Info.make({
    id: sessionID,
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  })
  const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  })
  const transport = SessionModelTransport.Service.of({
    bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
    close: () => Effect.void,
    closeAll: Effect.void,
  })

  full.effect("binds toolTraits and describeTool to the definitions that context hooks left", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      const executed: Array<Tool.ResolvedTraits> = []
      yield* register(tools, make({ ...declared, readOnly: (input) => input.count > 3 }, executed))
      yield* register(tools, { ...make({ readOnly: true }), name: "dropped" })
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.tools.renamed_echo = event.tools.echo!
          delete event.tools.echo
          delete event.tools.dropped
        }),
      )
      const requests = yield* SessionModelRequest.Service
      const prepared = yield* requests.primary({
        session,
        agent: identity.agent,
        model,
        tools: yield* tools.snapshot(),
        system: [],
        messages: [],
      })

      expect(prepared.request.tools.map((tool) => tool.name).toSorted()).toEqual(["execute", "renamed_echo"])
      expect(yield* prepared.toolTraits(toolCall("renamed_echo"))).toEqual(declared)
      expect((yield* prepared.toolTraits(toolCall("renamed_echo", { count: "1" }))).readOnly).toBe(false)
      // The old name and a removed tool are not offered, so they resolve like an unknown tool.
      expect(yield* prepared.toolTraits(toolCall("echo"))).toEqual(ToolTraits.conservative)
      expect(yield* prepared.toolTraits(toolCall("dropped"))).toEqual(ToolTraits.conservative)
      expect(prepared.describeTool("renamed_echo")).toEqual(ToolTraits.describe(make(declared)))
      expect(prepared.describeTool("echo")).toBeUndefined()
      expect(prepared.describeTool("dropped")).toBeUndefined()

      // The same map executes the call, and the tool sees the traits that were resolved for it.
      yield* prepared.executeTool({ sessionID, ...identity, call: toolCall("renamed_echo", { count: "5" }) })
      expect(executed).toEqual([declared])
    }).pipe(Effect.provide(SessionModelRequest.layer), Effect.provideService(SessionModelTransport.Service, transport)),
  )

  full.effect("answers the conservative record and no static traits when the request has no tools", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service
      const prepared = yield* requests.primary({ session, agent: identity.agent, model, system: [], messages: [] })

      expect(yield* prepared.toolTraits(toolCall("echo"))).toEqual(ToolTraits.conservative)
      expect(prepared.describeTool("echo")).toBeUndefined()
    }).pipe(Effect.provide(SessionModelRequest.layer), Effect.provideService(SessionModelTransport.Service, transport)),
  )
})
