export * as ToolTraits from "./traits.js"

import type { Tool } from "@orbit/schema/tool"
import { Cause, Effect } from "effect"

/** The traits of a tool that declares none. */
export const defaults: Tool.ResolvedTraits = {
  readOnly: false,
  concurrencySafe: false,
  destructive: false,
  openWorld: false,
  requiresUserInteraction: false,
  cancelSiblingsOnFailure: false,
  interruptBehavior: "block",
}

/** The traits of a call that cannot be resolved: not read-only, not parallel, and destructive until shown otherwise. */
export const conservative: Tool.ResolvedTraits = { ...defaults, destructive: true }

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

/** Whether `resolve` needs the decoded input: a predicate is a function, or is something other than a boolean. */
export const dynamic = (tool: Tool.Info<any, any>) =>
  predicates.some((key) => {
    const predicate = tool.traits?.[key]
    return predicate !== undefined && typeof predicate !== "boolean"
  })

/**
 * Resolves the traits of one call, given the input after the tool's schema has decoded it. It never fails: a predicate
 * that fails, dies or answers with anything but a boolean is logged and the whole call takes the conservative record,
 * so a broken predicate withholds what `readOnly` and `concurrencySafe` would have granted and never grants more.
 * Interrupts are not caught.
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
      () => Effect.succeed({ ...conservative }),
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
  if (typeof traits !== "object" || traits === null) return "traits must be an object"
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

function fixedAnswer(tool: Tool.Info<any, any>, key: (typeof predicates)[number]) {
  const predicate = tool.traits?.[key]
  return typeof predicate === "boolean" ? predicate : defaults[key]
}

// One trait of one call. Anything but a boolean, directly or from an Effect, fails. The failure is logged here, where
// the trait is known, and then `resolve` replaces the whole record.
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
