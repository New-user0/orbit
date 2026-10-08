export * as CodeModeTool from "./tool.js"

import { CodeMode, Namespace, Tool, toolError } from "@orbit/codemode"
import type { Content, Context, Error, Info, Metadata, Namespace as ToolNamespace, Result } from "@orbit/schema/tool"
import { Cause, Deferred, Effect, Exit, Ref, Schema, Semaphore } from "effect"
import { Permission } from "../permission.js"
import { definition, normalizedName } from "../tool/runtime.js"
import { ToolTraits } from "../tool/traits.js"
import { CodeModeCatalog } from "./catalog.js"
import { CodeModeWeb } from "./web.js"

const ExecuteFile = Schema.Struct({
  data: Schema.String,
  mime: Schema.String,
  name: Schema.optionalKey(Schema.String),
})

const ExecuteCall = Schema.Struct({
  tool: Schema.String,
  status: Schema.Literals(["running", "completed", "error"]),
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})

type ExecuteCall = typeof ExecuteCall.Type

const ExecuteOutput = Schema.Struct({
  output: Schema.String,
  toolCalls: Schema.Array(ExecuteCall),
  error: Schema.optionalKey(Schema.Literal(true)),
  files: Schema.Array(ExecuteFile),
})

type CollectedFiles = {
  readonly index: number
  readonly files: Array<typeof ExecuteFile.Type>
}

type Node<T> = {
  tool?: T
  namespace?: ToolNamespace
  readonly children: Map<string, Node<T>>
}

type ToolNode = Node<Tool.Tool<never>>

type Tools = {
  [name: string]: Tool.Tool<never> | Namespace.Namespace<never> | Tools
}

export type Inventory = {
  readonly tools: ReadonlyMap<string, Info>
  readonly namespaces?: ReadonlyMap<string, ToolNamespace>
}

// Invariant model-facing guidance; the changing tool catalog is delivered through Instructions.
const description = [
  "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
  "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
  "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
  'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
  "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
  "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.all`.",
].join("\n")

// A call the program makes straight to a host function, such as `fetch`, is not a tool call, so it is authorized
// before it runs. A plain decline dies as a defect, as it does for a tool; any other failure fails the call. The
// function also asks about what the call does on its own, such as the redirects `fetch` follows, with a call of its own.
export type Authorize = (call: CodeMode.ExtensionInvocation, context: Context) => Effect.Effect<void, Error>

// Where a request that `fetch` is about to send may go, which it asks for the program's own request and for each redirect
// after the request is authorized. It fails when the request must not go out, and otherwise answers with the addresses to
// connect to instead of the host, none for a host that is an address, as `CodeModeWeb.Gate.resolve` takes them.
export type Resolve = (host: string) => Effect.Effect<ReadonlyArray<string>, Error>

export const create = (
  inventory: Inventory,
  executeTool: (name: string, tool: Info, input: unknown, context: Context) => Effect.Effect<Result, Error>,
  authorize: Authorize,
  resolve: Resolve,
) => {
  return {
    name: "execute",
    description,
    input: CodeMode.Input,
    output: ExecuteOutput,
    // Fetch is available to a program, so a call reaches beyond this machine. It is neither read-only nor safe beside
    // other calls; a program parallelizes inside with Promise.all.
    traits: { readOnly: false, concurrencySafe: false, openWorld: true, interruptBehavior: "block" },
    // A program authorizes itself: each tool it calls goes through the registry gate on its own, and `fetch` asks per request.
    options: { authorizes: true },
    execute: ({ code }, context) =>
      Effect.gen(function* () {
        // Aborts when the execution ends, however it ends, so a fetch that is still asking or sending stops with it.
        const signal = yield* Effect.abortSignal
        // A redirect is asked about, and the place a request may go is checked, from inside `fetch`, which is plain promise
        // code. Running those in this execution's own context keeps its loggers, minimum log level and tracer, as a new
        // root fiber would drop them.
        const run = Effect.runPromiseExitWith(yield* Effect.context())
        const callIndex = yield* Ref.make(0)
        const files = yield* Ref.make<Array<CollectedFiles>>([])
        const calls = yield* Ref.make<Array<ExecuteCall>>([])
        // A user's plain decline ends the step, as it does for a direct tool, so the program never gets to handle it.
        // The first one is kept here and stops the whole execution at once: an interrupted call never runs its
        // handlers, so a program that only finishes through them would wait forever, and a sibling call it still
        // awaits would run to completion first. A host call that starts before the stop lands is interrupted before
        // it runs, and the execution then dies with the decline for the step runner to recover. Feedback
        // (CorrectedError) and policy blocks stay ordinary tool failures the program sees.
        const declined = yield* Deferred.make<Permission.DeclinedError>()
        const halted = Effect.flatMap(Deferred.isDone(declined), (done) => (done ? Effect.interrupt : Effect.void))
        const latchDecline = <E>(cause: Cause.Cause<E>) => {
          const decline = cause.reasons.flatMap((reason) =>
            Cause.isDieReason(reason) && reason.defect instanceof Permission.DeclinedError ? [reason.defect] : [],
          )[0]
          if (decline === undefined) return Effect.failCause(cause)
          return Deferred.succeed(declined, decline).pipe(Effect.andThen(Effect.interrupt))
        }
        const lock = Semaphore.makeUnsafe(1)
        const record = (update: (items: Array<ExecuteCall>) => Array<ExecuteCall>) =>
          lock.withPermit(
            Ref.updateAndGet(calls, update).pipe(Effect.tap((toolCalls) => context.progress({ toolCalls }))),
          )
        const authorized = (call: CodeMode.ExtensionInvocation) =>
          authorize(call, context).pipe(Effect.catchCause(latchDecline))
        // A decline stops the whole execution the same way as for a call of the program's own, and whatever stops the
        // request ends the fetch that was following it.
        const ask = async <A>(effect: Effect.Effect<A, Error>) => {
          const exit = await run(Effect.andThen(halted, effect), { signal })
          if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
          return exit.value
        }
        const progress = progressHooks(record, authorized)
        const codeMode = runtime(
          inventory,
          (name, tool, input) =>
            Effect.gen(function* () {
              const index = yield* Ref.getAndUpdate(callIndex, (index) => index + 1)
              const executed = yield* executeTool(name, tool, input, context).pipe(Effect.catchCause(latchDecline))
              const content =
                typeof executed.content === "string"
                  ? [{ type: "text" as const, text: executed.content }]
                  : (executed.content ?? [])
              const outputFileParts = outputFiles(content)
              if (outputFileParts.length > 0)
                yield* Ref.update(files, (items) => [...items, { index, files: outputFileParts }])
              if (executed.output !== undefined) return executed.output
              const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
              return text === "" ? null : text
            }),
          {
            ...progress,
            "tool.before": (call) => Effect.andThen(halted, progress["tool.before"](call)),
            "extension.before": (call) => Effect.andThen(halted, progress["extension.before"](call)),
          },
          {
            signal,
            // A redirect is a request of its own, so it is asked about like a call of the program's own.
            authorize: (url, method) =>
              ask(authorized({ extension: CodeModeWeb.name, name: "fetch", args: [url, { method }] })),
            resolve: (host) => ask(resolve(host)),
          },
        )
        // The program settles however it likes, but a decline stops it and has the last word, even over a program
        // that finished first.
        const settled = yield* Effect.exit(
          Effect.raceFirst(codeMode.execute(code), Effect.andThen(Deferred.await(declined), Effect.interrupt)),
        )
        if (yield* Deferred.isDone(declined)) return yield* Effect.flatMap(Deferred.await(declined), Effect.die)
        const result = yield* settled
        const toolCalls = yield* Ref.get(calls)
        const collected = (yield* Ref.get(files))
          .toSorted((left, right) => left.index - right.index)
          .flatMap((item) => item.files)
        const output = formatResult(result)
        const value: typeof ExecuteOutput.Type = {
          output,
          toolCalls,
          files: collected,
          ...(result.ok ? {} : { error: true }),
        }
        const content: Array<Content> = [
          { type: "text", text: value.output },
          ...value.files.map((file) => ({
            type: "file" as const,
            uri: `data:${file.mime};base64,${file.data}`,
            mime: file.mime,
            ...(file.name === undefined ? {} : { name: file.name }),
          })),
        ]
        const metadata: Metadata = {
          toolCalls: value.toolCalls,
          ...(value.error ? { error: true } : {}),
        }
        return {
          output: value,
          content,
          metadata,
        }
      }).pipe(Effect.scoped),
  } satisfies Info
}

// Rows appear in start order; the same call object arrives at both hooks, so a call finds its row again.
function progressHooks(
  record: (update: (items: Array<ExecuteCall>) => Array<ExecuteCall>) => Effect.Effect<unknown>,
  authorize: (call: CodeMode.ExtensionInvocation) => Effect.Effect<void, Error>,
) {
  const rows = new WeakMap<object, number>()
  const start = (call: object, entry: ExecuteCall) =>
    record((items) => {
      rows.set(call, items.length)
      return [...items, entry]
    })
  const settle = (call: object, result: CodeMode.CallResult) => {
    const index = rows.get(call)
    if (index === undefined) return Effect.void
    return record((items) => {
      const next = [...items]
      next[index] = { ...items[index], status: result.status === "success" ? "completed" : "error" }
      return next
    })
  }
  return {
    "tool.before": (call) => {
      const shown = displayInput(call.input)
      return start(call, { tool: call.name, status: "running", ...(shown ? { input: shown } : {}) })
    },
    "tool.after": settle,
    // A call that is not authorized never starts, so it never reaches `extension.after`: it gets its error row here, and
    // an authorized one its running row only once it may go ahead. Only listed extension functions get a row; anything
    // else stays out of the TUI.
    "extension.before": (call) =>
      Effect.suspend(() => {
        const row = call.name === "fetch" ? { tool: call.name, input: CodeModeWeb.display(call.args) } : undefined
        return authorize(call).pipe(
          Effect.tapError(() => (row ? record((items) => [...items, { ...row, status: "error" }]) : Effect.void)),
          Effect.andThen(() => (row ? start(call, { ...row, status: "running" }) : Effect.void)),
        )
      }),
    "extension.after": settle,
  } satisfies CodeMode.Hooks
}

export const catalog = (inventory: Inventory) => {
  const pinned = new Set(Array.from(inventory.tools.values()).filter(ToolTraits.pinned).map(qualifiedName))
  const root: CatalogNode = { children: new Map() }
  for (const namespace of inventory.namespaces?.values() ?? []) getNode(root, namespace.name).namespace = namespace
  for (const tool of runtime(inventory, () => Effect.fail(toolError("Execute context is unavailable"))).catalog)
    getNode(root, tool.path).tool = {
      type: "tool",
      name: tool.path.split(".").at(-1) ?? tool.path,
      description: tool.description,
      signature: tool.signature,
      pinned: pinned.has(tool.path),
    }
  return {
    tools: renderCatalog(root),
  } satisfies CodeModeCatalog.Inventory
}

type CatalogNode = Node<CodeModeCatalog.Tool>

function renderCatalog(root: CatalogNode): ReadonlyArray<CodeModeCatalog.Tool | CodeModeCatalog.Namespace> {
  return Array.from(root.children)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([name, node]) => {
      const tools = renderCatalog(node)
      const namespace =
        node.namespace === undefined && tools.length === 0
          ? undefined
          : {
              type: "namespace" as const,
              name,
              ...(node.namespace?.description === undefined ? {} : { description: node.namespace.description }),
              tools,
            }
      if (node.tool === undefined) return namespace === undefined ? [] : [namespace]
      if (namespace === undefined) return [node.tool]
      return [node.tool, namespace]
    })
}

function runtime(
  inventory: Inventory,
  executeTool: (name: string, tool: Info, input: unknown) => Effect.Effect<unknown, unknown>,
  hooks?: CodeMode.Hooks,
  // Absent where nothing runs a program, such as when only the catalog is listed, and then there is no `fetch` to call.
  web?: CodeModeWeb.Gate,
) {
  // A path may carry namespace metadata, a callable tool, child tools, or all three.
  const root: ToolNode = { children: new Map() }
  for (const namespace of inventory.namespaces?.values() ?? []) getNode(root, namespace.name).namespace = namespace
  for (const [name, registration] of inventory.tools) {
    const child = definition(registration)
    getNode(root, qualifiedName(registration)).tool = Tool.make({
      description: child.description,
      searchHint: registration.traits?.searchHint,
      input: child.inputSchema,
      output: child.outputSchema ?? Schema.NullOr(Schema.String),
      execute: (input) => executeTool(name, registration, input),
    })
  }
  const tools = renderTools(root)
  return CodeMode.make<typeof tools>({
    tools,
    extensions: web === undefined ? [] : [CodeModeWeb.extension(web)],
    hooks,
  })
}

function getNode<T>(root: Node<T>, path: string) {
  return path.split(".").reduce((parent, name) => {
    const child: Node<T> = parent.children.get(name) ?? { children: new Map() }
    parent.children.set(name, child)
    return child
  }, root)
}

function renderTools(root: ToolNode) {
  const callables = new Map<string, Tool.Tool<never>>()
  const tools = renderChildren(root, [], callables)
  for (const [path, tool] of callables) tools[path] = tool
  return tools
}

function renderChildren(node: ToolNode, path: ReadonlyArray<string>, callables: Map<string, Tool.Tool<never>>): Tools {
  return Object.fromEntries(
    Array.from(node.children).flatMap(([name, child]) => {
      const next = [...path, name]
      // A record cannot hold both a top-level tool and namespace under the same key.
      if (path.length === 0 && child.tool !== undefined && (child.namespace !== undefined || child.children.size > 0)) {
        const tools: Tools = {}
        flattenTools(child, next, tools)
        return Object.entries(tools)
      }
      return [[name, renderEntry(child, next, callables)]]
    }),
  )
}

function renderEntry(
  node: ToolNode,
  path: ReadonlyArray<string>,
  callables: Map<string, Tool.Tool<never>>,
): Tools[string] {
  const tools = renderChildren(node, path, callables)
  // CodeMode merges this dotted tool path with the nested namespace entry.
  if (node.tool !== undefined && (node.namespace !== undefined || node.children.size > 0))
    callables.set(path.join("."), node.tool)
  if (node.namespace !== undefined)
    return Namespace.make({
      description: node.namespace.description,
      tools,
    })
  if (node.tool === undefined) return tools
  if (node.children.size === 0) return node.tool
  return tools
}

function flattenTools(node: ToolNode, path: ReadonlyArray<string>, tools: Tools) {
  if (node.tool !== undefined) tools[path.join(".")] = node.tool
  for (const [name, child] of node.children) flattenTools(child, [...path, name], tools)
}

function qualifiedName(registration: Info) {
  const normalized = normalizedName(registration)
  if (registration.options?.namespace === undefined) return normalized
  return `${registration.options.namespace}.${normalized}`
}

// Tool inputs arrive as parsed JSON, so the JSON value cast is a boundary fact.
function displayInput(input: unknown): Record<string, typeof Schema.Json.Type> | undefined {
  if (input === null || input === undefined) return
  if (typeof input !== "object" || Array.isArray(input)) return { input: input as typeof Schema.Json.Type }
  if (Object.keys(input).length === 0) return
  return input as Record<string, typeof Schema.Json.Type>
}

export function formatResult(result: CodeMode.Result) {
  const output = result.ok
    ? formatValue(result.value)
    : [result.error.message, ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))]
        .join("\n")
        .trim()
  const warnings =
    result.ok && result.warnings && result.warnings.length > 0
      ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
      : undefined
  const logs = result.logs && result.logs.length > 0 ? `Logs:\n${result.logs.join("\n")}` : undefined
  return [output, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n")
}

function formatValue(value: CodeMode.DataValue) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

function outputFiles(content: ReadonlyArray<Content>): Array<typeof ExecuteFile.Type> {
  return content.flatMap((part) => {
    if (part.type !== "file") return []
    const prefix = `data:${part.mime};base64,`
    if (!part.uri.startsWith(prefix)) return []
    return [
      {
        data: part.uri.slice(prefix.length),
        mime: part.mime,
        ...(part.name === undefined ? {} : { name: part.name }),
      },
    ]
  })
}
