export * as Tool from "./tool.js"
export { CallID, Content, Error, ErrorCode, FileContent, TextContent } from "@orbit/schema/tool"
export type {
  Context,
  InterruptBehavior,
  Metadata,
  Namespace,
  Options,
  Predicate,
  ResolvedTraits,
  Result,
  Traits,
} from "@orbit/schema/tool"

import { ToolDefinition, type ToolCall } from "@orbit/ai"
import { Tool } from "@orbit/schema/tool"
import { AddressGuard } from "@orbit/util/address-guard"
import { Cause, Context, Effect, Layer, Result, Schema, SchemaIssue, Types } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import type { Agent } from "./agent.js"
import { CodeModeCatalog } from "./codemode/catalog.js"
import { CodeModeTool } from "./codemode/tool.js"
import { CodeModeWeb } from "./codemode/web.js"
import { Image } from "./image.js"
import { Permission } from "./permission.js"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"
import { State } from "./state.js"
import { ToolAuthorization } from "./tool/authorization.js"
import { ToolCurrentCall } from "./tool/current-call.js"
import {
  type Authorize,
  decode,
  definition,
  effectiveName,
  execute,
  normalizedName,
  normalizeContent,
} from "./tool/runtime.js"
import { ToolNames } from "./tool/names.js"
import { ToolTraits } from "./tool/traits.js"

/** The call that is executing; see `ToolCurrentCall`. */
export const CurrentCall = ToolCurrentCall.Current
export type Call = ToolCurrentCall.Call

export class RegistrationError extends Schema.TaggedError<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export interface Editor {
  readonly list: () => readonly (Tool.Info & { readonly id: string })[]
  readonly get: (id: string) => (Tool.Info & { readonly id: string }) | undefined
  readonly namespace: (namespace: Tool.Namespace) => void
  readonly add: (tool: Tool.Info) => void
  readonly update: (id: string, update: (tool: Types.Mutable<Tool.Info>) => void) => void
  readonly remove: (id: string) => void
  /** Settings for `fetch` in Code Mode. */
  readonly web: (settings: { readonly allowLocal?: boolean; readonly lookup?: AddressGuard.Options["lookup"] }) => void
}

type Data = {
  tools: Map<string, Tool.Info & { readonly id: string }>
  namespaces: Map<string, Tool.Namespace>
  errors: { kind: "tool" | "namespace"; name: string; namespace?: string; error: RegistrationError }[]
  web: {
    /** Whether `fetch` may reach loopback and private-network addresses, such as a local dev server. */
    allowLocal: boolean
    /** Resolves the name of a host to its addresses, in place of the system resolver. */
    lookup?: AddressGuard.Options["lookup"]
  }
}

export interface Interface extends State.Transformable<Editor> {
  readonly list: () => Effect.Effect<ReadonlyArray<Tool.Info & { readonly id: string }>>
  readonly snapshot: (permissions?: Permission.Ruleset) => Effect.Effect<Snapshot>
  /**
   * Checks where a web request to `host` may go, with the settings of `fetch` in Code Mode, and answers with the addresses
   * it must connect to instead of the host (none for a host that is an address). Resolving a name is a request to the
   * network, so ask permission for the host first. It fails for an address that is not public (unless the configuration
   * allows local servers), for any link-local or metadata address, and for a name that resolves to nothing.
   */
  readonly resolveWeb: (host: string) => Effect.Effect<ReadonlyArray<string>, Error>
}

/** The context of a call before `execute` resolves its tool's traits and adds them. */
type UnresolvedContext = Omit<Tool.Context, "traits">

/** A local execution result after hooks and content normalization. */
export interface NormalizedResult extends Tool.Result {
  readonly content: ReadonlyArray<Tool.Content>
}

export interface Snapshot {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly codeModeCatalog?: CodeModeCatalog.Inventory
  readonly execute: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly call: ToolCall
    readonly progress?: (update: Tool.Metadata) => Effect.Effect<void>
    /** Surviving request definitions, keyed by the names advertised after session context hooks. */
    readonly definitions?: ReadonlyMap<string, ToolDefinition>
  }) => Effect.Effect<NormalizedResult, Tool.Error>
  /**
   * The traits of a call, resolved the way `execute` resolves its tool but before any hook runs, on the input the
   * model sent. A hook that renames the tool or rewrites the input is not seen here; `Tool.Context.traits` is
   * resolved after the hooks and is the answer the tool receives. A call that cannot be resolved gets conservative
   * traits: the conservative record when the tool is unknown or not offered in `definitions`, and, for a tool whose
   * traits depend on the input, the conservative answers beside what the tool declares about itself when the schema
   * rejects or throws on the input. A tool whose traits are all fixed never looks at the input.
   */
  readonly traits: (input: {
    readonly call: ToolCall
    /** Surviving request definitions, keyed by the names advertised after session context hooks. */
    readonly definitions?: ReadonlyMap<string, ToolDefinition>
  }) => Effect.Effect<Tool.ResolvedTraits>
  /** The traits of the tool a name resolves to that do not depend on the call, or `undefined` for an unresolved name. */
  readonly describe: (
    name: string,
    /** Surviving request definitions, keyed by the names advertised after session context hooks. */
    definitions?: ReadonlyMap<string, ToolDefinition>,
  ) => ToolTraits.Static | undefined
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Tool") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const image = yield* Image.Service
    const permission = yield* Permission.Service

    type NormalizedItem = Tool.Content | "decode" | "size"
    const normalizeImages = Effect.fnUntraced(function* (content: ReadonlyArray<Tool.Content>) {
      const normalized = yield* Effect.forEach(content, (item): Effect.Effect<ReadonlyArray<NormalizedItem>> => {
        if (item.type !== "file" || !item.mime.startsWith("image/")) return Effect.succeed([item])
        const base64 = /^data:[^,]*;base64,(.*)$/s.exec(item.uri)?.[1]
        if (base64 === undefined) return Effect.succeed([item])
        const resource = item.name ?? `${item.mime} tool output`
        return image.normalize(resource, { uri: resource, content: base64, encoding: "base64", mime: item.mime }).pipe(
          Effect.map((result): ReadonlyArray<NormalizedItem> => [
            // Built field by field: a recorded item keeps keys its schema would drop, so nothing of `result` may spread in.
            {
              type: "file",
              uri: `data:${result.content.mime};base64,${result.content.content}`,
              mime: result.content.mime,
              ...(item.name === undefined ? {} : { name: item.name }),
            },
            ...(result.resized
              ? [
                  {
                    type: "text" as const,
                    text: `[Shown at ${result.resized.to.width}×${result.resized.to.height} px; the file itself is ${result.resized.from.width}×${result.resized.from.height} px. Scale positions on the shown image by ${(result.resized.from.width / result.resized.to.width).toFixed(2)} to map them onto the file.]`,
                  },
                ]
              : []),
          ]),
          Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed([item])),
          Effect.catchTag("Image.DecodeError", () => Effect.succeed(["decode" as const])),
          Effect.catchTag("Image.SizeError", () => Effect.succeed(["size" as const])),
        )
      }).pipe(Effect.map((items) => items.flat()))
      const note = (reason: "decode" | "size", text: string) => {
        const count = normalized.filter((item) => item === reason).length
        if (count === 0) return []
        return [{ type: "text" as const, text: `[${count} image${count === 1 ? "" : "s"} omitted: ${text}]` }]
      }
      return [
        ...normalized.filter((item) => typeof item !== "string"),
        ...note("decode", "could not be decoded."),
        ...note("size", "could not be resized below the image size limit."),
      ]
    })

    const beforeExecute = (name: string, input: unknown, context: UnresolvedContext) =>
      hooks.trigger("tool", "execute.before", {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        // A guard keyed on an old field name still sees the field. The registry runs on the real input.
        input: ToolNames.view(name, input),
      })

    // The registry gate, for every path that runs a tool: a direct call and a Code Mode inner call both pass through
    // `executeTool`. A tool that does not say it asks about the call itself is asked about here, on its permission action
    // or its name, and a declaration that is missing or broken counts as not saying so.
    const gate: Authorize = (tool, decoded, context) =>
      ToolAuthorization.authorizesItself(tool, decoded).pipe(
        Effect.flatMap((authorizes) =>
          authorizes
            ? Effect.void
            : permission
                .assert({
                  action: tool.options?.permission ?? effectiveName(tool),
                  resources: ["*"],
                  save: ["*"],
                  metadata: {},
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(
                  Effect.mapError(
                    (error) =>
                      new Tool.Error({
                        message: error instanceof Permission.CorrectedError ? error.feedback : error.message,
                        error,
                      }),
                  ),
                ),
        ),
      )

    const executeTool = Effect.fn("Tool.execute")(function* (
      tool: Tool.Info,
      name: string,
      input: unknown,
      context: UnresolvedContext,
    ) {
      const execution = yield* execute(tool, input, context, gate).pipe(
        Effect.provideService(CurrentCall, { tool: name, input }),
        Effect.map((value) => ({ value })),
        Effect.catchTag("Tool.Error", (failure) => Effect.succeed({ failure })),
      )
      const base = {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input: ToolNames.view(name, input),
      }
      if ("failure" in execution) {
        const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
          ...base,
          status: "error",
          error: execution.failure,
        }
        yield* hooks.trigger("tool", "execute.after", afterEvent)
        return yield* afterEvent.error
      }
      const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
        ...base,
        status: "completed",
        result: {
          ...(execution.value.output === undefined ? {} : { output: execution.value.output }),
          content: execution.value.content,
          ...(execution.value.metadata === undefined ? {} : { metadata: execution.value.metadata }),
        },
      }
      yield* hooks.trigger("tool", "execute.after", afterEvent)
      const afterContent = yield* normalizeImages(normalizeContent(afterEvent.result.content, afterEvent.result.output))
      return {
        ...(afterEvent.result.output === undefined ? {} : { output: afterEvent.result.output }),
        content: afterContent,
        ...(afterEvent.result.metadata === undefined ? {} : { metadata: afterEvent.result.metadata }),
      }
    })

    // Where a request may go whatever the permission rules say: not to this machine or the networks around it, unless the
    // configuration allows local servers, and never to a link-local or cloud metadata address. `fetch` asks once a
    // request is authorized and not before, because resolving a name is a request to the network and nobody approved the
    // host until then. The answer is the addresses that were checked, which the request connects to instead of the
    // host: the host would be resolved again when it connects, and a name can answer differently each time. A name that
    // resolves to nothing has no place to check, so it is refused too.
    const resolve: CodeModeTool.Resolve = (host) =>
      Effect.promise(() =>
        AddressGuard.check(host, {
          allow: state.get().web.allowLocal ? ["loopback", "private"] : [],
          lookup: state.get().web.lookup,
        }),
      ).pipe(
        Effect.flatMap((checked) =>
          checked.allowed
            ? Effect.succeed(checked.connect)
            : Effect.fail(
                new Tool.Error({ message: refusedMessage(host, checked.refusal), code: Tool.ErrorCode.WebFetchRefused }),
              ),
        ),
      )

    // Fail closed: a function the Code Mode runtime exposes is callable only once it is listed here. It runs for a
    // program's own call and again for each redirect that call follows, so every request is asked about on its own.
    const authorize: CodeModeTool.Authorize = (call, context) => {
      if (call.extension !== CodeModeWeb.name || call.name !== "fetch")
        return Effect.fail(
          new Tool.Error({ message: `Code Mode function ${call.extension}.${call.name} is not authorized` }),
        )
      return Effect.try({
        try: () => CodeModeWeb.request(call.args),
        catch: (error) =>
          new Tool.Error({
            message: error instanceof Error ? error.message : String(error),
            code: Tool.ErrorCode.WebFetchRefused,
          }),
      }).pipe(
        Effect.flatMap((web) =>
          permission
            .assert({
              action: "WebFetch",
              ...web,
              sessionID: context.sessionID,
              agent: context.agent,
              // Every call in a program shares the execute call's ID, so the metadata tells them apart.
              source: { type: "tool", messageID: context.messageID, id: context.id },
            })
            .pipe(
              // The program sees a policy block's reason or the user's feedback as an error it can catch.
              Effect.mapError(
                (error) =>
                  new Tool.Error({
                    message: error instanceof Permission.CorrectedError ? error.feedback : error.message,
                    error,
                  }),
              ),
            ),
        ),
      )
    }

    let catalog: { data: Data; names: string; value: CodeModeCatalog.Inventory } | undefined
    const state = State.create<Data, Editor>({
      name: "tool",
      initial: () => ({
        tools: new Map(),
        namespaces: new Map(),
        errors: [],
        web: { allowLocal: false },
      }),
      editor: (editor) => ({
        list: () => Array.from(editor.tools.values()),
        get: (id) => editor.tools.get(held(editor.tools, id)),
        namespace: (namespace) => {
          const error = namespaceError(namespace.name)
          if (error) {
            editor.errors.push({ kind: "namespace", name: namespace.name, namespace: namespace.name, error })
            return
          }
          editor.namespaces.set(namespace.name, { ...namespace })
        },
        add: (tool) => {
          const error = registrationError(tool)
          if (error) {
            editor.errors.push({ kind: "tool", name: tool.name, namespace: tool.options?.namespace, error })
            return
          }
          const id = effectiveName(tool)
          editor.tools.set(id, {
            ...tool,
            id,
            options: tool.options && { ...tool.options },
            traits: tool.traits && { ...tool.traits },
          })
        },
        update: (given, update) => {
          const id = held(editor.tools, given)
          const current = editor.tools.get(id)
          if (!current) return
          const tool = {
            ...current,
            options: current.options && { ...current.options },
            traits: current.traits && { ...current.traits },
          }
          update(tool)
          tool.name = current.name
          tool.id = id
          if (tool.options?.namespace !== current.options?.namespace)
            tool.options = { ...tool.options, namespace: current.options?.namespace }
          const error = registrationError(tool)
          if (error) {
            editor.errors.push({ kind: "tool", name: tool.name, namespace: tool.options?.namespace, error })
            return
          }
          editor.tools.set(id, tool)
        },
        remove: (id) => {
          editor.tools.delete(held(editor.tools, id))
        },
        web: (settings) => {
          if (settings.allowLocal !== undefined) editor.web.allowLocal = settings.allowLocal
          if (settings.lookup !== undefined) editor.web.lookup = settings.lookup
        },
      }),
      notify: (value) => {
        catalog = undefined
        return Effect.forEach(
          value.errors,
          ({ kind, name, namespace, error }) =>
            Effect.logError(`Skipping invalid ${kind} registration`, {
              name,
              namespace,
              error: error.message,
            }),
          { discard: true },
        )
      },
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      resolveWeb: resolve,
      list: () => Effect.sync(() => Array.from(state.get().tools.values())),
      snapshot: Effect.fn("Tool.snapshot")((permissions) =>
        Effect.sync(() => {
          const data = state.get()
          const active = new Map<string, Tool.Info>()
          const rules = permissions ?? []
          for (const [name, tool] of data.tools) {
            if (whollyDisabled(tool.options?.permission ?? name, rules)) continue
            active.set(name, tool)
          }
          const exposed = Map.groupBy(active, ([, tool]) => ToolTraits.exposure(tool))
          const direct = new Map(exposed.get("direct"))
          const codeModeTools = new Map(exposed.get("deferred"))
          const namespaces = data.namespaces
          const codeModeInventory = { tools: codeModeTools, namespaces }
          const codeModeEnabled = !whollyDisabled("Execute", rules)
          const codeModeTool = codeModeEnabled
            ? CodeModeTool.create(
                codeModeInventory,
                (name, tool, input, context) =>
                  beforeExecute(name, input, context).pipe(
                    Effect.flatMap((event) =>
                      executeTool(tool, name, ToolNames.lowerInput(name, event.input), context),
                    ),
                  ),
                authorize,
                resolve,
              )
            : undefined
          const names = Array.from(codeModeTools.keys()).join("\0")
          // Discovery is immutable for a registry revision and visible tool set. Keep request
          // definitions/executors fresh, but share the much larger rendered catalog across steps.
          const codeModeCatalog = !codeModeEnabled
            ? undefined
            : catalog?.data === data && catalog.names === names
              ? catalog.value
              : CodeModeTool.catalog(codeModeInventory)
          if (codeModeCatalog) catalog = { data, names, value: codeModeCatalog }
          // The one place a requested name becomes a tool, so `execute`, `traits` and `describe` cannot disagree.
          const find = (requested: string, definitions: ReadonlyMap<string, ToolDefinition> | undefined) => {
            const advertised = definitions?.get(requested)
            // Preserve session context removal and alias resolution, now after the repair hook.
            if (!advertised && definitions && (direct.has(requested) || codeModeTool?.name === requested))
              return { type: "unavailable" as const }
            const name = advertised?.name ?? requested
            const tool = name === "Execute" && codeModeTool ? codeModeTool : direct.get(name)
            return tool ? { type: "found" as const, name, tool } : { type: "unknown" as const, name }
          }
          return {
            ...(codeModeCatalog === undefined ? {} : { codeModeCatalog }),
            definitions: [
              ...Array.from(direct)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([, tool]) => definition(tool)),
              ...(codeModeTool ? [definition(codeModeTool)] : []),
            ],
            execute: Effect.fnUntraced(function* (input: Parameters<Snapshot["execute"]>[0]) {
              const context: UnresolvedContext = {
                sessionID: input.sessionID,
                agent: input.agent,
                messageID: input.messageID,
                id: Tool.CallID.make(input.call.id),
                progress: input.progress ?? (() => Effect.void),
              }
              // Hooks are told the registry name of the tool, so a guard on `Bash` also meets a shell offered as
              // `PowerShell`. A hook that leaves the name as it was keeps the request as the model made it.
              const registryName = input.definitions?.get(input.call.name)?.name ?? input.call.name
              const event = yield* beforeExecute(registryName, input.call.input, context)
              const found = find(event.tool === registryName ? input.call.name : event.tool, input.definitions)
              if (found.type === "unavailable")
                return yield* new Tool.Error({
                  message: `Tool is not available for this request: ${event.tool}`,
                  code: Tool.ErrorCode.Unavailable,
                })
              if (found.type === "unknown")
                return yield* new Tool.Error({
                  message: `No tool named "${found.name}" is currently available. Please use a tool from the available tool list.`,
                  code: Tool.ErrorCode.Unknown,
                })
              return yield* executeTool(found.tool, found.name, ToolNames.lowerInput(found.name, event.input), context)
            }),
            traits: Effect.fnUntraced(function* (input: Parameters<Snapshot["traits"]>[0]) {
              const found = find(input.call.name, input.definitions)
              if (found.type !== "found") return ToolTraits.conservative
              // The input is decoded for the predicates, so a tool without any does not pay for it.
              if (!ToolTraits.dynamic(found.tool)) return yield* ToolTraits.resolve(found.tool, undefined)
              return yield* decode(found.tool, input.call.input).pipe(
                Effect.flatMap((decoded) => ToolTraits.resolve(found.tool, decoded)),
                // No predicate can read input that the schema rejects, which is routine and which `execute` reports, or
                // input that the schema throws on, which is a defect in the tool and is logged. Neither may fail the
                // answer, and only an interrupt gets past.
                Effect.tapCauseIf(
                  (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
                  (cause) =>
                    Effect.logError(
                      "Tool input could not be decoded to resolve its traits; the call takes the conservative traits",
                      { tool: found.tool.name, cause },
                    ),
                ),
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterrupts(cause),
                  () => Effect.succeed(ToolTraits.conservativeFor(found.tool)),
                ),
                Effect.orDie,
              )
            }),
            describe: (name: string, definitions?: ReadonlyMap<string, ToolDefinition>) => {
              const found = find(name, definitions)
              return found.type === "found" ? ToolTraits.describe(found.tool) : undefined
            },
          }
        }),
      ),
    })
  }),
)

const whollyDisabled = (action: string, rules: Permission.Ruleset) => {
  const rule = rules.findLast((rule) => Permission.actionMatches(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

const addressKinds = {
  loopback: "a loopback address",
  private: "a private network address",
  "link-local": "a link-local address",
  metadata: "a cloud metadata address",
} satisfies Record<AddressGuard.Kind, string>

// The program sees this as the error of its fetch, so it names the way out for the kinds that have one.
function refusedMessage(host: string, refusal: AddressGuard.Refusal) {
  if (refusal.kind === "unresolved") return `fetch cannot reach ${host}: it does not resolve to an address.`
  const named = refusal.address === host ? host : `${host} (${refusal.address})`
  const hint =
    refusal.kind === "loopback" || refusal.kind === "private"
      ? " Set experimental.allow_local_fetch to true in the configuration to let fetch reach local servers."
      : ""
  return `fetch cannot reach ${named}: it is ${addressKinds[refusal.kind]}.${hint}`
}

const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

function schemaMakeError(error: unknown) {
  if (error instanceof Error && SchemaIssue.isIssue(error.cause)) return formatSchemaIssue(error.cause)
  return error instanceof Error ? error.message : String(error)
}

// A plugin written against the old names edits the registry by `shell` or `write`: an id with no exact entry is looked
// up under its current name, and an exact entry wins, as in `ToolNames.aliased`.
function held(tools: Map<string, unknown>, id: string) {
  return tools.has(id) ? id : ToolNames.canonical(id)
}

function registrationError(tool: Tool.Info) {
  const namespace = tool.options?.namespace
  if (namespace !== undefined) {
    const error = namespaceError(namespace)
    if (error) return error
  }
  const name = normalizedName(tool)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name))
    return new RegistrationError({ name, message: `Invalid tool name: ${name}` })
  const id = effectiveName(tool)
  if (ToolTraits.exposure(tool) === "direct" && ToolNames.canonical(id) === "Execute")
    return new RegistrationError({ name: id, message: 'Tool name "Execute" is reserved for CodeMode' })
  const result = Result.try({
    try: () => ToolDefinition.make(definition(tool)),
    catch: (error) =>
      new RegistrationError({ name: id, message: `Invalid tool definition ${id}: ${schemaMakeError(error)}` }),
  })
  if (Result.isFailure(result)) return result.failure
  const problem = ToolTraits.problem(tool.traits)
  if (problem !== undefined)
    return new RegistrationError({ name: id, message: `Invalid tool traits ${id}: ${problem}` })
  // Plugins are not bound by the types. A `validate` that is not a function would make every call of its tool die, so the
  // tool is refused here, with one log line, like any other invalid registration.
  if (tool.validate !== undefined && typeof tool.validate !== "function")
    return new RegistrationError({ name: id, message: `Invalid tool validate ${id}: validate must be a function` })
  return undefined
}

function namespaceError(name: string) {
  if (name.split(".").every((segment) => /^[A-Za-z0-9_-]{1,64}$/.test(segment))) return
  return new RegistrationError({ name, message: `Invalid tool namespace: ${JSON.stringify(name)}` })
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, Image.node, Permission.node],
})
