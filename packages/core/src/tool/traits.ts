export * as ToolTraits from "./traits.js"

import type { Tool } from "@orbit/schema/tool"
import { Cause, Effect } from "effect"

/**
 * The traits of a tool that declares none. Frozen, because it is shared: one stray write would change what every later
 * call reads.
 */
export const defaults: Tool.ResolvedTraits = Object.freeze({
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  openWorld: false,
  requiresUserInteraction: false,
  cancelSiblingsOnFailure: false,
  interruptBehavior: "block",
})

// What a call takes when the answers that depend on it are in doubt, whatever its tool declares: not read-only, not
// parallel, destructive until shown otherwise, and left to finish.
const doubt = { readOnly: false, concurrencySafe: false, destructive: true, interruptBehavior: "block" } as const

/**
 * The traits of a call that no tool stands behind, such as a tool that is unknown or was not offered. Frozen, because
 * it is shared. A call of a known tool that cannot be resolved takes `conservativeFor`.
 */
export const conservative: Tool.ResolvedTraits = Object.freeze({ ...defaults, ...doubt })

/** The traits that are the same for every call of a tool. */
export type Static = Omit<Tool.ResolvedTraits, "readOnly" | "concurrencySafe" | "destructive">

const predicates = ["readOnly", "concurrencySafe", "destructive"] as const
const flags = ["openWorld", "requiresUserInteraction", "cancelSiblingsOnFailure"] as const
const texts = ["searchHint", "displayName"] as const

/** The traits that do not depend on the call, with the defaults filled in. Optional ones appear only when declared. */
export const describe = (tool: Tool.Info<any, any>): Static => {
  const traits = tool.traits
  return {
    openWorld: traits?.openWorld ?? defaults.openWorld,
    requiresUserInteraction: traits?.requiresUserInteraction ?? defaults.requiresUserInteraction,
    cancelSiblingsOnFailure: traits?.cancelSiblingsOnFailure ?? defaults.cancelSiblingsOnFailure,
    interruptBehavior: traits?.interruptBehavior ?? defaults.interruptBehavior,
    ...(traits?.maxResultChars === undefined ? {} : { maxResultChars: traits.maxResultChars }),
    ...(traits?.searchHint === undefined ? {} : { searchHint: traits.searchHint }),
    ...(traits?.displayName === undefined ? {} : { displayName: traits.displayName }),
  }
}

/**
 * The traits of a call of a known tool that cannot be resolved. What the tool declares about itself does not depend on
 * the call, so it holds: a broken predicate must not take a `cancelSiblingsOnFailure` or an `openWorld` away. The
 * answers that do depend on the call are the conservative ones.
 */
export const conservativeFor = (tool: Tool.Info<any, any>): Tool.ResolvedTraits => ({ ...describe(tool), ...doubt })

/** Whether `resolve` needs the decoded input: a predicate is a function, or is something other than a boolean. */
export const dynamic = (tool: Tool.Info<any, any>) =>
  predicates.some((key) => {
    const predicate = tool.traits?.[key]
    return predicate !== undefined && typeof predicate !== "boolean"
  })

/**
 * Resolves the traits of one call, given the input after the tool's schema has decoded it. It never fails: a predicate
 * that fails, dies or answers with anything but a boolean is logged and the whole call takes `conservativeFor` its
 * tool, so a broken predicate withholds what `readOnly` and `concurrencySafe` would have granted, never grants more and
 * never takes away a caution the tool declared. Interrupts are not caught.
 */
export const resolve = (tool: Tool.Info<any, any>, decoded: unknown): Effect.Effect<Tool.ResolvedTraits> => {
  const fixed = describe(tool)
  if (!dynamic(tool))
    return Effect.succeed({
      ...fixed,
      readOnly: fixedAnswer(tool, "readOnly"),
      concurrencySafe: fixedAnswer(tool, "concurrencySafe"),
      destructive: fixedAnswer(tool, "destructive"),
    })
  return Effect.gen(function* () {
    const readOnly = yield* ask(tool, "readOnly", decoded)
    const concurrencySafe = yield* ask(tool, "concurrencySafe", decoded)
    const destructive = yield* ask(tool, "destructive", decoded)
    return { ...fixed, readOnly, concurrencySafe, destructive }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => Effect.succeed(conservativeFor(tool)),
    ),
    // Only a cause that also holds an interrupt gets past the catch above, and the interrupt decides how it ends.
    Effect.orDie,
  )
}

/**
 * What is wrong with the traits a registration declares, if anything. Plugins are not bound by the types, and a value
 * of the wrong type would reach every consumer as if it were a trait.
 */
export const problem = (traits: Tool.Traits<any> | undefined) => {
  if (traits === undefined) return undefined
  // An array is an object to `typeof`, but its entries are not traits, and spreading one would invent some.
  if (typeof traits !== "object" || traits === null || Array.isArray(traits)) return "traits must be an object"
  const interrupt = traits.interruptBehavior
  const limit = traits.maxResultChars
  return [
    ...predicates.flatMap((key) =>
      ["undefined", "boolean", "function"].includes(typeof traits[key])
        ? []
        : [`${key} must be a boolean or a function`],
    ),
    ...flags.flatMap((key) =>
      ["undefined", "boolean"].includes(typeof traits[key]) ? [] : [`${key} must be a boolean`],
    ),
    ...(interrupt === undefined || interrupt === "cancel" || interrupt === "block"
      ? []
      : ['interruptBehavior must be "cancel" or "block"']),
    ...(limit === undefined || (typeof limit === "number" && limit > 0)
      ? []
      : ["maxResultChars must be a positive number"]),
    ...texts.flatMap((key) => {
      const text = traits[key]
      return text === undefined || (typeof text === "string" && text.trim() !== "")
        ? []
        : [`${key} must be a non-empty string`]
    }),
  ].at(0)
}

/**
 * How a tool reaches the model: a `direct` tool is advertised in the request, and a `deferred` one is found through
 * Code Mode.
 */
export type Exposure = "direct" | "deferred"

/**
 * How the model gets a tool, read from its `options`. This and `pinned` are where Core reads `Tool.Options.codemode` and
 * `Tool.Options.pinned`, so the way tools are offered can change here without touching a registration. Only a
 * `codemode` of exactly `false` loads a tool directly. A tool that leaves it out, sets `true` or sets anything else
 * that a plugin hands over is deferred, as it always was.
 */
export const exposure = (tool: Pick<Tool.Info, "options">): Exposure =>
  tool.options?.codemode === false ? "direct" : "deferred"

/**
 * Whether the inline catalog of Code Mode must list the tool, whatever its budget leaves out. A tool that is loaded
 * directly is already in front of the model, so only a deferred tool can be pinned.
 */
export const pinned = (tool: Pick<Tool.Info, "options">) =>
  exposure(tool) === "deferred" && tool.options?.pinned === true

function fixedAnswer(tool: Tool.Info<any, any>, key: (typeof predicates)[number]) {
  const predicate = tool.traits?.[key]
  return typeof predicate === "boolean" ? predicate : defaults[key]
}

// One trait of one call. Anything but a boolean, directly or from an Effect, fails. The failure is logged here, where
// the trait is known, and then `resolve` gives the whole call the conservative answers.
function ask(tool: Tool.Info<any, any>, key: (typeof predicates)[number], decoded: unknown) {
  return Effect.suspend(() => {
    const predicate = tool.traits?.[key]
    if (predicate === undefined || typeof predicate === "boolean") return Effect.succeed(fixedAnswer(tool, key))
    if (typeof predicate !== "function")
      return Effect.fail(new Error(`${key} must be a boolean or a function, not ${typeof predicate}`))
    const answer = predicate(decoded)
    return (Effect.isEffect(answer) ? answer : Effect.succeed(answer)).pipe(
      Effect.flatMap((value) =>
        typeof value === "boolean"
          ? Effect.succeed(value)
          : Effect.fail(new Error(`${key} must answer with a boolean, not ${typeof value}`)),
      ),
    )
  }).pipe(
    Effect.tapCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logError("Tool trait could not be resolved; the call takes the conservative traits", {
          tool: tool.name,
          trait: key,
          cause,
        }),
    ),
  )
}
