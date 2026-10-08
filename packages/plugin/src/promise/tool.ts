export { CallID, Error } from "@orbit/schema/tool"
export type { Metadata, Options, ResolvedTraits, Result } from "@orbit/schema/tool"

import { Tool } from "@orbit/schema/tool"
import type { Agent } from "@orbit/schema/agent"
import type { Session } from "@orbit/schema/session"
import type { SessionMessage } from "@orbit/schema/session-message"
import type { Types } from "effect"
import type { Hooks, Transform } from "./registration.js"

export interface ToolContext extends Omit<Tool.Context, "progress"> {
  readonly signal: AbortSignal
  readonly progress: (update: Tool.Metadata) => Promise<void>
}

/** A trait that is fixed for the tool or answered for each call, directly or with a Promise. */
export type Predicate<Input = unknown> = boolean | ((input: Input) => boolean | Promise<boolean>)

/**
 * What a tool declares about itself beyond its schemas. It is `Tool.Traits` with the three predicates answering with
 * a Promise instead of an Effect, and the rules are the same: the input is what the schema decoded, a predicate that
 * rejects, throws or answers with anything but a boolean makes the call take the conservative traits, and only
 * `readOnly` may relax a permission.
 */
export interface Traits<Input = unknown>
  extends Omit<Tool.Traits<Input>, "readOnly" | "concurrencySafe" | "destructive"> {
  readonly readOnly?: Predicate<Input>
  readonly concurrencySafe?: Predicate<Input>
  readonly destructive?: Predicate<Input>
}

export type Info<
  Input extends Tool.ValueSchema<any> = Tool.ValueSchema<any>,
  Output extends Tool.ValueSchema<any> | undefined = Tool.ValueSchema<any> | undefined,
> = Omit<Tool.Info<Input, Output>, "execute" | "traits"> & {
  readonly execute: (
    input: Parameters<Tool.Info<Input, Output>["execute"]>[0],
    context: ToolContext,
  ) => Promise<Tool.Result<Output>>
  readonly traits?: Traits<Parameters<Tool.Info<Input, Output>["execute"]>[0]>
}

export interface ToolEditor {
  list(): readonly (Info & { readonly id: string })[]
  get(id: string): (Info & { readonly id: string }) | undefined
  namespace(namespace: Tool.Namespace): void
  add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(
    tool: Info<Input, Output>,
  ): void
  /** Updates an existing tool; missing IDs are ignored. */
  update(id: string, update: (tool: Types.Mutable<Info>) => void): void
  remove(id: string): void
}

interface ToolHooks {
  readonly "execute.before": {
    tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    input: unknown
  }
  readonly "execute.after": {
    readonly tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    readonly input: unknown
  } & (
    | {
        readonly status: "completed"
        result: Tool.Result
      }
    | {
        readonly status: "error"
        error: Tool.Error
      }
  )
}

export interface ToolDomain {
  readonly transform: Transform<ToolEditor>
  readonly reload: () => Promise<void>
  /** Currently registered tools, after every transform, keyed by effective name. */
  readonly list: () => Promise<readonly (Info & { readonly id: string })[]>
  readonly hook: Hooks<ToolHooks>
}
