import { beforeEach, describe, expect } from "bun:test"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Image } from "@orbit/core/image"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Mcp } from "@orbit/core/mcp/index"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { ToolAuthorization } from "@orbit/core/tool/authorization"
import { McpTool } from "@orbit/core/tool/mcp"
import { fromPromise } from "@orbit/plugin/promise/adapter"
import type { Info } from "@orbit/schema/tool"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Cause, Effect, Exit, type Fiber, Layer, Schema, type Scope } from "effect"
import { location } from "./fixture/location"
import { it, testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin } from "./lib/tool"

// The real Permission service decides every question here: rules are evaluated, a person's reply is a reply to a pending
// request, and "always" saves a rule.
const nodes = [
  Database.node,
  Bus.node,
  SessionStore.node,
  PermissionSaved.node,
  Agent.node,
  PluginHooks.node,
  ManagedPolicy.node,
  Permission.node,
  Tool.node,
] as const
const overrides = [
  Location.node.replace(
    Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
  ),
  Image.node.replace(imagePassthrough),
]
const gate = testEffect(AppNodeBuilder.build(LayerNode.group(nodes), overrides))

const sessionID = Session.ID.make("ses_gate")
const identity = { agent: Agent.ID.make("test"), messageID: SessionMessage.ID.make("msg_gate") }

// Creates the session the rules apply to and gives the agent exactly these rules. A question that no rule answers asks.
const seed = Effect.fn(function* (rules: Permission.Ruleset) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
      agent: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(identity.agent, (agent) => {
      agent.permissions = [...rules]
    }),
  )
})

const rule = (action: string, effect: Permission.Rule["effect"]): Permission.Rule => ({ action, resource: "*", effect })

const call = (name: string, input: unknown = { text: "hi" }): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}`, name, input },
})
const program = (code: string) => call("execute", { code })

type Reply = { readonly reply: "once" | "always" | "reject"; readonly message?: string }
type Settled = {
  readonly asked: ReadonlyArray<{ readonly request: Permission.Request; readonly call: Tool.Call | undefined }>
  readonly exit: Exit.Exit<unknown, unknown>
}

// Runs a call, answers every question it puts with `reply`, and reports what was asked and how the call ended.
const settle = Effect.fn(function* (run: Parameters<Tool.Snapshot["execute"]>[0], reply: Reply = { reply: "once" }) {
  const tools = yield* Tool.Service
  const permission = yield* Permission.Service
  const fiber = yield* (yield* tools.snapshot()).execute(run).pipe(Effect.forkScoped)
  const drive = (asked: Settled["asked"]): Effect.Effect<Settled, Permission.NotFoundError> =>
    Effect.gen(function* () {
      const done = fiber.pollUnsafe()
      if (done) return { asked, exit: done }
      const [request] = yield* permission.list()
      if (!request) {
        yield* Effect.sleep("2 millis")
        return yield* drive(asked)
      }
      const current = yield* permission.callOf(request.id)
      yield* permission.reply({ requestID: request.id, ...reply })
      return yield* drive([...asked, { request, call: current }])
    })
  return yield* drive([])
})

const failure = (settled: Settled) =>
  Exit.isFailure(settled.exit)
    ? settled.exit.cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && reason.error instanceof Tool.Error ? [reason.error] : [],
      )[0]
    : undefined
const declined = (settled: Settled) =>
  Exit.isFailure(settled.exit) &&
  settled.exit.cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError,
  )
const actions = (settled: Settled) => settled.asked.map((item) => item.request.action)

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
const register = (...tools: Info[]) =>
  Effect.gen(function* () {
    const service = yield* Tool.Service
    yield* service.transform((editor) => tools.forEach((tool) => editor.add(tool)))
  })

// A case per row of a table, titled with the row's name.
const each =
  <Row extends readonly [name: string, ...rest: any[]]>(table: ReadonlyArray<Row>) =>
  (title: string, body: (row: Row) => Effect.Effect<void, unknown, Scope.Scope>) =>
    table.forEach((row) => it.effect(title.replace("%s", row[0]), () => body(row)))
const eachGate =
  <Row extends readonly [name: string, ...rest: any[]]>(table: ReadonlyArray<Row>) =>
  (title: string, body: (row: Row) => Effect.Effect<void, unknown, any>) =>
    table.forEach((row) => gate.live(title.replace("%s", row[0]), () => body(row)))

// Every way a tool can fail to say that it asks for itself. The registry asks for each.
const unresolved: ReadonlyArray<readonly [name: string, authorizes: unknown]> = [
  ["a missing declaration", undefined],
  ["false", false],
  ["a predicate that answers false", () => false],
  [
    "a predicate that throws",
    () => {
      throw new Error("boom")
    },
  ],
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
  gate.live("asks on the tool's name, runs it after once, and hands the question the call", () =>
    Effect.gen(function* () {
      yield* seed([rule("plugin", "ask")])
      yield* register(make("plugin", { codemode: false }))
      const result = yield* settle(call("plugin", { text: "hello" }))
      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.asked).toHaveLength(1)
      expect(result.asked[0]?.request).toMatchObject({
        action: "plugin",
        resources: ["*"],
        save: ["*"],
        sessionID,
        source: { type: "tool", messageID: identity.messageID, id: "call-plugin" },
      })
      expect(result.asked[0]?.call).toEqual({ tool: "plugin", input: { text: "hello" } })
      expect(ran).toEqual(["plugin"])
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
  )

  gate.live("asks on the permission action the tool names, and on the namespaced name otherwise", () =>
    Effect.gen(function* () {
      yield* seed([rule("edit", "ask"), rule("acme_spaced", "ask")])
      yield* register(
        make("named", { codemode: false, permission: "edit" }),
        make("spaced", { codemode: false, namespace: "acme" }),
      )
      expect(actions(yield* settle(call("named")))).toEqual(["edit"])
      expect(actions(yield* settle(call("acme_spaced")))).toEqual(["acme_spaced"])
    }),
  )

  gate.live("fails the call with the rule's refusal, asks nobody and runs nothing under a deny rule", () =>
    Effect.gen(function* () {
      yield* seed([rule("plugin", "deny")])
      yield* register(make("plugin", { codemode: false }))
      const result = yield* settle(call("plugin"))
      const error = failure(result)
      expect(error).toBeInstanceOf(Tool.Error)
      expect(error?.message).toBe("Permission denied: plugin")
      expect(result.asked).toEqual([])
      expect(ran).toEqual([])
    }),
  )

  gate.live("fails the call with the reason a policy gives for a denial", () =>
    Effect.gen(function* () {
      yield* seed([rule("plugin", "allow")])
      yield* register(make("plugin", { codemode: false }))
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => {
          event.effect = "deny"
          event.message = "Plugins are off in this project."
        }),
      )
      const result = yield* settle(call("plugin"))
      expect(failure(result)?.message).toBe("Plugins are off in this project.")
      expect(ran).toEqual([])
    }),
  )

  eachGate(unresolved)("asks, and runs nothing on a refusal, for a tool with %s", ([, authorizes]) =>
    Effect.gen(function* () {
      yield* seed([rule("plugin", "ask")])
      yield* register(make("plugin", { codemode: false, authorizes }))
      const allowed = yield* settle(call("plugin"))
      expect(actions(allowed)).toEqual(["plugin"])
      expect(ran).toEqual(["plugin"])

      ran.length = 0
      const refused = yield* settle(call("plugin"), { reply: "reject", message: "Use another tool." })
      expect(actions(refused)).toEqual(["plugin"])
      expect(failure(refused)).toBeInstanceOf(Tool.Error)
      expect(failure(refused)?.message).toBe("Use another tool.")
      expect(ran).toEqual([])
    }),
  )

  eachGate(settled)("does not ask for a tool with %s, which carries the decision itself", ([, authorizes]) =>
    Effect.gen(function* () {
      yield* seed([rule("*", "ask")])
      yield* register(make("own", { codemode: false, authorizes }))
      const result = yield* settle(call("own"))
      expect(result.asked).toEqual([])
      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(ran).toEqual(["own"])
    }),
  )

  gate.live("asks once, and a self-authorizing tool that asks for itself is not asked a second time", () =>
    Effect.gen(function* () {
      yield* seed([rule("*", "ask")])
      const permission = yield* Permission.Service
      yield* register({
        ...make("own", { codemode: false, authorizes: true }),
        execute: (_, context) =>
          permission
            .assert({
              action: "own",
              resources: ["thing"],
              save: ["thing"],
              metadata: {},
              sessionID: context.sessionID,
              agent: context.agent,
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(
              Effect.mapError(() => new Tool.Error({ message: "refused" })),
              Effect.as({ output: { text: "x" }, content: "x" }),
            ),
      })
      const result = yield* settle(call("own"))
      expect(result.asked.map((item) => item.request.resources)).toEqual([["thing"]])
    }),
  )

  gate.live("ends the call with the person's decline as a defect and runs nothing", () =>
    Effect.gen(function* () {
      yield* seed([rule("plugin", "ask")])
      yield* register(make("plugin", { codemode: false }))
      const result = yield* settle(call("plugin"), { reply: "reject" })
      expect(declined(result)).toBe(true)
      expect(ran).toEqual([])
    }),
  )

  gate.live("saves '*' for the action on always, so the next call is not asked", () =>
    Effect.gen(function* () {
      yield* seed([rule("plugin", "ask")])
      yield* register(make("plugin", { codemode: false }))
      const first = yield* settle(call("plugin"), { reply: "always" })
      expect(actions(first)).toEqual(["plugin"])
      expect((yield* (yield* PermissionSaved.Service).list()).map((item) => [item.action, item.resource])).toEqual([
        ["plugin", "*"],
      ])
      const second = yield* settle(call("plugin"))
      expect(second.asked).toEqual([])
      expect(ran).toEqual(["plugin", "plugin"])
    }),
  )

  gate.live("asks after validate and not for a call that validate or the schema refuses", () =>
    Effect.gen(function* () {
      yield* seed([rule("checked", "ask")])
      yield* register({
        ...make("checked", { codemode: false }),
        validate: ({ text }) => (text === "no" ? Effect.fail(new Tool.Error({ message: "Not that." })) : Effect.void),
      })
      const refused = yield* settle(call("checked", { text: "no" }))
      const malformed = yield* settle(call("checked", { text: 5 }))
      expect([refused.asked, malformed.asked]).toEqual([[], []])
      expect(failure(refused)?.message).toBe("Not that.")
      expect(actions(yield* settle(call("checked", { text: "yes" })))).toEqual(["checked"])
    }),
  )

  gate.live("asks for a plugin tool that replaces a self-authorizing one of the same name", () =>
    Effect.gen(function* () {
      yield* seed([rule("shared", "ask")])
      yield* register(make("shared", { codemode: false, authorizes: true }))
      yield* register(make("shared", { codemode: false }))
      expect(actions(yield* settle(call("shared")))).toEqual(["shared"])
    }),
  )

  gate.live("keeps asking when a tool is changed to claim nothing", () =>
    Effect.gen(function* () {
      yield* seed([rule("claimed", "ask")])
      const service = yield* Tool.Service
      yield* register(make("claimed", { codemode: false, authorizes: true }))
      yield* service.transform((editor) =>
        editor.update("claimed", (tool) => {
          tool.options = { codemode: false }
        }),
      )
      expect(actions(yield* settle(call("claimed")))).toEqual(["claimed"])
    }),
  )

  // The agent's rules wholly deny the action: the snapshot does not offer the tool, and a call to it by name is refused
  // the same way. Where the rules ask, the snapshot offers it and the call asks.
  gate.live("hides a tool from the snapshot exactly when running it is denied", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* register(make("plugin", { codemode: false }))
      const names = (rules: Permission.Ruleset) =>
        tools.snapshot(rules).pipe(Effect.map((snapshot) => snapshot.definitions.map((definition) => definition.name)))

      const denied = [rule("plugin", "deny")]
      yield* seed(denied)
      expect(yield* names(denied)).not.toContain("plugin")
      const refused = yield* settle(call("plugin"))
      expect(failure(refused)?.message).toBe("Permission denied: plugin")
      expect(ran).toEqual([])

      const asking = [rule("plugin", "ask")]
      yield* seed(asking)
      expect(yield* names(asking)).toContain("plugin")
      expect(actions(yield* settle(call("plugin")))).toEqual(["plugin"])
      expect(ran).toEqual(["plugin"])
    }),
  )
})

// Every door into execution is `Snapshot.execute`, which runs the registry's `executeTool`: a model call, a Code Mode
// inner call, a Promise plugin's tool and a desktop browser tool (its registration is checked in plugin-browser) all
// reach a tool only there. Each door below runs an unmarked tool and must be asked.
describe("every door into tool execution", () => {
  const doors: ReadonlyArray<
    readonly [
      name: string,
      register: Record<string, unknown>,
      run: Parameters<Tool.Snapshot["execute"]>[0],
      action: string,
    ]
  > = [
    ["a direct call", { codemode: false }, call("door"), "door"],
    ["a Code Mode inner call", { codemode: true }, program(`return (await tools.door({ text: "hi" })).text`), "door"],
    [
      "a Code Mode inner call to a namespaced tool",
      { codemode: true, namespace: "served" },
      program(`return (await tools.served.door({ text: "hi" })).text`),
      "served_door",
    ],
    [
      "a direct call to a namespaced tool",
      { codemode: false, namespace: "served" },
      call("served_door"),
      "served_door",
    ],
  ]

  eachGate(doors)(
    "%s asks for a tool that does not authorize itself, and hands the question the tool's call",
    ([, options, run, action]) =>
      Effect.gen(function* () {
        yield* seed([rule(action, "ask")])
        yield* register(make("door", options))
        const result = yield* settle(run)
        expect(actions(result)).toEqual([action])
        expect(result.asked[0]?.call?.input).toEqual({ text: "hi" })
        expect(ran).toEqual(["door"])
      }),
  )

  eachGate(doors)("%s runs nothing when the rules deny it", ([, options, run, action]) =>
    Effect.gen(function* () {
      yield* seed([rule(action, "deny")])
      yield* register(make("door", options))
      const result = yield* settle(run)
      expect(ran).toEqual([])
      expect(result.asked).toEqual([])
      // A Code Mode program sees the refusal as an error it can catch; a direct call fails with it.
      expect(JSON.stringify(failure(result) ?? result.exit)).toContain("Permission denied")
    }),
  )

  gate.live("asks again for each inner call of a program, and not for the program itself", () =>
    Effect.gen(function* () {
      yield* seed([rule("*", "ask")])
      yield* register(make("first", {}), make("second", {}), make("own", { authorizes: true }))
      const result = yield* settle(
        program(
          `await tools.first({ text: "a" }); await tools.second({ text: "b" }); await tools.own({ text: "c" }); await tools.first({ text: "d" })`,
        ),
      )
      expect(actions(result)).toEqual(["first", "second", "first"])
      expect(ran).toEqual(["first", "second", "own", "first"])
    }),
  )

  gate.live("ends a program at the first declined inner call, so later inner calls are never asked or run", () =>
    Effect.gen(function* () {
      yield* seed([rule("*", "ask")])
      yield* register(make("first", {}), make("second", {}))
      const result = yield* settle(
        program(`try { await tools.first({ text: "a" }) } catch (e) {} await tools.second({ text: "b" })`),
        { reply: "reject" },
      )
      expect(declined(result)).toBe(true)
      expect(actions(result)).toEqual(["first"])
      expect(ran).toEqual([])
    }),
  )

  gate.live("lets a program catch a correction to an inner call, which the tool never ran for", () =>
    Effect.gen(function* () {
      yield* seed([rule("door", "ask")])
      yield* register(make("door", {}))
      const result = yield* settle(
        program(`try { await tools.door({ text: "x" }) } catch (error) { return "caught: " + error.message }`),
        { reply: "reject", message: "Use the staging host." },
      )
      expect(JSON.stringify(result.exit)).toContain("caught: Use the staging host.")
      expect(ran).toEqual([])
    }),
  )

  // The door that SDK hosts and plugins use: the Promise adapter converts the tool and registers it with the registry.
  describe("a Promise plugin's tool", () => {
    const promiseTool = (options: unknown) => ({
      name: "promised",
      description: "Echo text",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
      options,
      execute: async ({ text }: { text: string }) => {
        ran.push("promised")
        return { output: { text }, content: text }
      },
    })
    const rows: ReadonlyArray<readonly [name: string, setup: (ctx: any) => Promise<unknown>, asked: boolean]> = [
      [
        "is added without authorizes",
        (ctx) => ctx.tool.transform((e: any) => e.add(promiseTool({ codemode: false }))),
        true,
      ],
      [
        "is added with authorizes true",
        (ctx) => ctx.tool.transform((e: any) => e.add(promiseTool({ codemode: false, authorizes: true }))),
        false,
      ],
      [
        "is added with a predicate that resolves true",
        (ctx) => ctx.tool.transform((e: any) => e.add(promiseTool({ codemode: false, authorizes: async () => true }))),
        false,
      ],
      [
        "is added with a predicate that resolves false",
        (ctx) => ctx.tool.transform((e: any) => e.add(promiseTool({ codemode: false, authorizes: async () => false }))),
        true,
      ],
      [
        "is added with a predicate that rejects",
        (ctx) =>
          ctx.tool.transform((e: any) =>
            e.add(
              promiseTool({
                codemode: false,
                authorizes: async () => {
                  throw new Error("boom")
                },
              }),
            ),
          ),
        true,
      ],
      [
        "is updated to drop authorizes",
        async (ctx) => {
          await ctx.tool.transform((e: any) => e.add(promiseTool({ codemode: false, authorizes: true })))
          await ctx.tool.transform((e: any) =>
            e.update("promised", (tool: any) => {
              tool.options = { codemode: false }
            }),
          )
        },
        true,
      ],
      [
        "is updated without touching a predicate that resolves true",
        async (ctx) => {
          await ctx.tool.transform((e: any) => e.add(promiseTool({ codemode: false, authorizes: async () => true })))
          await ctx.tool.transform((e: any) =>
            e.update("promised", (tool: any) => {
              tool.description = "Echo text, changed"
            }),
          )
        },
        false,
      ],
    ]

    eachGate(rows)("%s", ([, setup, asked]) =>
      Effect.gen(function* () {
        yield* seed([rule("promised", "ask")])
        yield* registerToolPlugin(fromPromise({ id: "promised-plugin", setup: async (ctx) => void (await setup(ctx)) }))
        const result = yield* settle(call("promised"))
        expect(actions(result)).toEqual(asked ? ["promised"] : [])
        expect(ran).toEqual(["promised"])
      }),
    )
  })
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
  const mcpGate = testEffect(
    AppNodeBuilder.build(LayerNode.group([...nodes, McpTool.node]), [Mcp.node.replace(mcp), ...overrides]),
  )

  mcpGate.live(
    "ask once, in the tool, whatever the server annotates, and the registry does not ask a second time",
    () =>
      Effect.gen(function* () {
        yield* seed([rule("demo_lookup", "ask")])
        const registry = yield* Tool.Service
        const mcpTools = yield* McpTool.Service
        yield* mcpTools.flush
        expect((yield* registry.list()).find((tool) => tool.id === "demo_lookup")?.options?.authorizes).toBe(true)
        const result = yield* settle(call("demo_lookup", {}))
        expect(actions(result)).toEqual(["demo_lookup"])
        expect(ran).toEqual(["lookup"])
      }),
  )

  mcpGate.live("run nothing when the rules deny the tool", () =>
    Effect.gen(function* () {
      yield* seed([rule("demo_lookup", "deny")])
      const mcpTools = yield* McpTool.Service
      yield* mcpTools.flush
      const result = yield* settle(call("demo_lookup", {}))
      expect(failure(result)).toBeInstanceOf(Tool.Error)
      expect(ran).toEqual([])
    }),
  )
})
