export * as ToolCurrentCall from "./current-call.js"

import { Context } from "effect"

export type Call = {
  /** The name the model used, which is the registry name of the tool. */
  readonly tool: string
  /** The input as the registry received it, before the tool's schema decoded it. */
  readonly input: unknown
}

/**
 * The tool call that is executing in this fiber, set by the registry around the gate and `execute`. A permission
 * request made while a call runs stores it as `Pending.call`, so whoever decides or explains the request can see which
 * call asked. A Code Mode inner call replaces the program's call for its own duration. Outside a tool call it is
 * `undefined`.
 */
export const Current = Context.Reference<Call | undefined>("@orbit/Tool/CurrentCall", {
  defaultValue: () => undefined,
})
