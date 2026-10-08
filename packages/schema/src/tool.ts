export * as Tool from "./tool.js"

import { Effect, JsonSchema, Schema } from "effect"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Agent } from "./agent.js"
import type { Session } from "./session.js"
import type { SessionMessage } from "./session-message.js"

export type Metadata = Readonly<Record<string, any>>

export const CallID = Schema.String.pipe(Schema.brand("Tool.CallID"))
export type CallID = typeof CallID.Type

export interface Context {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly id: CallID
  readonly progress: (update: Metadata) => Effect.Effect<void>
  /**
   * The traits of this call, resolved on the decoded input after the `execute.before` hooks have run. A Code Mode
   * inner call carries the traits of the tool it calls, not those of `execute`.
   */
  readonly traits: ResolvedTraits
}

export interface Namespace {
  readonly name: string
  readonly description: string
}

interface BaseOptions {
  readonly namespace?: string
  readonly permission?: string
}

/**
 * How a tool reaches the model. `codemode` and `pinned` are the whole representation of whether a tool is loaded or
 * deferred; there is no separate `defer` or `alwaysLoad` option. Core reads them in one place, `ToolTraits.exposure`
 * and `ToolTraits.pinned`, so a registration does not change when the way tools are offered does:
 *
 * - `codemode: false` loads the tool: the request advertises it directly, under its own name and schema.
 * - `codemode` left out or `true` defers it: the model finds it through Code Mode, in the catalog that `execute` lists
 *   and through `search`, and calls it from a program.
 * - `pinned: true` defers it the same way and also lists it in the inline catalog, whatever the catalog's budget leaves
 *   out. A tool that is loaded is already in front of the model, so `pinned` cannot be set with `codemode: false`.
 */
export type Options = BaseOptions &
  (
    | {
        readonly codemode?: true
        readonly pinned?: boolean
      }
    | {
        readonly codemode: boolean
        readonly pinned?: never
      }
  )

/**
 * A trait that is fixed for the tool or answered for each call. A function receives the input after the tool's schema
 * has decoded it, which is the value `execute` receives and not the raw input the model sent, and answers with a
 * boolean or an Effect of one. It can run more than once for a call, so it should be quick and have no side effects.
 */
export type Predicate<Input = unknown> = boolean | ((input: Input) => boolean | Effect.Effect<boolean, unknown>)

/** Whether a running call is ended (`cancel`) or left to finish (`block`) when the person sends a new message. */
export type InterruptBehavior = "cancel" | "block"

/**
 * What a tool declares about itself beyond its schemas. Every field is optional. The runtime resolves them for each
 * call and hands the answers to the tool and to whatever else consults them; what each consumer does with an answer
 * is up to that consumer.
 *
 * A tool that leaves a trait out gets its default: `readOnly`, `concurrencySafe`, `destructive`, `openWorld`,
 * `requiresUserInteraction` and `cancelSiblingsOnFailure` are `false`, `interruptBehavior` is `"block"`, and there is
 * no `maxResultChars`, `searchHint` or `displayName`.
 *
 * A call whose traits cannot be resolved takes conservative answers wherever its traits depend on the call:
 * `readOnly` and `concurrencySafe` are `false`, `destructive` is `true` and `interruptBehavior` is `"block"`. The
 * others do not depend on the call, so they stay as the tool declared them, and they are the defaults when no tool
 * stands behind the call. A call cannot be resolved when its tool is unknown or was not offered for the request, when a
 * predicate needs to read input that the schema rejects or fails to decode, and when a predicate fails, dies or answers
 * with anything but a boolean. A broken predicate can therefore only withhold what `readOnly` and `concurrencySafe`
 * would have allowed, and it never takes a declared `openWorld`, `requiresUserInteraction` or `cancelSiblingsOnFailure`
 * away.
 *
 * Among these traits only `readOnly` may relax a permission decision, and only when Orbit or plugin code declares it.
 * Values derived from MCP annotations never set it. `destructive` and `openWorld` are advisory: consumers may add
 * caution when one is true, and must never relax a decision because one is false. Request-level lifts that the
 * permission request itself carries (shell-safety's readOnly, fileEdit and sandboxed analysis) belong to permissions
 * and shell-safety, not to these traits.
 */
export interface Traits<Input = unknown> {
  /** The call only reads: it changes nothing outside the session. */
  readonly readOnly?: Predicate<Input>
  /** The call may run beside other calls of the same step. */
  readonly concurrencySafe?: Predicate<Input>
  /** The call can lose data or make changes that are hard to undo. */
  readonly destructive?: Predicate<Input>
  /** The call reaches beyond this machine and the project, such as the network. */
  readonly openWorld?: boolean
  /** The call waits for the person, so it cannot finish when nobody is there. */
  readonly requiresUserInteraction?: boolean
  /** A failure of this call should cancel the calls that run beside it in the same step. */
  readonly cancelSiblingsOnFailure?: boolean
  /** Whether a new user message ends the call or waits for it. Defaults to `"block"`. */
  readonly interruptBehavior?: InterruptBehavior
  /**
   * The length, in characters, above which a result of this tool should be written to a file rather than sent in
   * full. A positive number; `Infinity` means the result is never written to a file.
   */
  readonly maxResultChars?: number
  /**
   * A few words that help the model find the tool when it searches the catalog, for a purpose that its name and
   * description do not say. Code Mode's `search` matches them: a match counts for less than one in the tool's name and
   * for more than one in its description. `search` does not return them. Not empty.
   */
  readonly searchHint?: string
  /**
   * A name for people to read in place of the tool's own. Not empty. It can come from a server, so whoever prints or
   * stores it escapes control characters.
   */
  readonly displayName?: string
}

/** Traits with every predicate answered, as `Context.traits` carries them for one call. */
export interface ResolvedTraits {
  readonly readOnly: boolean
  readonly concurrencySafe: boolean
  readonly destructive: boolean
  readonly openWorld: boolean
  readonly requiresUserInteraction: boolean
  readonly cancelSiblingsOnFailure: boolean
  readonly interruptBehavior: InterruptBehavior
  readonly maxResultChars?: number
  readonly searchHint?: string
  readonly displayName?: string
}

export type ValueSchema<A = unknown> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema

type InputValue<S> = 0 extends 1 & S
  ? any
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<any, infer A>
      ? A
      : unknown
type OutputValue<S> = S extends undefined
  ? never
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<infer A, any>
      ? A
      : any

export class Error extends Schema.TaggedError<Error>()("Tool.Error", {
  message: Schema.String,
  /**
   * Names the failure so that a client or a hook can tell failures apart without reading the message. It becomes the
   * `type` of the `SessionError` that the call fails with and wins over the type of `error`. A failure without a code is
   * reported as `tool.execution`. Any string is accepted; `ErrorCode` lists the ones Orbit itself uses.
   */
  code: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

/**
 * The codes that Orbit gives its own tool failures. They are the `type` of the `SessionError` a failed call carries, so a
 * value here is a name that clients may match on and that stays as it is.
 */
export const ErrorCode = {
  /** The input does not match the tool's schema. */
  InputInvalid: "tool.input-invalid",
  /** The tool's `validate` refused the call without naming a code of its own. */
  Validation: "tool.validation",
  /** The model named a tool that does not exist. */
  Unknown: "tool.unknown",
  /** The tool exists but was not offered for this request. */
  Unavailable: "tool.unavailable",
  /** Tools are switched off for the rest of the run. */
  Disabled: "tool.disabled",
  /** The call was ended before it finished. Reserved: nothing reports it yet. */
  Cancelled: "tool.cancelled",
  /** The file does not exist. */
  FileNotFound: "file.not-found",
  /** The path is a directory, where a file is needed. */
  FileIsDirectory: "file.is-directory",
  /** The session has not read the file, so it may not change it. */
  FileUnread: "file.unread",
  /** The file changed since the session last read it. */
  FileStale: "file.stale",
  /** An edit that replaces a text with itself. */
  EditNoChange: "edit.no-change",
  /** An edit that looks for nothing. */
  EditEmptyOldString: "edit.empty-old-string",
  /** The text to replace is not in the file. */
  EditNoMatch: "edit.no-match",
  /** The text to replace is in the file more than once, and not every occurrence was asked for. */
  EditAmbiguous: "edit.ambiguous",
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface TextContent extends Schema.Schema.Type<typeof TextContent> {}
export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "Tool.TextContent" })

export interface FileContent extends Schema.Schema.Type<typeof FileContent> {}
export const FileContent = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "Tool.FileContent" })

export const Content = Schema.Union([TextContent, FileContent])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Tool.Content" })
export type Content = Schema.Schema.Type<typeof Content>

export interface Result<Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined> {
  readonly output?: OutputValue<Output>
  readonly content?: string | ReadonlyArray<Content>
  readonly metadata?: Metadata
}

export type Info<
  Input extends ValueSchema<any> = ValueSchema<any>,
  Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined,
> = {
  readonly name: string
  readonly input: Input
  readonly description: string
  readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>
  /**
   * Refuses a call that cannot succeed, before the tool asks anyone about it. It receives what `execute` receives, the
   * input after the schema has decoded it and the context with the traits of the call, and it runs after the
   * `execute.before` hooks and before `execute`, so before any permission request the tool makes. A call that fails here
   * never reaches those requests.
   *
   * It must not ask for permission, change anything or look at what the person has not approved, such as a file outside
   * the project. The state it checks can change before `execute` runs, so `execute` makes every check it relies on again.
   *
   * Fail with a `Tool.Error` that carries a `code`. A `Tool.Error` without one, and a failure that is not a
   * `Tool.Error`, is reported as `tool.validation`. A decline and an interrupt pass through as they do from `execute`.
   */
  readonly validate?: (input: InputValue<Input>, context: Context) => Effect.Effect<void, Error>
  readonly output?: Output
  readonly options?: Options
  /** Predicates in `traits` receive the input as `execute` does, after the schema has decoded it. */
  readonly traits?: Traits<InputValue<Input>>
}
