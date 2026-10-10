import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk"
import type {
  EventSubscribeOutput,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionStructuredError,
  TokenUsageInfo,
} from "@orbit/client/promise"
import { Event } from "@orbit/schema/event"
import { PermissionView } from "@orbit/schema/permission-view"
import { SessionMessage } from "@orbit/schema/session-message"
import { ToolNames } from "@orbit/schema/tool-names"
import { TokenUsage } from "@orbit/schema/token-usage"
import { partsToContentChunks, type ReplayPart } from "./content"
import { ACPError } from "./error"
import { completedToolUpdate, errorToolUpdate, pendingToolCall, runningToolUpdate, type ToolInput } from "./tool"

export const ChildSessionUpdatesCapability = "orbit/child-session-updates"
export const ChildSessionUpdateMethod = "orbit/session/child_update"
const RetryMeta = "orbit/retry"
const CompactionMeta = "orbit/compaction"
const NoticeMeta = "orbit/notice"

export type TurnStart = { readonly type: "input" | "compaction"; readonly id: string }

export type Terminal = "succeeded" | "failed" | "interrupted"

export type Context = {
  readonly sessionID: string
  readonly cwd: string
  readonly start: TurnStart
  readonly childUpdates: boolean
  /** A background consumer follows open children after the parent turn ends; it never writes `session/update`. */
  readonly mode: "turn" | "background"
}

type Tool = {
  readonly sessionID: string
  readonly id: string
  readonly name: string
  readonly input: ToolInput
  readonly metadata: Record<string, unknown>
  /** The places the server named on this call's permission request: where the tool acts. */
  readonly places?: ReadonlyArray<string>
}

type RetryStatus = {
  readonly attempt: number
  readonly nextRetryAt: string
  readonly error: SessionStructuredError
}

export type ChildSession = {
  readonly id: string
  readonly parentID: string
  readonly depth: number
  readonly title?: string
}

type ChildSessionEvent =
  | { readonly type: "update"; readonly update: SessionUpdate }
  | {
      readonly type: "status"
      readonly status: "created" | "running" | "completed" | "failed" | "interrupted"
      readonly error?: { readonly type: string; readonly message: string }
    }

export type ChildSessionUpdate = {
  readonly rootSessionId: string
  readonly childSessionId: string
  readonly parentSessionId: string
  readonly depth: number
  readonly title?: string
} & ChildSessionEvent

export type TurnState = {
  readonly started: boolean
  readonly tools: ReadonlyMap<string, Tool>
  readonly retries: ReadonlyMap<string, RetryStatus>
  readonly compactions: ReadonlyMap<string, string>
  readonly children: ReadonlyMap<string, ChildSession>
  readonly openChildren: ReadonlySet<string>
  /** Forms asked of the client that the server has not yet answered or cancelled. */
  readonly forms: ReadonlySet<string>
  readonly finish?: SessionMessageAssistant["finish"]
  readonly usage?: { readonly turn: TokenUsageInfo; readonly last: TokenUsageInfo }
  readonly stepError?: SessionStructuredError
  readonly executionError?: { readonly type: string; readonly message: string }
}

type PermissionEvent = Extract<EventSubscribeOutput, { type: "permission.asked" }>
type FormEvent = Extract<EventSubscribeOutput, { type: "form.created" }>

export type Output =
  | { readonly _tag: "SessionUpdate"; readonly update: SessionUpdate }
  | { readonly _tag: "ChildUpdate"; readonly update: ChildSessionUpdate }
  | {
      readonly _tag: "PermissionAsk"
      readonly event: PermissionEvent
      readonly tool?: Tool
      readonly child?: ChildSession
    }
  | {
      readonly _tag: "FormAsk"
      readonly form: FormEvent["data"]["form"]
      readonly child?: ChildSession
      /** Whether the form's session sends its tool calls to the client as `session/update` tool calls. */
      readonly toolCallSent: boolean
    }
  | { readonly _tag: "FormSettled"; readonly formID: string }

export type Step = {
  readonly state: TurnState
  readonly outputs: ReadonlyArray<Output>
  readonly terminal?: Terminal
}

type CompactionEvent = Extract<
  EventSubscribeOutput,
  { readonly type: "session.compaction.started" | "session.compaction.ended" | "session.compaction.failed" }
>

type CompactionMarker = {
  readonly status: "started" | "completed" | "failed"
  readonly messageId: string
  readonly reason: "auto" | "manual"
  readonly error?: SessionStructuredError
}

export const initial: TurnState = {
  started: false,
  tools: new Map(),
  retries: new Map(),
  compactions: new Map(),
  children: new Map(),
  openChildren: new Set(),
  forms: new Set(),
}

export function step(state: TurnState, event: EventSubscribeOutput, ctx: Context): Step {
  if (event.type === "session.created") {
    const parentID = event.data.parentID
    if (!parentID) return { state, outputs: [] }
    const parent = parentID === ctx.sessionID ? undefined : state.children.get(parentID)
    if (!parent && (ctx.mode === "background" || parentID !== ctx.sessionID)) return { state, outputs: [] }
    const child = { id: event.data.sessionID, parentID, depth: parent ? parent.depth + 1 : 1, title: event.data.title }
    return {
      state: {
        ...state,
        children: new Map(state.children).set(child.id, child),
        openChildren: new Set(state.openChildren).add(child.id),
      },
      outputs: childStatus(ctx, child, { type: "status", status: "created" }),
    }
  }

  const eventSessionID = sessionIDFromEvent(event)
  const child = eventSessionID ? state.children.get(eventSessionID) : undefined
  if (ctx.mode === "background" && !child) return { state, outputs: [] }
  const send = (update: SessionUpdate) => route(ctx, child, update)

  if (event.type === "permission.asked" && (event.data.sessionID === ctx.sessionID || child)) {
    const tool = event.data.source?.id
      ? state.tools.get(toolKey(event.data.sessionID, event.data.source.id))
      : undefined
    // The places the server resolved are where the tool acts: the call's later updates name them, not the input's spelling.
    const view = PermissionView.of(event.data)
    const served = view.places.length > 0 ? view.places : view.folder ? [view.folder] : undefined
    // A Patch asks as an Edit, for every file it changes.
    const next =
      tool && served && (ToolNames.owns(event.data.action, tool.name) || PermissionView.action(tool.name) === "patch")
        ? new Map(state.tools).set(toolKey(tool.sessionID, tool.id), { ...tool, places: served })
        : state.tools
    return { state: { ...state, tools: next }, outputs: [{ _tag: "PermissionAsk", event, tool, child }] }
  }
  if (event.type === "form.created" && (event.data.form.sessionID === ctx.sessionID || child)) {
    return {
      state: { ...state, forms: new Set(state.forms).add(event.data.form.id) },
      outputs: [
        {
          _tag: "FormAsk",
          form: event.data.form,
          child,
          toolCallSent: ctx.mode === "turn" && (!child || !ctx.childUpdates),
        },
      ],
    }
  }
  if ((event.type === "form.replied" || event.type === "form.cancelled") && state.forms.has(event.data.id)) {
    const forms = new Set(state.forms)
    forms.delete(event.data.id)
    return { state: { ...state, forms }, outputs: [{ _tag: "FormSettled", formID: event.data.id }] }
  }
  if (!eventSessionID || (eventSessionID !== ctx.sessionID && !child)) return { state, outputs: [] }
  if (matchesStart(event, ctx.start)) return { state: { ...state, started: true }, outputs: [] }
  if (!state.started) return { state, outputs: [] }

  switch (event.type) {
    case "session.execution.started":
      return { state, outputs: child ? childStatus(ctx, child, { type: "status", status: "running" }) : [] }
    case "session.step.started": {
      const next = child ? state : { ...state, stepError: undefined }
      if (!state.retries.has(eventSessionID)) return { state: next, outputs: [] }
      return {
        state: { ...next, retries: without(state.retries, eventSessionID) },
        outputs: send({ sessionUpdate: "session_info_update", _meta: { [RetryMeta]: null } }),
      }
    }
    case "session.retry.scheduled": {
      const retry = {
        attempt: event.data.attempt,
        nextRetryAt: new Date(event.data.at).toISOString(),
        error: event.data.error,
      }
      return {
        state: { ...state, retries: new Map(state.retries).set(eventSessionID, retry) },
        outputs: send({ sessionUpdate: "session_info_update", _meta: { [RetryMeta]: retry } }),
      }
    }
    case "session.synthetic": {
      // Any synthetic message that names a notice is shown to the person; the rest are reminders for the model only.
      const notice = event.data.metadata?.notice
      if (child || typeof notice !== "string") return { state, outputs: [] }
      const replaces = event.data.metadata?.replaces
      return {
        state,
        outputs: send({
          sessionUpdate: "session_info_update",
          _meta: {
            [NoticeMeta]: {
              notice,
              ...(event.data.description === undefined ? {} : { description: event.data.description }),
              ...(typeof replaces === "string" ? { replaces } : {}),
            },
          },
        }),
      }
    }
    case "session.compaction.started":
    case "session.compaction.ended":
    case "session.compaction.failed": {
      const compacted = compactionMarker(event, state.compactions)
      return {
        state: { ...state, compactions: compacted.compactions },
        outputs: compacted.marker ? send(compactionUpdate(compacted.marker)) : [],
      }
    }
    case "session.text.delta":
      return {
        state,
        outputs: send({
          sessionUpdate: "agent_message_chunk",
          messageId: event.data.assistantMessageID,
          content: { type: "text", text: event.data.delta },
        }),
      }
    case "session.reasoning.delta":
      return {
        state,
        outputs: send({
          sessionUpdate: "agent_thought_chunk",
          messageId: `${event.data.assistantMessageID}:reasoning:${event.data.ordinal}`,
          content: { type: "text", text: event.data.delta },
        }),
      }
    case "session.tool.input.started":
      return {
        state: {
          ...state,
          tools: new Map(state.tools).set(
            toolKey(event.data.sessionID, event.data.id),
            newTool(event.data.sessionID, event.data.id, event.data.name),
          ),
        },
        outputs: send({
          sessionUpdate: "tool_call",
          ...pendingToolCall({
            toolCallId: event.data.id,
            toolName: event.data.name,
            state: { input: {} },
            cwd: ctx.cwd,
          }),
        }),
      }
    case "session.tool.called": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const tool = {
        ...(state.tools.get(key) ?? newTool(event.data.sessionID, event.data.id)),
        input: event.data.input,
      }
      return {
        state: { ...state, tools: new Map(state.tools).set(key, tool) },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...runningToolUpdate({
            toolCallId: event.data.id,
            toolName: tool.name,
            state: { input: tool.input },
            cwd: ctx.cwd,
            // The tools report the places they resolved as their first act, so until they do no place is named: the
            // input's spelling of a path can be a link that the tool leads somewhere else.
            places: tool.places ?? [],
          }),
        }),
      }
    }
    case "session.tool.progress": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const current = state.tools.get(key)
      if (!current) return { state, outputs: [] }
      // The tool reports the places it resolved before it asks or acts, so they are known even when no rule asks about
      // the call (the permission request carries them only when it is asked).
      const reported = event.data.metadata?.places
      const places =
        Array.isArray(reported) && reported.length > 0 && reported.every((item) => typeof item === "string")
          ? (reported as string[])
          : current.places
      return {
        state: {
          ...state,
          tools: new Map(state.tools).set(key, { ...current, metadata: event.data.metadata, places }),
        },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...runningToolUpdate({
            toolCallId: event.data.id,
            toolName: current.name,
            state: { input: current.input },
            cwd: ctx.cwd,
            places,
          }),
        }),
      }
    }
    case "session.tool.success": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const tool = state.tools.get(key) ?? newTool(event.data.sessionID, event.data.id)
      return {
        state: { ...state, tools: without(state.tools, key) },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...completedToolUpdate({
            toolCallId: event.data.id,
            toolName: tool.name,
            input: tool.input,
            metadata: event.data.metadata,
            content: event.data.content,
            cwd: ctx.cwd,
            places: tool.places,
          }),
        }),
      }
    }
    case "session.tool.failed": {
      const key = toolKey(event.data.sessionID, event.data.id)
      const tool = state.tools.get(key) ?? newTool(event.data.sessionID, event.data.id)
      return {
        state: { ...state, tools: without(state.tools, key) },
        outputs: send({
          sessionUpdate: "tool_call_update",
          ...errorToolUpdate({
            toolCallId: event.data.id,
            toolName: tool.name,
            input: tool.input,
            metadata: event.data.metadata ?? tool.metadata,
            content: event.data.content ?? [],
            error: event.data.error.message,
            cwd: ctx.cwd,
            places: tool.places,
          }),
        }),
      }
    }
    case "session.step.ended":
      if (child) return { state, outputs: [] }
      return { state: { ...recordStep(state, event.data.tokens), finish: event.data.finish }, outputs: [] }
    case "session.step.failed": {
      if (child) return { state, outputs: [] }
      const recorded = event.data.tokens ? recordStep(state, event.data.tokens) : state
      return { state: { ...recorded, stepError: event.data.error }, outputs: [] }
    }
    case "session.execution.succeeded":
      if (!child) return { state, outputs: [], terminal: "succeeded" }
      return childEnded(state, ctx, child, { type: "status", status: "completed" }, "succeeded")
    case "session.execution.interrupted":
      if (!child) return { state, outputs: [], terminal: "interrupted" }
      return childEnded(state, ctx, child, { type: "status", status: "interrupted" }, "interrupted")
    case "session.execution.failed":
      if (!child) return { state: { ...state, executionError: event.data.error }, outputs: [], terminal: "failed" }
      return childEnded(state, ctx, child, { type: "status", status: "failed", error: event.data.error }, "failed")
    default:
      return { state, outputs: [] }
  }
}

/** The ACP failure a settled turn reports instead of a response, if any. */
export function failure(state: TurnState) {
  // A turn that reached its limit ends normally with a stop reason of its own, so it is not a service failure.
  if (limited(state)) return undefined
  const error = state.stepError ?? state.executionError
  if (error?.type === "provider.auth") return new ACPError.AuthRequiredError()
  if (error && error.type !== "aborted" && error.type !== "provider.content-filter") {
    return new ACPError.ServiceFailureError({
      safeMessage: error.message || "Orbit prompt failed",
      service: "session",
      errorName: error.type,
    })
  }
  return undefined
}

function limited(state: TurnState) {
  // A cost limit that cannot be checked (`limit.cost-unknown`) is a refusal, not a limit that was reached.
  const type = state.executionError?.type
  return type === "limit.steps" || type === "limit.cost" || type === "limit.tokens"
}

export function response(state: TurnState, sessionID: string, terminal: Terminal): PromptResponse {
  const tokens = state.usage?.turn
  const usage = tokens
    ? {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        totalTokens: TokenUsage.total(tokens),
        ...(tokens.reasoning > 0 ? { thoughtTokens: tokens.reasoning } : {}),
        ...(tokens.cache.read > 0 ? { cachedReadTokens: tokens.cache.read } : {}),
        ...(tokens.cache.write > 0 ? { cachedWriteTokens: tokens.cache.write } : {}),
      }
    : undefined
  const error = (state.stepError ?? state.executionError)?.type
  const stopReason = resolveStopReason({ terminal, finish: state.finish, error, limited: limited(state) })
  // Only an interrupt during backoff leaves a retry pending. Interruption clears the projected retry, so report it here.
  const retry = state.retries.get(sessionID)
  return { stopReason, ...(usage ? { usage } : {}), _meta: retry ? { [RetryMeta]: retry } : {} }
}

/** Fails the tools a cancelled turn left open, for when the server's wind-down never reports them. */
export function abandonTools(state: TurnState, ctx: Context): Step {
  return {
    state: { ...state, tools: new Map() },
    outputs: [...state.tools.values()].flatMap((tool) =>
      route(ctx, state.children.get(tool.sessionID), {
        sessionUpdate: "tool_call_update",
        ...errorToolUpdate({
          toolCallId: tool.id,
          toolName: tool.name,
          input: tool.input,
          metadata: tool.metadata,
          content: [],
          error: "Cancelled",
          cwd: ctx.cwd,
          places: tool.places,
        }),
      }),
    ),
  }
}

/** Lazy, so a message that fails to translate part way still replays the updates before the failure. */
export function* replayMessage(message: SessionMessageInfo, cwd: string): Generator<SessionUpdate> {
  if (message.type === "user") {
    yield { sessionUpdate: "user_message_chunk", messageId: message.id, content: { type: "text", text: message.text } }
    const files: ReplayPart[] = (message.files ?? []).map((file) => ({
      type: "file",
      url: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
      filename: file.name,
      mime: file.mime,
    }))
    for (const chunk of partsToContentChunks(files))
      yield { sessionUpdate: "user_message_chunk", messageId: message.id, ...chunk }
    return
  }
  // A running compaction has no live turn on this connection to settle it, so replay only settled ones.
  if (message.type === "compaction" && message.status !== "running") {
    yield compactionUpdate({
      status: message.status,
      messageId: message.id,
      reason: message.reason,
      ...(message.status === "failed" ? { error: message.error } : {}),
    })
    return
  }
  if (message.type !== "assistant") return
  // Live reasoning ordinals count only reasoning parts, not the mixed content array.
  let reasoningOrdinal = 0
  for (const part of message.content) {
    if (part.type === "text") {
      yield { sessionUpdate: "agent_message_chunk", messageId: message.id, content: { type: "text", text: part.text } }
      continue
    }
    if (part.type === "reasoning") {
      yield {
        sessionUpdate: "agent_thought_chunk",
        messageId: `${message.id}:reasoning:${reasoningOrdinal++}`,
        content: { type: "text", text: part.text },
      }
      continue
    }
    // As live, the pending call carries no input and names no place. The updates name the places the tool recorded
    // when it resolved them, and none when it recorded none: the input's spelling of a path can be a link that leads
    // somewhere else.
    yield {
      sessionUpdate: "tool_call",
      ...pendingToolCall({ toolCallId: part.id, toolName: part.name, state: { input: {} }, cwd }),
    }
    const places = part.state.status === "streaming" ? [] : recordedPlaces(part.state.metadata)
    switch (part.state.status) {
      case "completed":
        yield {
          sessionUpdate: "tool_call_update",
          ...completedToolUpdate({
            toolCallId: part.id,
            toolName: part.name,
            input: part.state.input,
            metadata: part.state.metadata,
            content: part.state.content,
            cwd,
            places,
          }),
        }
        break
      case "running":
        yield {
          sessionUpdate: "tool_call_update",
          ...runningToolUpdate({ toolCallId: part.id, toolName: part.name, state: { input: part.state.input }, cwd, places }),
        }
        break
      case "error":
        yield {
          sessionUpdate: "tool_call_update",
          ...errorToolUpdate({
            toolCallId: part.id,
            toolName: part.name,
            input: part.state.input,
            metadata: part.state.metadata,
            content: part.state.content,
            error: part.state.error.message,
            cwd,
            places,
          }),
        }
        break
      case "streaming":
        break
    }
  }
}

function recordedPlaces(metadata: Readonly<Record<string, unknown>> | undefined) {
  const recorded = metadata?.places
  return Array.isArray(recorded) && recorded.every((item) => typeof item === "string") ? (recorded as string[]) : []
}

function newTool(sessionID: string, id: string, name = "tool"): Tool {
  return { sessionID, id, name, input: {}, metadata: {} }
}

function route(ctx: Context, child: ChildSession | undefined, update: SessionUpdate): Output[] {
  if (!child) return ctx.mode === "turn" ? [{ _tag: "SessionUpdate", update }] : []
  const projected = projectChildUpdate(update, child)
  if (ctx.childUpdates) return childStatus(ctx, child, { type: "update", update: projected })
  return ctx.mode === "turn" ? [{ _tag: "SessionUpdate", update: projected }] : []
}

function childStatus(ctx: Context, child: ChildSession, value: ChildSessionEvent): Output[] {
  if (!ctx.childUpdates) return []
  return [
    {
      _tag: "ChildUpdate",
      update: {
        rootSessionId: ctx.sessionID,
        childSessionId: child.id,
        parentSessionId: child.parentID,
        depth: child.depth,
        ...(child.title ? { title: child.title } : {}),
        ...value,
      },
    },
  ]
}

// A background consumer ends once its last open child settles.
function childEnded(
  state: TurnState,
  ctx: Context,
  child: ChildSession,
  status: ChildSessionEvent,
  terminal: Terminal,
): Step {
  const openChildren = new Set(state.openChildren)
  openChildren.delete(child.id)
  return {
    state: { ...state, openChildren },
    outputs: childStatus(ctx, child, status),
    ...(ctx.mode === "background" && openChildren.size === 0 ? { terminal } : {}),
  }
}

function recordStep(state: TurnState, tokens: TokenUsageInfo): TurnState {
  const turn = state.usage?.turn
  return {
    ...state,
    usage: {
      turn: turn
        ? {
            input: turn.input + tokens.input,
            output: turn.output + tokens.output,
            reasoning: turn.reasoning + tokens.reasoning,
            cache: { read: turn.cache.read + tokens.cache.read, write: turn.cache.write + tokens.cache.write },
          }
        : tokens,
      last: tokens,
    },
  }
}

function without<K, V>(map: ReadonlyMap<K, V>, key: K) {
  const next = new Map(map)
  next.delete(key)
  return next
}

function sessionIDFromEvent(event: EventSubscribeOutput) {
  if ("sessionID" in event.data && typeof event.data.sessionID === "string") return event.data.sessionID
  if (event.type === "form.created") return event.data.form.sessionID
  return undefined
}

function toolKey(sessionID: string, id: string) {
  return `${sessionID}:${id}`
}

// Message IDs follow core's compaction message projection, so live markers match replayed ones.
function compactionMarker(event: CompactionEvent, compactions: ReadonlyMap<string, string>) {
  const sessionID = event.data.sessionID
  if (event.type === "session.compaction.started") {
    const messageId = event.data.inputID ?? SessionMessage.ID.fromEvent(Event.ID.make(event.id))
    const marker: CompactionMarker = { status: "started", messageId, reason: event.data.reason }
    return { marker, compactions: new Map(compactions).set(sessionID, messageId) }
  }
  const tracked = compactions.get(sessionID)
  const remaining = without(compactions, sessionID)
  if (event.type === "session.compaction.ended") {
    const marker: CompactionMarker | undefined = tracked
      ? { status: "completed", messageId: tracked, reason: event.data.reason }
      : undefined
    return { marker, compactions: remaining }
  }
  // Automatic compaction can fail before it starts, for example when there is nothing to compact yet.
  const marker: CompactionMarker = {
    status: "failed",
    messageId: tracked ?? event.data.inputID ?? SessionMessage.ID.fromEvent(Event.ID.make(event.id)),
    reason: event.data.reason,
    error: event.data.error,
  }
  return { marker, compactions: remaining }
}

function compactionUpdate(marker: CompactionMarker): SessionUpdate {
  return { sessionUpdate: "session_info_update", _meta: { [CompactionMeta]: marker } }
}

function projectChildUpdate(update: SessionUpdate, child: ChildSession) {
  const projected = { ...update }
  projected._meta = {
    ...projected._meta,
    "orbit/child-session": {
      id: child.id,
      parentID: child.parentID,
      depth: child.depth,
      ...(child.title ? { title: child.title } : {}),
    },
  }
  if (projected.sessionUpdate === "tool_call" || projected.sessionUpdate === "tool_call_update") {
    projected.toolCallId = `${child.id}:${projected.toolCallId}`
    if (projected.title && child.title) projected.title = `${child.title}: ${projected.title}`
  }
  return projected
}

function matchesStart(event: EventSubscribeOutput, start: TurnStart) {
  return event.type === "session.inbox.delivered" && event.data.inboxID === start.id
}

function resolveStopReason(input: {
  readonly terminal: Terminal
  readonly finish: SessionMessageAssistant["finish"]
  readonly error?: string
  readonly limited?: boolean
}): PromptResponse["stopReason"] {
  if (input.terminal === "interrupted" || input.error === "aborted") return "cancelled"
  if (input.limited) return "max_turn_requests"
  if (input.finish === "length") return "max_tokens"
  if (input.finish === "content-filter" || input.error === "provider.content-filter") return "refusal"
  return "end_turn"
}

export * as ACPTranslate from "./translate"
