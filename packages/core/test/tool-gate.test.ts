import { beforeEach, describe, expect } from "bun:test"
import { Agent } from "@orbit/core/agent"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Image } from "@orbit/core/image"
import { Mcp } from "@orbit/core/mcp/index"
import { Permission } from "@orbit/core/permission"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { Tool } from "@orbit/core/tool"
import { ToolAuthorization } from "@orbit/core/tool/authorization"
import { McpTool } from "@orbit/core/tool/mcp"
import type { Info } from "@orbit/schema/tool"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Cause, Effect, Layer, Schema, type Scope, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"

// Every question the registry or a tool puts to Permission, and the answer the next one gets. A decline travels as a
// defect, as the real service does it.
const asked: Permission.AssertInput[] = []
let answer: "allow" | "block" | "correct" | "decline" = "allow"
beforeEach(() => {
  asked.length = 0
  answer = "allow"
})
const permissions = Layer.mock(Permission.Service, {
  assert: (input) =>
    Effect.suspend((): Effect.Effect<void, Permission.Error> => {
      asked.push(input)
      if (answer === "block")
        return Effect.fail(new Permission.BlockedError({ rules: [], permission: input.action, resources: [] }))
      if (answer === "correct") return Effect.fail(new Permission.CorrectedError({ feedback: "Use another tool." }))
      if (answer === "decline") return Effect.die(new Permission.DeclinedError())
      return Effect.void
    }),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, PluginHooks.node]), [
    Image.node.replace(imagePassthrough),
    Permission.node.replace(permissions),
  ]),
)

// A case per row of a table, titled with the row's name.
const each =
  <Row extends readonly [name: string, ...rest: any[]]>(table: ReadonlyArray<Row>) =>
  (title: string, body: (row: Row) => Effect.Effect<void, unknown, Tool.Service | Scope.Scope>) =>
    table.forEach((row) => it.effect(title.replace("%s", row[0]), () => body(row)))

const sessionID = Session.ID.make("ses_gate")
const identity = { agent: Agent.ID.make("build"), messageID: SessionMessage.ID.make("msg_gate") }
const call = (name: string, input: unknown = { text: "hi" }): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}`, name, input },
})
const program = (code: string) => call("execute", { code })

// A tool that records that it ran. Its `options` are what a case varies.
const ran: string[] = []
beforeEach(() => {
  ran.length = 0
})
const make = (name: string, options?: unknown): Info => ({
  name,
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  options: options as Info["options"],
  execute: ({ text }) =>
    Effect.sync(() => {
      ran.push(name)
      return { output: { text }, content: text }
    }),
})

// Every way a tool can fail to say that it asks for itself. The registry asks for each.
const unresolved: ReadonlyArray<readonly [name: string, authorizes: unknown]> = [
  ["a missing declaration", undefined],
  ["false", false],
  ["a predicate that answers false", () => false],
  ["a predicate that throws", () => {
    throw new Error("boom")
  }],
  ["a predicate that fails", () => Effect.fail(new Error("boom"))],
  ["a predicate that dies", () => Effect.die("boom")],
  ["a predicate that answers with text", () => "true"],
  ["a predicate that answers with a number", () => 1],
  ["a predicate that answers with nothing", () => undefined],
  ["a predicate that answers with a promise", () => Promise.resolve(true)],
  ["an Effect that answers with text", () => Effect.succeed("true")],
  ["text", "true"],
  ["a number", 1],
  ["null", null],
  ["an object", { authorizes: true }],
]

const settled = [
  ["true", true],
  ["a predicate that answers true", () => true],
  ["an Effect that answers true", () => Effect.succeed(true)],
] as const

describe("authorizesItself", () => {
  each(unresolved)("does not take %s for a tool that asks for itself", ([, authorizes]) =>
    Effect.gen(function* () {
      expect(yield* ToolAuthorization.authorizesItself(make("probe", { authorizes }), { text: "hi" })).toBe(false)
    }),
  )

  each(settled)("takes %s for a tool that asks for itself", ([, authorizes]) =>
    Effect.gen(function* () {
      expect(yield* ToolAuthorization.authorizesItself(make("probe", { authorizes }), { text: "hi" })).toBe(true)
    }),
  )

  it.effect("hands the predicate the decoded input", () =>
    Effect.gen(function* () {
      const seen: unknown[] = []
      const tool = make("probe", {
        authorizes: (input: unknown) => {
          seen.push(input)
          return true
        },
      })
      yield* ToolAuthorization.authorizesItself(tool, { text: "decoded" })
      expect(seen).toEqual([{ text: "decoded" }])
    }),
  )
})

describe("the registry gate", () => {
  it.effect("asks for a plugin tool that does not authorize itself, on its name, before it runs", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("plugin", { codemode: false })))
      const result = yield* (yield* service.snapshot()).execute(call("plugin"))
      expect(result.output).toEqual({ text: "hi" })
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({
        action: "plugin",
        resources: ["*"],
        save: ["*"],
        sessionID,
        source: { type: "tool", messageID: identity.messageID, id: "call-plugin" },
      })
    }),
  )

  it.effect("asks on the permission action the tool names, and on the namespaced name otherwise", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.add(make("named", { codemode: false, permission: "edit" }))
        editor.add(make("spaced", { codemode: false, namespace: "acme" }))
      })
      const snapshot = yield* service.snapshot()
      yield* snapshot.execute(call("named"))
      yield* snapshot.execute(call("acme_spaced"))
      expect(asked.map((item) => item.action)).toEqual(["edit", "acme_spaced"])
    }),
  )

  each(unresolved)("asks, and runs nothing on a refusal, for a tool with %s", ([, authorizes]) =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("plugin", { codemode: false, authorizes })))
      const snapshot = yield* service.snapshot()
      yield* snapshot.execute(call("plugin"))
      expect(asked.map((item) => item.action)).toEqual(["plugin"])
      expect(ran).toEqual(["plugin"])

      asked.length = 0
      ran.length = 0
      answer = "block"
      const failure = yield* snapshot.execute(call("plugin")).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Tool.Error)
      expect(failure.message).toBe("Permission denied: plugin")
      expect(asked).toHaveLength(1)
      expect(ran).toEqual([])
    }),
  )

  each(settled)("does not ask for a tool with %s, which carries the decision itself", ([, authorizes]) =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("own", { codemode: false, authorizes })))
      yield* (yield* service.snapshot()).execute(call("own"))
      expect(asked).toEqual([])
      expect(ran).toEqual(["own"])
    }),
  )

  it.effect("passes a correction to the model as the failure and a decline as a defect, and runs neither", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("plugin", { codemode: false })))
      const snapshot = yield* service.snapshot()

      answer = "correct"
      const corrected = yield* snapshot.execute(call("plugin")).pipe(Effect.flip)
      expect(corrected).toBeInstanceOf(Tool.Error)
      expect(corrected.message).toBe("Use another tool.")

      answer = "decline"
      const declined = yield* snapshot.execute(call("plugin")).pipe(Effect.exit)
      expect(declined._tag).toBe("Failure")
      if (declined._tag === "Failure") expect(Cause.hasDies(declined.cause)).toBe(true)
      expect(ran).toEqual([])
    }),
  )

  it.effect("asks after validate and not for a call that validate or the schema refuses", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) =>
        editor.add({
          ...make("checked", { codemode: false }),
          validate: ({ text }) => (text === "no" ? Effect.fail(new Tool.Error({ message: "Not that." })) : Effect.void),
        }),
      )
      const snapshot = yield* service.snapshot()
      yield* snapshot.execute(call("checked", { text: "no" })).pipe(Effect.flip)
      yield* snapshot.execute(call("checked", { text: 5 })).pipe(Effect.flip)
      expect(asked).toEqual([])
      yield* snapshot.execute(call("checked", { text: "yes" }))
      expect(asked).toHaveLength(1)
    }),
  )

  it.effect("asks for a plugin tool that replaces a self-authorizing one of the same name", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("shared", { codemode: false, authorizes: true })))
      yield* service.transform((editor) => editor.add(make("shared", { codemode: false })))
      yield* (yield* service.snapshot()).execute(call("shared"))
      expect(asked.map((item) => item.action)).toEqual(["shared"])
    }),
  )

  it.effect("keeps asking when a tool is changed to claim nothing", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("claimed", { codemode: false, authorizes: true })))
      yield* service.transform((editor) =>
        editor.update("claimed", (tool) => {
          tool.options = { codemode: false }
        }),
      )
      yield* (yield* service.snapshot()).execute(call("claimed"))
      expect(asked.map((item) => item.action)).toEqual(["claimed"])
    }),
  )
})

// Every door into execution is `Snapshot.execute`, which runs the registry's `executeTool`: the runner's model calls,
// SDK hosts and flow nodes reach tools only through a session, and a session reaches them only there. Code Mode inner
// calls re-enter `executeTool` for the tool they call. Each door below runs the same unmarked tool and must be asked.
describe("every door into tool execution", () => {
  const doors: ReadonlyArray<
    readonly [name: string, register: Record<string, unknown>, run: Parameters<Tool.Snapshot["execute"]>[0]]
  > = [
    ["a direct call", { codemode: false }, call("door")],
    [
      "a Code Mode inner call",
      { codemode: true },
      program(`return (await tools.door({ text: "hi" })).text`),
    ],
    [
      "a Code Mode inner call to a namespaced tool",
      { codemode: true, namespace: "served" },
      program(`return (await tools.served.door({ text: "hi" })).text`),
    ],
    [
      "a direct call to a namespaced tool",
      { codemode: false, namespace: "served" },
      call("served_door"),
    ],
  ]

  each(doors)("%s asks for a tool that does not authorize itself", ([, register, run]) =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("door", register)))
      yield* (yield* service.snapshot()).execute(run)
      expect(asked.map((item) => item.action)).toEqual([register.namespace ? "served_door" : "door"])
      expect(ran).toEqual(["door"])
    }),
  )

  each(doors)("%s runs nothing when the question is refused", ([, register, run]) =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("door", register)))
      answer = "block"
      const result = yield* (yield* service.snapshot()).execute(run).pipe(Effect.exit)
      expect(asked).toHaveLength(1)
      expect(ran).toEqual([])
      // A Code Mode program sees the refusal as an error it can catch, and ends with it; a direct call fails.
      expect(result._tag === "Failure" || JSON.stringify(result).includes("Permission denied")).toBe(true)
    }),
  )

  it.effect("asks again for each inner call of a program, and not for the program itself", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.add(make("first", {}))
        editor.add(make("second", {}))
        editor.add(make("own", { authorizes: true }))
      })
      yield* (yield* service.snapshot()).execute(
        program(
          `await tools.first({ text: "a" }); await tools.second({ text: "b" }); await tools.own({ text: "c" }); await tools.first({ text: "d" })`,
        ),
      )
      expect(asked.map((item) => item.action)).toEqual(["first", "second", "first"])
      expect(ran).toEqual(["first", "second", "own", "first"])
    }),
  )

  it.effect("applies a deny rule written for the tool to a Code Mode inner call before the tool runs", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => editor.add(make("door", {})))
      answer = "block"
      const result = yield* (yield* service.snapshot()).execute(
        program(`try { await tools.door({ text: "x" }) } catch (error) { return "caught: " + error.message }`),
      )
      expect(JSON.stringify(result)).toContain("Permission denied: door")
      expect(ran).toEqual([])
    }),
  )
})

describe("MCP tools", () => {
  // A server that calls its tool read-only and not destructive. Annotations schedule and draw a call and never decide
  // whether anyone is asked.
  const server = Mcp.ServerName.make("demo")
  const mcp = Layer.mock(Mcp.Service, {
    tools: () =>
      Effect.succeed([
        {
          server,
          name: "lookup",
          codemode: false,
          description: "Lookup",
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          inputSchema: { type: "object", properties: {} },
        } satisfies Mcp.Tool,
      ]),
    callTool: (input) =>
      Effect.sync(() => {
        ran.push(input.name)
        return { server, tool: input.name, isError: false, structured: { ok: true }, content: [] }
      }),
  })
  const mcpIt = testEffect(
    AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node]), [
      Mcp.node.replace(mcp),
      Permission.node.replace(permissions),
      Bus.node.replace(Layer.mock(Bus.Service, { subscribe: () => Stream.never })),
      Image.node.replace(imagePassthrough),
    ]),
  )

  mcpIt.effect("ask once, in the tool, whatever the server annotates, and the registry does not ask a second time", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* (yield* McpTool.Service).flush
      expect((yield* registry.list()).find((tool) => tool.id === "demo_lookup")?.options?.authorizes).toBe(true)
      yield* (yield* registry.snapshot()).execute(call("demo_lookup", {}))
      expect(asked.map((item) => item.action)).toEqual(["demo_lookup"])
      expect(ran).toEqual(["lookup"])
    }),
  )

  mcpIt.effect("run nothing when the question is refused", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* (yield* McpTool.Service).flush
      answer = "block"
      yield* (yield* registry.snapshot()).execute(call("demo_lookup", {})).pipe(Effect.flip)
      expect(ran).toEqual([])
    }),
  )
})
