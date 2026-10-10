export * as McpTool from "./mcp.js"

import { ToolFailure } from "@orbit/ai"
import { name, namespace } from "@orbit/schema/mcp"
import { McpEvent } from "@orbit/schema/mcp-event"
import { Context, Effect, Fiber, type JsonSchema, Layer, PubSub, Semaphore, Stream } from "effect"
import { plain } from "@orbit/util/plain"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bus } from "../bus.js"

import { Mcp } from "../mcp/index.js"
import { Permission } from "../permission.js"
import { Tool } from "../tool.js"

/**
 * Registry namespace and permission action names for MCP tools. The compatibility readers translate other products'
 * names for the same tools, so the one definition lives in `@orbit/schema/mcp`.
 */
export { name, namespace }

/**
 * The traits of an MCP tool, from the annotations its server declares. A server is not trusted, so a hint decides how a
 * call is scheduled and how it is drawn and nothing else: `readOnly` is never declared, so a call of an MCP tool is
 * never read-only whatever the hints say, the permission request is the same with or without them, and no hook payload
 * carries them.
 *
 * - `concurrencySafe` is `readOnlyHint === true`, which only matters for a tool that is loaded directly.
 * - `destructive` and `openWorld` follow the defaults of the MCP specification and are advisory.
 * - `displayName` is the first of the tool's `title` and its `annotations.title` that is not blank, trimmed, and
 *   stored with its control and format characters written out, because the server chose it and clients draw it. A
 *   blank title gives none, as registration refuses an empty one.
 * - `idempotentHint` and vendor-specific `_meta` keys are not read.
 */
export function traits(tool: Mcp.Tool): Tool.Traits {
  const annotations = tool.annotations
  const readOnly = annotations?.readOnlyHint === true
  const title = [tool.title, annotations?.title].map((value) => value?.trim()).find((value) => value)
  return {
    concurrencySafe: readOnly,
    destructive: !readOnly && annotations?.destructiveHint !== false,
    openWorld: annotations?.openWorldHint !== false,
    interruptBehavior: "block",
    ...(title === undefined ? {} : { displayName: plain(title) }),
  }
}

export interface Interface {
  /** Wait for the initial MCP tool registration to settle. */
  readonly flush: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/McpTool") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const tools = yield* Tool.Service
    const bus = yield* Bus.Service
    const permission = yield* Permission.Service
    const lock = Semaphore.makeUnsafe(1)
    let discovered: Mcp.Tool[] = []

    // Register once after initial discovery; only subsequent updates need a debounced reload.
    const initial = yield* lock
      .withPermit(
        Effect.gen(function* () {
          discovered = yield* mcp.tools()
          yield* tools.transform((editor) => {
            for (const tool of discovered) {
              editor.add({
                name: tool.name,
                options: { authorizes: true, namespace: namespace(tool.server), codemode: tool.codemode !== false },
                traits: traits(tool),
                description: tool.description ?? "",
                input: (tool.inputSchema ?? { type: "object", properties: {} }) as JsonSchema.JsonSchema,
                output: (tool.outputSchema ?? {}) as JsonSchema.JsonSchema,
                execute: (input, context) =>
                  Effect.gen(function* () {
                    yield* permission.assert({
                      action: name(tool.server, tool.name),
                      resources: ["*"],
                      save: ["*"],
                      // The arguments the server receives, so an MCP call through Code Mode, whose caller is the Execute tool,
                      // is approved with what it sends.
                      metadata: { arguments: input ?? {} },
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: {
                        type: "tool",
                        messageID: context.messageID,
                        id: context.id,
                      },
                    })
                    const result = yield* mcp
                      .callTool({
                        server: tool.server,
                        name: tool.name,
                        args: (input ?? {}) as Record<string, unknown>,
                        sessionID: context.sessionID,
                      })
                      .pipe(
                        Effect.catchTags({
                          "MCP.NotFoundError": (error) =>
                            new ToolFailure({ message: `MCP server "${error.server}" is not available` }),
                          "MCP.ToolCallError": (error) => new ToolFailure({ message: error.message }),
                        }),
                      )
                    if (result.isError)
                      return yield* new ToolFailure({
                        message:
                          result.content
                            .flatMap((part) => (part.type === "text" ? [part.text] : []))
                            .join("\n")
                            .trim() || "MCP tool returned an error",
                      })
                    const content = result.content.map((part) =>
                      part.type === "text"
                        ? { type: "text" as const, text: part.text }
                        : {
                            type: "file" as const,
                            uri: `data:${part.mimeType};base64,${part.data}`,
                            mime: part.mimeType,
                          },
                    )
                    const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                    const output = () => {
                      if (result.structured !== undefined) return result.structured
                      if (text === "") return null
                      // Agents assume JSON returned as text is already an object, so parse it when the server declares no schema.
                      if (tool.outputSchema === undefined && (text.startsWith("{") || text.startsWith("["))) {
                        try {
                          return JSON.parse(text)
                        } catch {}
                      }
                      return text
                    }
                    return {
                      output: output(),
                      ...(content.length === 0 ? {} : { content }),
                    }
                  }).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure
                        ? error
                        : error instanceof Permission.BlockedError || error instanceof Permission.CorrectedError
                          ? // A refusal keeps its cause, so the session error is `permission.rejected`.
                            new ToolFailure({
                              message: error instanceof Permission.CorrectedError ? error.feedback : error.message,
                              error,
                            })
                          : new ToolFailure({ message: `Unable to execute ${name(tool.server, tool.name)}` }),
                    ),
                  ),
              })
            }
          })
        }),
      )
      .pipe(Effect.forkScoped)
    const reconcile = lock.withPermit(
      Effect.gen(function* () {
        discovered = yield* mcp.tools()
        yield* tools.reload()
      }),
    )

    // Servers announce tools in bursts and each read loads the whole catalog, so settle and refresh
    // once. The bus subscription stays eager; only the already-open sliding subscription is debounced.
    const changes = yield* PubSub.sliding<void>(1)
    yield* bus.subscribe(McpEvent.ToolsChanged).pipe(
      Stream.runForEach(() => PubSub.publish(changes, undefined)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reconcile),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({ flush: Effect.asVoid(Fiber.await(initial)) })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Tool.node, Mcp.node, Bus.node, Permission.node],
})
