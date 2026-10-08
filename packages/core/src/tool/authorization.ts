export * as ToolAuthorization from "./authorization.js"

import type { Tool } from "@orbit/schema/tool"
import { Cause, Effect } from "effect"

/**
 * Whether a tool asks about a call itself, given the input after its schema has decoded it. Only `true` says so. It never
 * fails: a missing declaration, a predicate that fails, dies or answers with anything but a boolean, and a value of any
 * other type are all `false`, so the registry asks. A broken declaration is logged. Interrupts are not caught.
 */
export const authorizesItself = (tool: Tool.Info<any, any>, decoded: unknown): Effect.Effect<boolean> => {
  const declared: unknown = tool.options?.authorizes
  if (declared === undefined) return Effect.succeed(false)
  if (declared === true) return Effect.succeed(true)
  if (declared === false) return Effect.succeed(false)
  return Effect.suspend(() => {
    if (typeof declared !== "function")
      return Effect.fail(new Error(`authorizes must be a boolean or a function, not ${typeof declared}`))
    const answer: unknown = declared(decoded)
    // Plugins are not bound by the types, so an Effect may carry requirements nobody provides; it fails like any other
    // broken declaration.
    return (Effect.isEffect(answer) ? (answer as Effect.Effect<unknown>) : Effect.succeed(answer)).pipe(
      Effect.flatMap((value) =>
        typeof value === "boolean"
          ? Effect.succeed(value)
          : Effect.fail(new Error(`authorizes must answer with a boolean, not ${typeof value}`)),
      ),
    )
  }).pipe(
    Effect.tapCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logError("Tool authorizes could not be resolved; the registry asks about the call", {
          tool: tool.name,
          cause,
        }),
    ),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => Effect.succeed(false),
    ),
    // Only a cause that also holds an interrupt gets past the catch above, and the interrupt decides how it ends.
    Effect.orDie,
  )
}
