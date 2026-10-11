import { describe, expect } from "bun:test"
import { Agent } from "@orbit/core/agent"
import { Permission } from "@orbit/core/permission"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Image } from "@orbit/core/image"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { toSessionError } from "@orbit/core/session/to-session-error"
import { State } from "@orbit/core/state"
import { Tool } from "@orbit/core/tool"
import { ToolTraits } from "@orbit/core/tool/traits"
import type { Info } from "@orbit/schema/tool"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { codeModeListings, executeTool, invalidValidateProblem, invalidValidates, toolDefinitions } from "./lib/tool"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, SchemaGetter, SchemaIssue, Scope } from "effect"
import { z } from "zod"
import { testEffect } from "./lib/effect"
import { allowAllPermission } from "./lib/permission"

const imageStore = Layer.mock(Image.Service, {
  normalize: (resource, content) => {
    if (resource === "corrupt.png") return Effect.fail(new Image.DecodeError({ resource }))
    if (resource === "too-large.png")
      return Effect.fail(
        new Image.SizeError({
          resource,
          width: 9_000,
          height: 9_000,
          bytes: content.content.length,
          maxWidth: 2_000,
          maxHeight: 2_000,
          maxBytes: 5,
        }),
      )
    return Effect.succeed({
      content: {
        ...content,
        content: Buffer.from(`${Buffer.from(content.content, "base64").toString()} normalized`).toString("base64"),
        mime: "image/jpeg",
      },
      ...(resource.startsWith("scaled")
        ? { resized: { from: { width: 1_000, height: 7 }, to: { width: 300, height: 2 } } }
        : {}),
    })
  },
})
const registryLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, PluginHooks.node]), [
  Image.node.replace(imageStore),
  Permission.node.replace(allowAllPermission),
])
const it = testEffect(registryLayer)
const identity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_registry"),
}
const sessionID = Session.ID.make("ses_registry")
const call = (name: string, id = `call-${name}`): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name, input: { text: name } },
})

const make = (): Info => ({
  name: "echo",
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
})

const constant = (text: string): Info => ({
  name: "constant",
  description: "Return text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.succeed({ output: { text }, content: text }),
})

// A tool that reports each step it takes, and whose read-only trait depends on its input.
const checked = (steps: string[]): Info => ({
  name: "checked",
  description: "Checked before it runs",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  traits: { readOnly: (input: { readonly text: string }) => input.text === "rewritten" },
  validate: (input, context) =>
    Effect.sync(() => void steps.push(`validate ${input.text} readOnly:${context.traits.readOnly}`)),
  execute: ({ text }) =>
    Effect.sync(() => void steps.push(`execute ${text}`)).pipe(Effect.as({ output: { text }, content: text })),
})

const transform = (service: Tool.Interface, tools: Readonly<Record<string, Info>>, options?: Tool.Options) =>
  service.transform((editor) =>
    Object.entries(tools).forEach(([name, tool]) => editor.add({ ...tool, name, options: options ?? tool.options })),
  )

describe("Tool", () => {
  // A plugin that confines the shell registers it under the name it had before the rename, after the built-in.
  it.effect("a plugin tool registered as an old built-in name replaces the built-in's executor and description", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(
        service,
        { Bash: { ...constant("built-in"), description: "The built-in shell" } },
        { codemode: false },
      )
      yield* transform(
        service,
        { shell: { ...constant("confined"), description: "A confined shell" } },
        { codemode: false },
      )
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.filter((tool) => tool.name === "Bash").map((tool) => tool.description)).toEqual([
        "A confined shell",
      ])
      expect(snapshot.definitions.some((tool) => tool.name === "shell")).toBe(false)
      expect((yield* snapshot.execute(call("Bash"))).output).toEqual({ text: "confined" })
    }),
  )

  it.effect("reads the current editor tools by effective name", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() }, { namespace: "acme", codemode: false })
      yield* service.transform((editor) => {
        expect(editor.list().map((tool) => tool.id)).toEqual(["acme_echo"])
        expect(editor.get("acme_echo")?.id).toBe("acme_echo")
        expect(editor.get("acme_echo")?.name).toBe("echo")
        expect(editor.get("missing")).toBeUndefined()
      })
    }),
  )

  it.effect("replays mutations on refreshed sources and restores tools on disposal and scope cleanup", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      let text = "original"
      const source = yield* Scope.make()
      yield* service
        .transform((editor) => {
          editor.add({ ...constant(text), name: "echo", options: { namespace: "acme", codemode: false } })
          editor.add({ ...make(), name: "hidden" })
        })
        .pipe(Scope.provide(source))
      const original = yield* service.snapshot()
      const update = yield* service.transform((editor) => {
        editor.update("missing", () => {
          throw new Error("must not create a tool")
        })
        editor.remove("missing")
        editor.update("acme_echo", (tool) => {
          const execute = tool.execute
          tool.description = "Updated"
          tool.execute = (input, context) =>
            execute(input, context).pipe(
              Effect.map((result) => ({ ...result, output: { text: `${result.output.text} updated` } })),
            )
        })
      })
      const scope = yield* Scope.make()
      yield* service.transform((editor) => editor.remove("hidden")).pipe(Scope.provide(scope))
      expect((yield* service.snapshot()).codeModeCatalog?.tools).toEqual([])
      expect((yield* executeTool(service, call("acme_echo"))).output).toEqual({ text: "original updated" })

      text = "refreshed"
      yield* service.reload()
      const refreshed = yield* service.snapshot()
      expect(refreshed.definitions[0]?.description).toBe("Updated")
      expect(refreshed.codeModeCatalog?.tools).toEqual([])
      expect((yield* refreshed.execute(call("acme_echo"))).output).toEqual({ text: "refreshed updated" })
      expect((yield* original.execute(call("acme_echo"))).output).toEqual({ text: "original" })

      yield* update.dispose
      yield* update.dispose
      expect((yield* executeTool(service, call("acme_echo"))).output).toEqual({ text: "refreshed" })
      yield* Scope.close(scope, Exit.void)
      expect(codeModeListings((yield* service.snapshot()).codeModeCatalog!).map((tool) => tool.path)).toEqual([
        "hidden",
      ])

      yield* service.transform((editor) =>
        editor.update("acme_echo", (tool) => {
          tool.description = "Updated again"
        }),
      )
      yield* Scope.close(source, Exit.void)
      expect((yield* service.snapshot()).definitions.map((tool) => tool.name)).toEqual(["Execute"])
    }),
  )

  it.effect("updates schemas and executors without renaming tools and applies removal in order", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.add({ ...make(), options: { namespace: "acme.tools", codemode: false } })
        editor.add({ ...make(), name: "removed", options: { codemode: false } })
        editor.remove("removed")
        editor.update("removed", () => {
          throw new Error("must not resurrect a tool")
        })
        editor.remove("acme_tools_echo")
        editor.add({ ...make(), options: { namespace: "acme.tools", codemode: false } })
        editor.update("acme_tools_echo", (tool) => {
          tool.name = "renamed"
          tool.options = { namespace: "other", codemode: false }
          tool.input = Schema.Struct({ value: Schema.Finite })
          tool.output = Schema.Finite
          tool.execute = ({ value }) => Effect.succeed({ output: value + 1 })
        })
      })
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["acme_tools_echo", "Execute"])
      expect(snapshot.definitions[0]?.inputSchema.properties).toEqual({ value: { type: "number" } })
      expect(
        (yield* snapshot.execute({
          ...call("acme_tools_echo"),
          call: {
            type: "tool-call",
            id: "updated",
            name: "acme_tools_echo",
            input: { value: 2 },
          },
        })).output,
      ).toBe(3)
      expect(yield* snapshot.execute(call("acme_tools_echo")).pipe(Effect.flip)).toBeInstanceOf(Tool.Error)
    }),
  )

  it.effect("skips invalid updates without dropping the existing definition", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() }, { codemode: false })
      yield* service.transform((editor) =>
        editor.update("echo", (tool) => {
          Object.assign(tool, { description: undefined })
        }),
      )
      expect((yield* service.snapshot()).definitions[0]?.description).toBe("Echo text")
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "echo" })
    }),
  )

  it.effect("replays empty sources on reload and keeps advertised snapshots", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      let source: Info[] = []
      yield* service.transform((editor) => source.forEach((tool) => editor.add(tool)))
      expect((yield* service.snapshot()).definitions.map((tool) => tool.name)).toEqual(["Execute"])

      const tool = { ...constant("first"), name: "echo", options: { codemode: false } }
      source = [tool]
      yield* service.reload()
      const advertised = yield* service.snapshot()
      expect((yield* advertised.execute(call("echo"))).output).toEqual({ text: "first" })

      tool.execute = constant("second").execute
      expect((yield* advertised.execute(call("echo"))).output).toEqual({ text: "first" })
      yield* service.reload()
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "second" })
      expect((yield* advertised.execute(call("echo"))).output).toEqual({ text: "first" })

      source = []
      yield* service.reload()
      expect((yield* service.snapshot()).definitions.map((tool) => tool.name)).toEqual(["Execute"])
      expect((yield* advertised.execute(call("echo"))).output).toEqual({ text: "first" })
    }),
  )

  it.effect("disposes overlays once and replays remaining transforms in order", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const runs: string[] = []
      yield* service.transform((editor) => {
        runs.push("base")
        editor.add({ ...constant("base"), name: "echo", options: { codemode: false } })
      })
      const scope = yield* Scope.make()
      const overlay = yield* service
        .transform((editor) => {
          runs.push("overlay")
          editor.add({ ...constant("overlay"), name: "echo", options: { codemode: false } })
        })
        .pipe(Scope.provide(scope))
      // Each registration outside a batch notifies immediately, and every rebuild replays all transforms.
      expect(runs).toEqual(["base", "base", "overlay"])
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "overlay" })

      yield* overlay.dispose
      expect(runs).toEqual(["base", "base", "overlay", "base"])
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "base" })
      yield* overlay.dispose
      yield* Scope.close(scope, Exit.void)
      expect(runs).toEqual(["base", "base", "overlay", "base"])
    }),
  )

  it.effect("reads pending tools inside a batch and suppresses terminal teardown replay", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const runs: string[] = []
      const scope = yield* Scope.make()
      yield* State.batch(
        Effect.gen(function* () {
          yield* service.transform((editor) => {
            runs.push("base")
            editor.add({ ...constant("base"), name: "echo", options: { codemode: false } })
          })
          yield* service.transform((editor) => {
            runs.push("overlay")
            editor.add({ ...constant("overlay"), name: "echo", options: { codemode: false } })
          })
          expect(runs).toEqual([])
          expect((yield* service.snapshot()).definitions.map((tool) => tool.name)).toEqual(["echo", "Execute"])
          expect(runs).toEqual(["base", "overlay"])
        }).pipe(Scope.provide(scope)),
      )

      expect(runs).toEqual(["base", "overlay"])
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "overlay" })
      yield* State.shutdown(Scope.close(scope, Exit.void))
      expect(runs).toEqual(["base", "overlay"])
    }),
  )

  it.effect("uses the last valid addition on replay and restores earlier transforms on disposal", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo_tool: constant("base") }, { codemode: false })
      let source = [{ ...constant("overlay"), name: "echo.tool", options: { codemode: false } }]
      const registration = yield* service.transform((editor) => source.forEach((tool) => editor.add(tool)))
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "overlay" })

      source = [...source, { ...constant("collision"), name: "echo_tool", options: { codemode: false } }]
      yield* service.reload()
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "collision" })

      yield* registration.dispose
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "base" })
      yield* service.transform((editor) => source.forEach((tool) => editor.add(tool)))

      source = [{ ...constant("invalid"), name: "", options: { codemode: false } }]
      yield* service.reload()
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "base" })
    }),
  )

  it.effect("logs and skips invalid dotted namespaces", () => {
    const output: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      output.push(entry.message)
    })
    return Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() }, { namespace: "slack..admin" })

      expect(output).toEqual([
        [
          "Skipping invalid tool registration",
          { name: "echo", namespace: "slack..admin", error: 'Invalid tool namespace: "slack..admin"' },
        ],
      ])
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["Execute"])
      expect(snapshot.codeModeCatalog?.tools).toEqual([])
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.effect("skips invalid and reserved names while letting the last normalized name win", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(
        service,
        {
          before: make(),
          "": make(),
          ["x".repeat(129)]: make(),
          "echo.tool": constant("first"),
          echo_tool: constant("last"),
          execute: make(),
          after: make(),
        },
        { codemode: false },
      )
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["after", "before", "echo_tool", "Execute"])
      expect((yield* snapshot.execute(call("before"))).output).toEqual({ text: "before" })
      expect((yield* snapshot.execute(call("after"))).output).toEqual({ text: "after" })
      expect((yield* snapshot.execute(call("echo_tool"))).output).toEqual({ text: "last" })
      expect(snapshot.codeModeCatalog?.tools).toEqual([])
    }),
  )

  it.effect("registers 128-character MCP tool names in Code Mode", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const name = "x".repeat(128)
      yield* transform(service, { [name]: make(), ["x".repeat(129)]: make() }, { namespace: "cloudflare" })

      const snapshot = yield* service.snapshot()
      expect(codeModeListings(snapshot.codeModeCatalog!).map((tool) => tool.path)).toEqual([`cloudflare.${name}`])
      const result = yield* snapshot.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "call-long-mcp-name",
          name: "Execute",
          input: { code: `return (await tools.cloudflare[${JSON.stringify(name)}]({ text: "hello" })).text` },
        },
      })
      expect(result.content).toEqual([{ type: "text", text: "hello" }])
    }),
  )

  it.effect("executes native tools without requiring letter-leading names or namespace segments", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(
        service,
        { "2d_get_scene": make(), "123": make(), _lookup: make(), "-lookup": make() },
        { codemode: false },
      )
      yield* transform(service, { "2d_get_scene": make() }, { namespace: "123._private.-tools", codemode: false })

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual([
        "-lookup",
        "123",
        "123__private_-tools_2d_get_scene",
        "2d_get_scene",
        "_lookup",
        "Execute",
      ])
      for (const name of ["2d_get_scene", "123", "_lookup", "-lookup", "123__private_-tools_2d_get_scene"]) {
        expect((yield* snapshot.execute(call(name))).output).toEqual({ text: name })
      }
    }),
  )

  it.effect("executes Code Mode tools without requiring letter-leading names or namespace segments", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { "2d_get_scene": make(), "123": make(), _lookup: make(), "-lookup": make() })
      yield* transform(service, { "2d_get_scene": make() }, { namespace: "123._private.-tools", codemode: true })

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["Execute"])
      expect(codeModeListings(snapshot.codeModeCatalog!).map((tool) => tool.path)).toEqual([
        "-lookup",
        "123",
        "123._private.-tools.2d_get_scene",
        "2d_get_scene",
        "_lookup",
      ])
      const result = yield* snapshot.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "call-nonletter-names",
          name: "Execute",
          input: {
            code: `const results = await Promise.all([
              tools["2d_get_scene"]({ text: "digit" }),
              tools["123"]({ text: "numeric" }),
              tools._lookup({ text: "underscore" }),
              tools["-lookup"]({ text: "hyphen" }),
              tools["123"]._private["-tools"]["2d_get_scene"]({ text: "namespaced" }),
            ]); return results.map(result => result.text).join(",");`,
          },
        },
      })
      expect(result.content).toEqual([{ type: "text", text: "digit,numeric,underscore,hyphen,namespaced" }])
    }),
  )

  it.effect("keeps healthy tools when another namespace is invalid", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.namespace({ name: "invalid..namespace", description: "Invalid" })
        editor.add({ ...make(), name: "first", options: { codemode: false } })
        editor.add({ ...make(), name: "second", options: { namespace: "invalid..namespace", codemode: false } })
        editor.add({ ...make(), name: "second", options: { namespace: "invalid__namespace" } })
      })

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["first", "Execute"])
      expect(codeModeListings(snapshot.codeModeCatalog!).map((tool) => tool.path)).toEqual([
        "invalid__namespace.second",
      ])
    }),
  )

  it.effect("keeps namespace descriptions beside catalog tools", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.namespace({ name: "registry", description: "Package publishing and discovery" })
        editor.namespace({ name: "registry.search", description: "Pricing operations" })
        editor.add({ ...make(), name: "plain", options: { namespace: "legacy" } })
        editor.add({ ...make(), name: "direct", options: { namespace: "registry", codemode: false } })
        editor.add({ ...make(), name: "search", description: "Search packages", options: { namespace: "registry" } })
        editor.add({ ...make(), name: "sales", description: "Read sales", options: { namespace: "registry.search" } })
      })

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["registry_direct", "Execute"])
      expect(codeModeListings(snapshot.codeModeCatalog!).map((tool) => tool.path)).toEqual([
        "legacy.plain",
        "registry.search",
        "registry.search.sales",
      ])
      expect(snapshot.codeModeCatalog?.tools).toEqual([
        {
          type: "namespace",
          name: "legacy",
          tools: [expect.objectContaining({ type: "tool", name: "plain" })],
        },
        {
          type: "namespace",
          name: "registry",
          description: "Package publishing and discovery",
          tools: [
            expect.objectContaining({ type: "tool", name: "search" }),
            {
              type: "namespace",
              name: "search",
              description: "Pricing operations",
              tools: [expect.objectContaining({ type: "tool", name: "sales" })],
            },
          ],
        },
      ])
      const result = yield* snapshot.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "namespace-search",
          name: "Execute",
          input: { code: 'return search({ query: "pricing operations" })' },
        },
      })
      expect(result.output).toMatchObject({ output: expect.stringContaining("tools.registry.search") })
      const callable = yield* snapshot.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "callable-namespace",
          name: "Execute",
          input: {
            code: `return await Promise.all([
              tools.registry.search({ text: "search" }),
              tools.registry.search.sales({ text: "sales" }),
            ])`,
          },
        },
      })
      expect(callable.output).toMatchObject({
        output: expect.stringContaining('"text": "sales"'),
        toolCalls: [
          { tool: "registry.search", status: "completed" },
          { tool: "registry.search.sales", status: "completed" },
        ],
      })
    }),
  )

  it.effect("retains namespace descriptions in executable snapshots after appended transforms", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.namespace({ name: "acme", description: "Archival operations" })
        editor.add({ ...make(), options: { namespace: "acme" } })
      })
      const advertised = yield* service.snapshot()

      yield* service.transform((editor) => {
        editor.namespace({ name: "acme", description: "Billing operations" })
      })
      const current = yield* service.snapshot()
      expect(advertised.codeModeCatalog?.tools).toMatchObject([{ name: "acme", description: "Archival operations" }])
      expect(current.codeModeCatalog?.tools).toMatchObject([{ name: "acme", description: "Billing operations" }])

      const search = (snapshot: Tool.Snapshot, query: string) =>
        snapshot.execute({
          ...call("Execute"),
          call: {
            type: "tool-call",
            id: `namespace-${query}`,
            name: "Execute",
            input: {
              code: `return search({ query: ${JSON.stringify(query)} }).items.map(item => item.path).join(",")`,
            },
          },
        })
      expect((yield* search(advertised, "archival")).output).toMatchObject({ output: "tools.acme.echo" })
      expect((yield* search(advertised, "billing")).output).toMatchObject({ output: "" })
      expect((yield* search(current, "archival")).output).toMatchObject({ output: "" })
      expect((yield* search(current, "billing")).output).toMatchObject({ output: "tools.acme.echo" })
    }),
  )

  it.effect("preserves a top-level tool that also has child tools", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.namespace({ name: "pricing", description: "Pricing operations" })
        editor.add({ ...make(), name: "pricing" })
        editor.add({ ...make(), name: "sales", options: { namespace: "pricing" } })
      })

      const snapshot = yield* service.snapshot()
      expect(codeModeListings(snapshot.codeModeCatalog!).map((tool) => tool.path)).toEqual(["pricing", "pricing.sales"])
      const result = yield* snapshot.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "top-level-callable",
          name: "Execute",
          input: {
            code: `return await Promise.all([
              tools.pricing({ text: "pricing" }),
              tools.pricing.sales({ text: "sales" }),
            ])`,
          },
        },
      })
      expect(result.output).toMatchObject({ output: expect.stringContaining('"text": "sales"') })
    }),
  )

  it.effect("logs invalid tool definitions without dropping healthy tools", () => {
    const output: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      output.push(entry.message)
    })
    return Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) => {
        editor.add({ ...make(), name: "healthy", options: { codemode: false } })
        editor.add({
          name: "phone_type",
          input: Schema.Struct({}),
          execute: () => Effect.succeed({ content: "ok" }),
          options: { codemode: false },
        } as unknown as Info)
        editor.add({ ...make(), name: "codemode" })
      })

      expect(output).toEqual([
        [
          "Skipping invalid tool registration",
          {
            name: "phone_type",
            namespace: undefined,
            error: expect.stringContaining('Expected string\n  at ["description"]'),
          },
        ],
      ])
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["healthy", "Execute"])
      expect(codeModeListings(snapshot.codeModeCatalog!).map((tool) => tool.path)).toEqual(["codemode"])
      expect((yield* snapshot.execute(call("phone_type")).pipe(Effect.flip)).message).toBe(
        'No tool named "phone_type" is currently available. Please use a tool from the available tool list.',
      )
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.effect("skipped registrations leave existing tools and scoped cleanup intact", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: constant("original") }, { codemode: false })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* service.transform((editor) => {
            editor.add({ ...constant("invalid"), name: "echo", description: undefined } as unknown as Info)
            editor.add({ ...make(), name: "temporary", options: { codemode: false } })
          })
          const snapshot = yield* service.snapshot()
          expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["echo", "temporary", "Execute"])
          expect((yield* snapshot.execute(call("echo"))).output).toEqual({ text: "original" })
        }),
      )
      expect((yield* service.snapshot()).definitions.map((tool) => tool.name)).toEqual(["echo", "Execute"])
    }),
  )

  it.effect("canonicalizes effective definitions and keeps Code Mode last", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const tool = make()
      const capture = (tools: ReadonlyArray<Info>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* service.transform((editor) => tools.forEach(editor.add))
            return (yield* service.snapshot()).definitions
          }),
        )
      const first = yield* capture([
        { ...tool, name: "zeta", options: { codemode: false } },
        { ...tool, name: "alpha", options: { codemode: false } },
        { ...tool, name: "beta", options: { namespace: "alpha", codemode: false } },
        { ...tool, name: "echo" },
      ])
      const second = yield* capture([
        { ...tool, name: "echo" },
        { ...tool, name: "beta", options: { namespace: "alpha", codemode: false } },
        { ...tool, name: "alpha", options: { codemode: false } },
        { ...tool, name: "zeta", options: { codemode: false } },
      ])

      expect(first).toEqual(second)
      expect(first.map((definition) => definition.name)).toEqual(["alpha", "alpha_beta", "zeta", "Execute"])
    }),
  )

  it.effect("snapshots external tools with missing input schemas", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((editor) =>
        editor.add({
          ...make(),
          input: undefined,
        } as unknown as Info),
      )

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["Execute"])
      expect(codeModeListings(snapshot.codeModeCatalog!)[0]?.line).toContain("tools.echo")
    }),
  )

  it.effect("keeps execute available without Code Mode tools unless explicitly denied", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service

      const available = yield* service.snapshot()
      expect(available.definitions.map((tool) => tool.name)).toEqual(["Execute"])
      expect(available.codeModeCatalog?.tools).toEqual([])

      const denied = yield* service.snapshot([{ action: "execute", resource: "*", effect: "deny" }])
      expect(denied.definitions).toEqual([])
      expect(denied.codeModeCatalog).toBeUndefined()
    }),
  )

  it.effect("filters disabled tools with edit aliases and ordered wildcard precedence", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { lookup: make(), bash: make() }, { codemode: false })
      yield* transform(service, { edit: make(), write: make() }, { codemode: false, permission: "edit" })
      const names = (permissions: Permission.Ruleset) =>
        toolDefinitions(service, permissions).pipe(Effect.map((definitions) => definitions.map((tool) => tool.name)))

      expect(yield* names([{ action: "lookup", resource: "*", effect: "deny" }])).toEqual([
        "Edit",
        "Write",
        "bash",
        "Execute",
      ])
      expect(
        yield* names([
          { action: "*", resource: "*", effect: "deny" },
          { action: "lookup", resource: "private", effect: "allow" },
        ]),
      ).toEqual(["lookup"])
      expect(
        yield* names([
          { action: "lookup", resource: "private", effect: "allow" },
          { action: "*", resource: "*", effect: "deny" },
        ]),
      ).toEqual([])
      expect(yield* names([{ action: "edit", resource: "*", effect: "deny" }])).toEqual(["bash", "lookup", "Execute"])
    }),
  )

  it.effect("keeps permission options isolated between registrations", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const shared = make()
      yield* transform(service, { first: shared }, { codemode: false })
      yield* transform(service, { second: shared }, { codemode: false, permission: "edit" })

      expect(
        (yield* toolDefinitions(service, [{ action: "edit", resource: "*", effect: "deny" }])).map((tool) => tool.name),
      ).toEqual(["first", "Execute"])
    }),
  )

  it.effect("removes a scoped registration", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const scope = yield* Scope.make()
      yield* transform(service, { echo: make() }, { codemode: false }).pipe(Scope.provide(scope))
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo", "Execute"])
      yield* Scope.close(scope, Exit.void)
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["Execute"])
    }),
  )

  it.effect("preserves an interrupted registration until its scope closes", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* transform(service, { echo: make() }, { codemode: false }).pipe(
        Effect.andThen(Deferred.succeed(registered, undefined)),
        Effect.andThen(Effect.never),
        Scope.provide(scope),
        Effect.forkChild,
      )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["echo", "Execute"])
      yield* Scope.close(scope, Exit.void)
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["Execute"])
    }),
  )

  it.effect("returns model errors without swallowing interruption or defects", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(
        service,
        {
          failed: {
            name: "failed",
            description: "Failed",
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: () => Effect.fail(new Tool.Error({ message: "Denied" })),
          },
        },
        { codemode: false },
      )
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "failed", name: "failed", input: {} },
        }),
      ).toEqual({ status: "error", error: { type: "tool.execution", message: "Denied" } })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "missing", name: "missing", input: {} },
        }),
      ).toEqual({
        status: "error",
        error: {
          type: "tool.unknown",
          message: 'No tool named "missing" is currently available. Please use a tool from the available tool list.',
        },
      })

      yield* transform(
        service,
        {
          defect: {
            name: "defect",
            description: "Defect",
            input: Schema.Struct({}),
            output: Schema.Struct({}),
            execute: () => Effect.die("unexpected executor defect"),
          },
        },
        { codemode: false },
      )
      expect(
        yield* service.snapshot().pipe(
          Effect.flatMap((toolSet) =>
            toolSet.execute({
              sessionID,
              ...identity,
              call: { type: "tool-call", id: "defect", name: "defect", input: {} },
            }),
          ),
          Effect.catchDefect(Effect.succeed),
        ),
      ).toBe("unexpected executor defect")
    }),
  )

  it.effect("exposes execution only through a snapshot", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      expect("definitions" in service).toBe(false)
      expect("execute" in service).toBe(false)
      expect("settle" in service).toBe(false)
      expect(typeof service.snapshot).toBe("function")
    }),
  )

  it.effect("passes complete call identity to tool execution", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const contexts: Tool.Context[] = []
      yield* transform(
        service,
        {
          context: {
            name: "context",
            description: "Context",
            input: Schema.Struct({}),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: (_, context) =>
              Effect.sync(() => contexts.push(context)).pipe(Effect.as({ output: { ok: true } })),
          },
        },
        { codemode: false },
      )
      yield* executeTool(service, {
        sessionID,
        ...identity,
        call: { type: "tool-call", id: "call-context", name: "context", input: {} },
      })
      expect(contexts).toEqual([
        {
          sessionID,
          ...identity,
          id: Tool.CallID.make("call-context"),
          progress: expect.any(Function),
          traits: ToolTraits.defaults,
        },
      ])
    }),
  )
  it.effect("resolves Tool.Context.traits from the input an execute.before hook rewrote", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      const contexts: Tool.Context[] = []
      const answered: unknown[] = []
      yield* transform(
        service,
        {
          classified: {
            name: "classified",
            description: "Classified by its input",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ ok: Schema.Boolean }),
            traits: {
              readOnly: (input: { readonly text: string }) => {
                answered.push(input)
                return input.text === "safe"
              },
              destructive: (input: { readonly text: string }) => input.text !== "safe",
            },
            execute: (_, context) =>
              Effect.sync(() => contexts.push(context)).pipe(Effect.as({ output: { ok: true } })),
          },
        },
        { codemode: false },
      )
      const rewrites: string[] = []
      yield* hooks.register("tool", "execute.before", (event) =>
        Effect.sync(() => {
          rewrites.push(event.tool)
          event.input = { text: "safe" }
        }),
      )
      const snapshot = yield* service.snapshot()
      const sent = { type: "tool-call" as const, id: "call-rewritten", name: "classified", input: { text: "risky" } }

      // Scheduling asks first, on the input the model sent, and no hook runs for it.
      const scheduled = yield* snapshot.traits({ call: sent })
      expect([scheduled.readOnly, scheduled.destructive]).toEqual([false, true])
      expect(rewrites).toEqual([])

      yield* snapshot.execute({ sessionID, ...identity, call: sent })
      expect(rewrites).toEqual(["classified"])
      expect(contexts.map((context) => [context.traits.readOnly, context.traits.destructive])).toEqual([[true, false]])
      expect(answered).toEqual([{ text: "risky" }, { text: "safe" }])
    }),
  )

  it.effect("runs validate on the input an execute.before hook rewrote, with the call's traits, before execute", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      const steps: string[] = []
      yield* transform(service, { checked: checked(steps) }, { codemode: false })
      yield* hooks.register("tool", "execute.before", (event) =>
        Effect.sync(() => {
          steps.push("hook")
          event.input = { text: "rewritten" }
        }),
      )

      const snapshot = yield* service.snapshot()
      yield* snapshot.execute(call("checked"))
      expect(steps).toEqual(["hook", "validate rewritten readOnly:true", "execute rewritten"])
    }),
  )

  it.effect("runs validate for a Code Mode inner call", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const steps: string[] = []
      yield* transform(service, { checked: checked(steps) })

      const snapshot = yield* service.snapshot()
      yield* snapshot.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "call-inner-validate",
          name: "Execute",
          input: { code: `return await tools.checked({ text: "rewritten" })` },
        },
      })
      expect(steps).toEqual(["validate rewritten readOnly:true", "execute rewritten"])
    }),
  )

  class ForeignFailure extends Schema.TaggedError<ForeignFailure>()("Plugin.ForeignFailure", {
    message: Schema.String,
  }) {}
  for (const [name, failure, expected, metadata] of [
    [
      "a Tool.Error with a code",
      new Tool.Error({ message: "Not today.", code: "acme.not-today", metadata: { seen: true } }),
      { type: "acme.not-today", message: "Not today." },
      { seen: true },
    ],
    [
      "a Tool.Error without a code",
      new Tool.Error({ message: "Not valid.", metadata: { seen: true } }),
      { type: "tool.validation", message: "Not valid." },
      { seen: true },
    ],
    [
      "a Tool.Error without a code that wraps another error",
      new Tool.Error({ message: "Wrapped.", error: new Error("inner") }),
      { type: "tool.validation", message: "Wrapped." },
      undefined,
    ],
    [
      "a failure that is not a Tool.Error",
      new ForeignFailure({ message: "transport died" }),
      { type: "tool.validation", message: "transport died" },
      undefined,
    ],
    ["a failure that is not an error", "plain text", { type: "tool.validation", message: "plain text" }, undefined],
  ] as const)
    it.effect(`refuses the call when validate fails with ${name}, and runs nothing after it`, () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        const steps: string[] = []
        yield* transform(
          service,
          { checked: { ...checked(steps), validate: () => Effect.fail(failure as never) } },
          { codemode: false },
        )

        const error = yield* service.snapshot().pipe(
          Effect.flatMap((snapshot) => snapshot.execute(call("checked"))),
          Effect.flip,
        )
        expect(toSessionError(error)).toEqual(expected)
        expect(error.metadata).toEqual(metadata)
        expect(steps).toEqual([])
      }),
    )

  const decline = new Permission.DeclinedError()
  for (const [name, validate, ended] of [
    ["an interrupt", () => Effect.interrupt, (exit: Exit.Exit<unknown, unknown>) => Exit.hasInterrupts(exit)],
    [
      "a defect",
      () => Effect.die("validate defect"),
      (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && exit.cause.toString().includes("validate defect"),
    ],
    [
      "a decline",
      () => Effect.die(decline),
      (exit: Exit.Exit<unknown, unknown>) =>
        Exit.isFailure(exit) &&
        exit.cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect === decline),
    ],
  ] as const)
    it.effect(`leaves ${name} in validate as it is, and runs nothing after it`, () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        const steps: string[] = []
        yield* transform(service, { checked: { ...checked(steps), validate } }, { codemode: false })

        const exit = yield* service.snapshot().pipe(
          Effect.flatMap((snapshot) => snapshot.execute(call("checked"))),
          Effect.exit,
        )
        expect(ended(exit)).toBe(true)
        // A defect or an interrupt is not a failure of the call, so it did not become a validation error.
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
        expect(steps).toEqual([])
      }),
    )

  it.effect("names a call to a tool that was not offered for the request tool.unavailable", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() }, { codemode: false })

      const snapshot = yield* service.snapshot()
      const error = yield* snapshot.execute({ ...call("echo"), definitions: new Map() }).pipe(Effect.flip)
      expect(toSessionError(error)).toEqual({
        type: "tool.unavailable",
        message: "Tool is not available for this request: echo",
      })
    }),
  )

  for (const [name, validate] of invalidValidates) {
    it.effect(`logs and skips a tool with ${name}, and keeps its neighbours`, () => {
      const output: unknown[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        output.push(entry.message)
      })
      return Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* service.transform((editor) => {
          editor.add({ ...checked([]), name: "healthy", options: { codemode: false } })
          editor.add({ ...checked([]), name: "broken", validate, options: { codemode: false } } as unknown as Info)
        })

        expect(output).toEqual([
          [
            "Skipping invalid tool registration",
            { name: "broken", namespace: undefined, error: `Invalid tool validate broken: ${invalidValidateProblem}` },
          ],
        ])
        const snapshot = yield* service.snapshot()
        expect(snapshot.definitions.map((definition) => definition.name)).toEqual(["healthy", "Execute"])
      }).pipe(Effect.provide(Logger.layer([logger])))
    })

    it.effect(`keeps the earlier definition when an update leaves ${name}`, () => {
      const output: unknown[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        output.push(entry.message)
      })
      return Effect.gen(function* () {
        const service = yield* Tool.Service
        const steps: string[] = []
        yield* transform(service, { checked: checked(steps) }, { codemode: false })
        yield* service.transform((editor) => {
          editor.update("checked", (tool) => {
            tool.description = "Updated"
            Object.assign(tool, { validate })
          })
        })

        expect(output).toEqual([
          [
            "Skipping invalid tool registration",
            {
              name: "checked",
              namespace: undefined,
              error: `Invalid tool validate checked: ${invalidValidateProblem}`,
            },
          ],
        ])
        const snapshot = yield* service.snapshot()
        expect(snapshot.definitions.find((definition) => definition.name === "checked")?.description).toBe(
          "Checked before it runs",
        )
        // The earlier definition still checks its calls.
        yield* snapshot.execute(call("checked"))
        expect(steps).toEqual(["validate checked readOnly:false", "execute checked"])
      }).pipe(Effect.provide(Logger.layer([logger])))
    })
  }

  it.effect("keeps validate when an update replaces only execute", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const steps: string[] = []
      yield* transform(service, { checked: checked(steps) }, { codemode: false })
      yield* service.transform((editor) =>
        editor.update("checked", (tool) => {
          const execute = tool.execute
          tool.execute = (input, context) =>
            Effect.sync(() => void steps.push("wrapped")).pipe(Effect.andThen(execute(input, context)))
        }),
      )

      yield* (yield* service.snapshot()).execute(call("checked"))
      expect(steps).toEqual(["validate checked readOnly:false", "wrapped", "execute checked"])
    }),
  )

  it.effect("gives a Code Mode inner call the traits of the tool it calls", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const seen = new Map<string, Tool.ResolvedTraits>()
      const inner = (name: string, traits?: Info["traits"]): Info => ({
        ...make(),
        name,
        traits,
        execute: ({ text }, context) =>
          Effect.sync(() => void seen.set(name, context.traits)).pipe(Effect.as({ output: { text }, content: text })),
      })
      yield* service.transform((editor) => {
        editor.add(
          inner("lookup", {
            readOnly: (input: { readonly text: string }) => input.text === "lookup",
            concurrencySafe: true,
            openWorld: true,
            displayName: "Lookup",
          }),
        )
        editor.add(inner("plain"))
      })

      const snapshot = yield* service.snapshot()
      yield* snapshot.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "call-inner-traits",
          name: "Execute",
          input: {
            code: `await tools.lookup({ text: "lookup" }); await tools.plain({ text: "plain" }); return "done"`,
          },
        },
      })

      expect(seen.get("lookup")).toEqual({
        ...ToolTraits.defaults,
        readOnly: true,
        concurrencySafe: true,
        openWorld: true,
        displayName: "Lookup",
      })
      expect(seen.get("plain")).toEqual(ToolTraits.defaults)
    }),
  )

  it.effect("lists registered tools by effective name", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() }, { codemode: false })
      yield* transform(service, { count: { ...constant("1"), name: "count" } }, { namespace: "acme" })

      expect((yield* service.list()).map((tool) => [tool.id, tool.name])).toEqual([
        ["echo", "echo"],
        ["acme_count", "count"],
      ])

      yield* service.transform((editor) => editor.remove("echo"))
      expect((yield* service.list()).map((tool) => tool.id)).toEqual(["acme_count"])
    }),
  )
  ;[
    { name: "string", content: "hooked", text: "hooked" },
    { name: "empty string", content: "", text: "" },
    { name: "missing content", content: undefined, text: '{"text":"hooked"}' },
    { name: "empty content array", content: [], text: '{"text":"hooked"}' },
  ].forEach((input) => {
    it.effect(`normalizes ${input.name} after the final tool hook`, () =>
      Effect.gen(function* () {
        const service = yield* Tool.Service
        const hooks = yield* PluginHooks.Service
        yield* transform(service, { echo: make() }, { codemode: false })
        yield* hooks.register("tool", "execute.after", (event) =>
          Effect.sync(() => {
            if (event.status !== "completed") return
            event.result = {
              output: { text: "hooked" },
              content: input.content,
              metadata: { source: "hook" },
            }
          }),
        )
        const snapshot = yield* service.snapshot()
        expect(yield* snapshot.execute(call("echo"))).toEqual({
          output: { text: "hooked" },
          content: [{ type: "text", text: input.text }],
          metadata: { source: "hook" },
        })
      }),
    )
  })

  it.effect("normalizes image tool output once and drops unresizable images", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(
        service,
        {
          snapshot: {
            name: "snapshot",
            description: "Return images",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) =>
              Effect.succeed({
                output: { text },
                content: [
                  { type: "file", uri: "data:image/png;base64,aW1hZ2U=", mime: "image/png", name: "frame.png" },
                  {
                    type: "file",
                    uri: "data:image/png;base64,aW1hZ2U=",
                    mime: "image/png",
                    name: "too-large.png",
                  },
                  { type: "file", uri: "data:image/png;base64,aW1hZ2U=", mime: "image/png", name: "corrupt.png" },
                  { type: "text", text },
                ],
              }),
          },
        },
        { codemode: false },
      )

      const execution = yield* executeTool(service, call("snapshot"))
      expect(execution.content).toEqual([
        {
          type: "file",
          uri: "data:image/jpeg;base64,aW1hZ2Ugbm9ybWFsaXplZA==",
          mime: "image/jpeg",
          name: "frame.png",
        },
        { type: "text", text: "snapshot" },
        { type: "text", text: "[1 image omitted: could not be decoded.]" },
        { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
      ])
    }),
  )

  it.effect("adds a resize note after each resized image of any tool and keeps file items to their own keys", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const png = (name?: string) => ({
        type: "file" as const,
        uri: "data:image/png;base64,aW1hZ2U=",
        mime: "image/png",
        ...(name === undefined ? {} : { name }),
      })
      yield* transform(
        service,
        {
          shots: {
            name: "shots",
            description: "Return images",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }) =>
              Effect.succeed({
                output: { text },
                content: [png("scaled-a.png"), png("frame.png"), png("scaled-b.png"), png("corrupt.png"), png()],
              }),
          },
        },
        { codemode: false },
      )

      const note =
        "[Image resized: the original is 1000×7 px and it is shown at 300×2 px. Multiply coordinates read from the shown image by 3.33 to get coordinates in the original.]"
      const shown = (name?: string) => ({
        type: "file" as const,
        uri: "data:image/jpeg;base64,aW1hZ2Ugbm9ybWFsaXplZA==",
        mime: "image/jpeg",
        ...(name === undefined ? {} : { name }),
      })
      expect((yield* executeTool(service, call("shots"))).content).toEqual([
        shown("scaled-a.png"),
        { type: "text", text: note },
        shown("frame.png"),
        shown("scaled-b.png"),
        { type: "text", text: note },
        { type: "file", uri: "data:image/jpeg;base64,aW1hZ2Ugbm9ybWFsaXplZA==", mime: "image/jpeg" },
        { type: "text", text: "[1 image omitted: could not be decoded.]" },
      ])
    }),
  )

  it.effect("publishes progress metadata unchanged", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(
        service,
        {
          progressive: {
            name: "progressive",
            description: "Emit image progress",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
            execute: ({ text }, context) =>
              context.progress({ stage: "capture" }).pipe(Effect.as({ output: { text } })),
          },
        },
        { codemode: false },
      )

      const updates: Tool.Metadata[] = []
      yield* executeTool(service, {
        ...call("progressive"),
        progress: (update) =>
          Effect.sync(() => {
            updates.push(update)
          }),
      })
      expect(updates).toEqual([{ stage: "capture" }])
    }),
  )

  it.effect("enforces transformed codecs at execution and projection boundaries", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const executed: string[] = []
      const Transformed = Schema.Boolean.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value) => (value ? "yes" : "no")),
          encode: SchemaGetter.transform((value) => value === "yes"),
        }),
      )
      yield* transform(
        service,
        {
          transformed: {
            name: "transformed",
            description: "Transform values",
            input: Schema.Struct({ value: Transformed }),
            output: Schema.Struct({ value: Transformed }),
            execute: ({ value }) =>
              Effect.sync(() => executed.push(value)).pipe(Effect.as({ output: { value }, content: String(value) })),
          },
        },
        { codemode: false },
      )

      // Canonical content observes the decoded domain value; Code Mode observes the encoded value.
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "transformed", name: "transformed", input: { value: true } },
        }),
      ).toEqual({
        status: "completed",
        output: { value: true },
        content: [{ type: "text", text: "yes" }],
      })
      expect(executed).toEqual(["yes"])
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-input", name: "transformed", input: { value: "yes" } },
        }),
      ).toMatchObject({
        status: "error",
        error: {
          type: "tool.input-invalid",
          message:
            'Invalid arguments for tool "transformed":\n- value: Expected boolean\n\nArguments provided:\n{\n  "value": "yes"\n}\n\nUpdate the arguments and call the tool again.',
        },
      })
      expect(executed).toEqual(["yes"])

      yield* transform(
        service,
        {
          invalid_output: {
            name: "invalid_output",
            description: "Return invalid output",
            input: Schema.Struct({}),
            output: Schema.Struct({
              value: Schema.Boolean.pipe(
                Schema.decodeTo(Schema.String, {
                  decode: SchemaGetter.transform((value) => String(value)),
                  encode: SchemaGetter.transformOrFail((value) =>
                    value === "valid"
                      ? Effect.succeed(true)
                      : Effect.fail(new SchemaIssue.InvalidValue({ message: "invalid output" }, value)),
                  ),
                }),
              ),
            }),
            execute: () => Effect.succeed({ output: { value: "invalid" } }),
          },
        },
        { codemode: false },
      )
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-output", name: "invalid_output", input: {} },
        }),
      ).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: expect.stringContaining("invalid value for its output schema") },
      })
    }),
  )

  it.effect("registers, advertises, and executes a Zod tool", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(
        service,
        {
          zod: {
            name: "zod",
            description: "Increment a parsed number",
            input: z.object({ count: z.string().transform(Number) }),
            output: z.object({ count: z.number() }),
            execute: ({ count }) => Effect.succeed({ output: { count: count + 1 } }),
          },
        },
        { codemode: false },
      )

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.find((tool) => tool.name === "zod")?.inputSchema).toMatchObject({
        type: "object",
        properties: { count: { type: "string" } },
        required: ["count"],
      })
      expect(
        yield* snapshot.execute({
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "call-zod", name: "zod", input: { count: "41" } },
        }),
      ).toMatchObject({ output: { count: 42 } })
    }),
  )

  it.effect("executes the tool advertised in a model request", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const scope = yield* Scope.make()
      yield* transform(service, { echo: constant("advertised") }, { codemode: false }).pipe(Scope.provide(scope))
      const request = yield* service.snapshot()
      yield* Scope.close(scope, Exit.void)
      yield* transform(service, { echo: constant("replacement") }, { codemode: false })

      expect((yield* request.execute(call("echo"))).content).toEqual([{ type: "text", text: "advertised" }])
      expect((yield* executeTool(service, call("echo"))).content).toEqual([{ type: "text", text: "replacement" }])
    }),
  )

  it.effect("reveals the previous registration after an overlay closes", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: constant("base") }, { codemode: false })
      const overlay = yield* Scope.make()
      yield* transform(service, { echo: constant("overlay") }, { codemode: false }).pipe(Scope.provide(overlay))

      expect((yield* executeTool(service, call("echo"))).content).toEqual([{ type: "text", text: "overlay" }])
      yield* Scope.close(overlay, Exit.void)
      expect((yield* executeTool(service, call("echo"))).content).toEqual([{ type: "text", text: "base" }])
    }),
  )

  it.effect("executes and reports progress for codemode tools advertised in a model request", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const executed: string[] = []
      const scope = yield* Scope.make()
      yield* transform(service, {
        echo: {
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }, context) =>
            Effect.sync(() => executed.push(`old:${text}`)).pipe(
              Effect.andThen(context.progress({ stage: "old" })),
              Effect.as({ output: { text } }),
            ),
        },
      }).pipe(Scope.provide(scope))
      const toolSet = yield* service.snapshot()
      const execute = toolSet.definitions.find((tool) => tool.name === "Execute")
      expect(codeModeListings(toolSet.codeModeCatalog!)[0]?.line).toContain("tools.echo")
      expect(execute?.description).toContain("confined Code Mode runtime")
      expect(execute?.description).not.toContain("Echo text")
      yield* Scope.close(scope, Exit.void)
      yield* transform(service, {
        echo: {
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.sync(() => executed.push(`new:${text}`)).pipe(Effect.as({ output: { text } })),
        },
      })

      const progress: Tool.Metadata[] = []
      const execution = yield* toolSet.execute({
        ...call("Execute"),
        call: {
          type: "tool-call",
          id: "call-execute",
          name: "Execute",
          input: { code: 'return await tools.echo({ text: "request" })' },
        },
        progress: (update) => Effect.sync(() => progress.push(update)),
      })

      expect(execution).toMatchObject({ content: [{ type: "text" }] })
      expect(executed).toEqual(["old:request"])
      expect(progress).toEqual([
        { toolCalls: [{ tool: "echo", status: "running", input: { text: "request" } }] },
        { stage: "old" },
        { toolCalls: [{ tool: "echo", status: "completed", input: { text: "request" } }] },
      ])
    }),
  )
})

describe("Tool exposure", () => {
  // Where a tool goes for each spelling of the options that decide it: advertised in the request (direct), or found
  // through the Code Mode catalog (deferred), where a pinned tool is always listed. A plugin is not bound by the types,
  // so the table holds values that are not the boolean false, which defer, and a pinned tool that is also direct.
  const exposures: ReadonlyArray<
    readonly [name: string, options: unknown, exposure: ToolTraits.Exposure, pinned: boolean]
  > = [
    ["codemode: false", { codemode: false }, "direct", false],
    ["codemode: true", { codemode: true }, "deferred", false],
    ["no options", undefined, "deferred", false],
    ["empty options", {}, "deferred", false],
    ["pinned: true", { pinned: true }, "deferred", true],
    ["pinned: false", { pinned: false }, "deferred", false],
    ["codemode: true and pinned: true", { codemode: true, pinned: true }, "deferred", true],
    ["codemode: false and pinned: true", { codemode: false, pinned: true }, "direct", false],
    ["codemode as text", { codemode: "false" }, "deferred", false],
    ["codemode: 0", { codemode: 0 }, "deferred", false],
    ["codemode: null", { codemode: null }, "deferred", false],
  ]

  for (const [name, options, exposure, pinned] of exposures) {
    it.effect(`offers a tool with ${name} ${exposure === "direct" ? "directly" : "through Code Mode"}`, () =>
      Effect.gen(function* () {
        const tool = { ...make(), options: options as Tool.Options | undefined }
        expect(ToolTraits.exposure(tool)).toBe(exposure)
        expect(ToolTraits.pinned(tool)).toBe(pinned)

        const service = yield* Tool.Service
        yield* service.transform((editor) => editor.add(tool))
        const snapshot = yield* service.snapshot()
        const direct = exposure === "direct"
        expect(snapshot.definitions.map((definition) => definition.name)).toEqual(
          direct ? ["echo", "Execute"] : ["Execute"],
        )
        expect(snapshot.codeModeCatalog?.tools).toEqual(
          direct ? [] : [expect.objectContaining({ type: "tool", name: "echo", pinned })],
        )
      }),
    )
  }

  it.effect("leaves a namespace out of how a tool is offered", () =>
    Effect.sync(() => {
      expect(ToolTraits.exposure({ options: { namespace: "acme" } })).toBe("deferred")
      expect(ToolTraits.exposure({ options: { namespace: "acme", codemode: false } })).toBe("direct")
      expect(ToolTraits.pinned({ options: { namespace: "acme", pinned: true } })).toBe(true)
    }),
  )

  // `execute` is the name of the Code Mode tool in the request, so a direct tool cannot take it. A deferred tool is
  // called through Code Mode, and a namespaced one is named `acme_execute`, so neither clashes with it.
  for (const [name, options, refused, direct, deferred] of [
    ["a direct tool", { codemode: false }, true, [], []],
    ["a tool that leaves codemode out", undefined, false, [], ["execute"]],
    ["a tool with codemode: true", { codemode: true }, false, [], ["execute"]],
    ["a pinned tool", { pinned: true }, false, [], ["execute"]],
    ["a direct tool in a namespace", { namespace: "acme", codemode: false }, false, ["acme_execute"], []],
  ] as const) {
    it.effect(`${refused ? "refuses" : "registers"} ${name} named execute`, () => {
      const output: unknown[] = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        output.push(entry.message)
      })
      return Effect.gen(function* () {
        const service = yield* Tool.Service
        yield* service.transform((editor) => editor.add({ ...make(), name: "execute", options }))

        expect(output).toEqual(
          refused
            ? [
                [
                  "Skipping invalid tool registration",
                  { name: "execute", namespace: undefined, error: 'Tool name "Execute" is reserved for CodeMode' },
                ],
              ]
            : [],
        )
        const snapshot = yield* service.snapshot()
        expect(snapshot.definitions.map((definition) => definition.name)).toEqual([...direct, "Execute"])
        expect(codeModeListings(snapshot.codeModeCatalog!).map((tool) => tool.path)).toEqual([...deferred])
        // Whatever registered, the `execute` that the request advertises is the Code Mode tool.
        expect(snapshot.definitions.at(-1)?.description).toContain("confined Code Mode runtime")
      }).pipe(Effect.provide(Logger.layer([logger])))
    })
  }
})
