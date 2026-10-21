import { Agent } from "@orbit/core/agent"
import { CodeModeCatalog } from "@orbit/core/codemode/catalog"
import type { Permission } from "@orbit/core/permission"
import { SessionMessage } from "@orbit/core/session/message"
import { toSessionError } from "@orbit/core/session/to-session-error"
import type { SessionError } from "@orbit/schema/session-error"
import { Tool } from "@orbit/core/tool"
import { ToolAuthorization } from "@orbit/core/tool/authorization"
import { execute } from "@orbit/core/tool/runtime"
import { ToolTraits } from "@orbit/core/tool/traits"
import type { Context } from "@orbit/plugin/effect/plugin"
import { expect } from "bun:test"
import { Effect, type Scope } from "effect"
import { host } from "../plugin/host"

export const toolIdentity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_tool_test"),
}

export const toolDefinitions = (registry: Tool.Interface, permissions?: Permission.Ruleset) =>
  registry.snapshot(permissions).pipe(Effect.map((toolSet) => toolSet.definitions))

/**
 * A snapshot for fixtures that only need what a request advertises and how a call runs. Its calls resolve to the
 * conservative traits and no tool has static traits, which is what a snapshot of tools that declare none answers.
 */
export const stubSnapshot = (
  input: Pick<Tool.Snapshot, "definitions" | "execute"> & Partial<Pick<Tool.Snapshot, "codeModeCatalog">>,
): Tool.Snapshot => ({
  ...input,
  traits: () => Effect.succeed(ToolTraits.conservative),
  describe: () => undefined,
})

/**
 * Declared traits that registration must refuse, each with the reason it logs. Plugins are not bound by the types, so
 * this is what one can hand over: a single wrong field, and a `traits` that is not an object at all, falsy values
 * included. Every door that registers a tool runs the whole table.
 */
export const invalidTraits: ReadonlyArray<readonly [name: string, traits: unknown, problem: string]> = [
  ["a zero maxResultChars", { maxResultChars: 0 }, "maxResultChars must be a positive number"],
  ["a negative maxResultChars", { maxResultChars: -1 }, "maxResultChars must be a positive number"],
  ["a NaN maxResultChars", { maxResultChars: Number.NaN }, "maxResultChars must be a positive number"],
  ["a textual maxResultChars", { maxResultChars: "5" }, "maxResultChars must be a positive number"],
  ["an empty displayName", { displayName: "" }, "displayName must be a non-empty string"],
  ["a blank displayName", { displayName: "  \t" }, "displayName must be a non-empty string"],
  ["a displayName that is not text", { displayName: 5 }, "displayName must be a non-empty string"],
  ["an empty searchHint", { searchHint: "" }, "searchHint must be a non-empty string"],
  ["an unknown interruptBehavior", { interruptBehavior: "queue" }, 'interruptBehavior must be "cancel" or "block"'],
  ["a textual readOnly", { readOnly: "yes" }, "readOnly must be a boolean or a function"],
  ["a null concurrencySafe", { concurrencySafe: null }, "concurrencySafe must be a boolean or a function"],
  ["a numeric openWorld", { openWorld: 1 }, "openWorld must be a boolean"],
  [
    "a textual requiresUserInteraction",
    { requiresUserInteraction: "yes" },
    "requiresUserInteraction must be a boolean",
  ],
  [
    "a function cancelSiblingsOnFailure",
    { cancelSiblingsOnFailure: () => true },
    "cancelSiblingsOnFailure must be a boolean",
  ],
  ["traits that are text", "fast", "traits must be an object"],
  ["traits that are empty text", "", "traits must be an object"],
  ["traits that are null", null, "traits must be an object"],
  ["traits that are a number", 5, "traits must be an object"],
  ["traits that are zero", 0, "traits must be an object"],
  ["traits that are true", true, "traits must be an object"],
  ["traits that are false", false, "traits must be an object"],
  ["traits that are an empty array", [], "traits must be an object"],
  ["traits that are an array of traits", [{ readOnly: true }], "traits must be an object"],
  ["traits that are a function", () => ({ readOnly: true }), "traits must be an object"],
]

/**
 * Declared `validate` values that registration must refuse, each with the reason it logs. Plugins are not bound by the
 * types, and a check that is not a function would otherwise make every call of its tool die. Every door that registers
 * a tool runs the whole table.
 */
export const invalidValidates: ReadonlyArray<readonly [name: string, validate: unknown]> = [
  ["validate that is text", "yes"],
  ["validate that is empty text", ""],
  ["validate that is null", null],
  ["validate that is a number", 5],
  ["validate that is zero", 0],
  ["validate that is true", true],
  ["validate that is false", false],
  ["validate that is an object", { check: () => undefined }],
  ["validate that is an array of functions", [() => undefined]],
]

export const invalidValidateProblem = "validate must be a function"

export const codeModeListings = (catalog: CodeModeCatalog.Inventory) =>
  CodeModeCatalog.summarize(catalog, { budget: Infinity }).namespaces.flatMap((namespace) => namespace.entries)

export function waitForTool(registry: Tool.Interface, name: string, remaining = 1000): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if ((yield* toolDefinitions(registry)).some((tool) => tool.name === name)) return
    if (remaining === 0) {
      yield* Effect.fail(new Error(`Timed out waiting for tool: ${name}`))
      return
    }
    yield* Effect.promise(() => Bun.sleep(1))
    yield* waitForTool(registry, name, remaining - 1)
  })
}

export function waitForCodeModeTool(
  registry: Tool.Interface,
  path: string,
  remaining = 1000,
): Effect.Effect<Tool.Snapshot, Error> {
  return Effect.gen(function* () {
    const toolSet = yield* registry.snapshot()
    if (toolSet.codeModeCatalog && codeModeListings(toolSet.codeModeCatalog).some((tool) => tool.path === path))
      return toolSet
    if (remaining === 0) {
      return yield* Effect.fail(new Error(`Timed out waiting for Code Mode tool: ${path}`))
    }
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* waitForCodeModeTool(registry, path, remaining - 1)
  })
}

/**
 * Registers a core tool plugin's tools against the real registry without booting the
 * full plugin host. Only the tool domain is live; focused tool tests exercise
 * registration, snapshots, and execution through the same path production uses.
 */
export const registerToolPlugin = <R>(
  plugin: {
    readonly id: string
    readonly effect: (context: Context) => Effect.Effect<void, never, R>
  },
  overrides: Parameters<typeof host>[0] = {},
  hook?: Context["tool"]["hook"],
): Effect.Effect<void, never, R | Tool.Service | Scope.Scope> =>
  Effect.gen(function* () {
    const tools = yield* Tool.Service
    const context = host({
      ...overrides,
      session: {
        ...overrides.session,
        hook: overrides.session?.hook ?? (() => Effect.succeed({ dispose: Effect.void })),
      },
      tool: {
        transform: tools.transform,
        reload: tools.reload,
        list: tools.list,
        hook: hook ?? (() => Effect.die("registerToolPlugin does not support tool hooks")),
      },
    })
    yield* plugin.effect(context)
  })

export interface ToolExecution {
  readonly status: "completed" | "error"
  readonly output?: any
  readonly content?: ReadonlyArray<Tool.Content>
  readonly metadata?: Tool.Metadata
  readonly error?: SessionError.Error
}

/**
 * The traits `registry` resolves for a call of `name` with `input`, as scheduling and permissions read them. A tool that
 * is loaded directly is asked of the snapshot, as the runner does. A tool that Code Mode defers is not in the snapshot's
 * request, so its declaration is resolved the way an inner call resolves it, on `input` as given.
 */
export const toolTraits = (registry: Tool.Interface, name: string, input: unknown = {}) =>
  Effect.gen(function* () {
    const deferred = (yield* registry.list()).find(
      (tool) => tool.id === name && ToolTraits.exposure(tool) === "deferred",
    )
    if (deferred) return yield* ToolTraits.resolve(deferred, input)
    const tools = yield* registry.snapshot()
    return yield* tools.traits({ call: { type: "tool-call", id: "call_traits", name, input } })
  })

export const executeTool = (
  registry: Tool.Interface,
  input: Parameters<Tool.Snapshot["execute"]>[0],
): Effect.Effect<ToolExecution> =>
  registry.snapshot().pipe(
    Effect.flatMap((tools) => tools.execute(input)),
    Effect.map((result) => ({ status: "completed" as const, ...result }) satisfies ToolExecution),
    Effect.catchTag("Tool.Error", (error) =>
      Effect.succeed({ status: "error" as const, error: toSessionError(error) } satisfies ToolExecution),
    ),
  )

/** `execute` from the runtime with a gate that lets every call through, for suites that test the runtime and not the gate. */
export const runTool = (tool: Parameters<typeof execute>[0], input: unknown, context: Parameters<typeof execute>[2]) =>
  execute(tool, input, context, () => Effect.void)

/** The fields of a tool that a plugin can make unreadable. */
export const unreadableFields = ["name", "description", "traits", "options", "execute", "validate"] as const

/** A copy of `tool` whose `field` throws when it is read, as a plugin's getter can. */
export const withThrowingField = <T extends object>(tool: T, field: (typeof unreadableFields)[number]): T =>
  Object.defineProperty({ ...tool }, field, {
    enumerable: true,
    get: () => {
      throw new Error("boom")
    },
  })

/**
 * The registry asks about calls of these tools: none of them claims to ask for itself, so none escapes the rules. The
 * gate itself is tested in tool-gate.test.ts; this pins that a built-in does not opt out of it.
 */
export const expectRegistryAsks = (registry: Tool.Interface, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const listed = yield* registry.list()
    for (const id of ids) {
      const tool = listed.find((item) => item.id === id)
      expect(tool).toBeDefined()
      expect(yield* ToolAuthorization.authorizesItself(tool!, {})).toBe(false)
    }
  })
