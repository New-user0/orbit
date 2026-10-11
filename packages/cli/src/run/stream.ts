import type {
  EventSubscribeOutput,
  LocationRef,
  OrbitClient,
  JsonValue,
  ToolContent,
  SessionMessageInfo,
  SessionStructuredError,
  SessionTurnOptions,
} from "@orbit/client/promise"
import { jsonLine, progress } from "@orbit/flow/plain"
import { SessionMessage } from "@orbit/schema/session-message"
import { Option, Result } from "effect"
import { toolOutputText, type MiniToolPart } from "@orbit/tui/mini/tool"
import { parseSessionTargetModel } from "../session-target"
import { errorMessage } from "../util/error"
import {
  GLOBAL_FORM_SESSION_ID,
  contentKey,
  countedFinishes,
  decodeEscalation,
  decodeNotice,
  echoes,
  envelopeResultLine,
  formAlreadySettled,
  formRequestOptions,
  markResultWritten,
  partID,
  prepareFile,
  sameLocation,
  schemaInstruction,
  subtype,
  toMillis,
  toolKey,
  type File,
} from "./format"
import { decodeInput, lineReader, PROTOCOL_VERSION, type Input } from "./protocol"
import { UI } from "./ui"

// The bidirectional headless protocol of `orb -p --input-format stream-json` and `orb run --input-format stream-json`:
// a program writes one JSON input per line on stdin while this process writes one JSON line per event on stdout. The
// driver only admits input and relays asks; the server's inbox decides delivery, steering and interruption, and the
// controller decides every approval (except under --auto).

type V2Event = EventSubscribeOutput
type FormRequest = Extract<V2Event, { type: "form.created" }>["data"]["form"]
type PermissionRequest = Extract<V2Event, { type: "permission.asked" }>["data"]

export type StreamInput = {
  client: OrbitClient
  sessionID: string
  location: LocationRef
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  thinking: boolean
  /** A line for every text, reasoning and tool input fragment as it streams. */
  partial?: boolean
  /** A JSON Schema the answer of every admitted message must follow. */
  jsonSchema?: unknown
  /** Limits and a fallback model for every admitted message; the cost limit is shared by the whole process. */
  turn?: SessionTurnOptions
  /** Approve every ask once, without showing it to the controller. */
  auto: boolean
  /** True when the client is attached to a shared server rather than an exclusive in-process one. */
  attached: boolean
  envelope: { cwd: string; agent?: string; model?: string; version: string }
  /** The positional prompt, admitted as the first message. */
  first?: { message: string; files: File[] }
  /** The standard input to read; absent when it is a terminal, so that only `first` runs. */
  stdin?: AsyncIterable<Uint8Array>
  /** Turns a path or a data URL from a `user` line into an attachment, with the rules of `--file`. */
  resolveFile: (value: string) => Promise<File>
  /** Where lines go; standard output unless a test collects them. */
  write?: (line: string) => void
  /** Reconnection timing; the defaults are the documented ones. */
  reconnect?: { baseMs?: number; capMs?: number; giveUpMs?: number }
}

const DEFAULT_RECONNECT = { baseMs: 1_000, capMs: 30_000, giveUpMs: 10 * 60_000 }

const EOF_PERMISSION_FEEDBACK =
  "The program driving this run closed its input, so nobody can approve this request. Continue without this action."

const EOF_QUESTION_FEEDBACK =
  "The program driving this run closed its input, so nobody can answer this question. Continue without an answer; make reasonable assumptions and state them."

type Pending = { kind: "permission" | "form"; sessionID: string; action?: string; resources?: string[] }

type Period = {
  /** The first message the period ran, which bounds its slice of the history. */
  first: string
  startedAt: number
  ids: Set<string>
  steps: number
  cost: number
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  stepError?: { error: SessionStructuredError; time: number }
}

type End =
  | { kind: "succeeded" }
  | { kind: "failed"; error: SessionStructuredError }
  | { kind: "interrupted"; reason: string }

/** Runs the protocol until the input is finished and every admitted message has its result. Resolves to the exit code. */
export async function runStream(input: StreamInput) {
  const sessionID = input.sessionID
  const reconnectTiming = { ...DEFAULT_RECONNECT, ...input.reconnect }
  const stopped = Promise.withResolvers<void>()
  // Resolved when no more input is read: the end of the input, `end`, an interrupt or a broken output.
  const inputStopped = Promise.withResolvers<void>()
  let broken = false
  const out = (line: string) => {
    if (input.write) return input.write(line)
    if (broken) return
    process.stdout.write(line + "\n")
  }
  const emit = (type: string, timestamp: number, data: Record<string, unknown>) =>
    out(jsonLine({ type, timestamp, sessionID, ...data }))

  // What the controller has been shown and has not answered yet, by request ID.
  const pending = new Map<string, Pending>()
  const owned = new Map<string, Promise<boolean>>([[sessionID, Promise.resolve(true)]])
  const admitted = new Set<string>()
  const deliveries = new Map<string, "steer" | "queue">()
  const unaccounted = new Set<string>()
  const accounted = new Set<string>()
  const tools = new Map<string, ToolState>()
  const starts = new Map<string, { id: string; timestamp: number }>()
  let accountedChanged = Promise.withResolvers<void>()
  let rejected: { action: string; resources: string[] }[] = []
  let period: Period | undefined
  let closed = false
  let finished = false
  let interruptedByUser = false
  let exitCode = 0
  let lastFailed: boolean | undefined
  let spentCost = 0
  let reading = true
  let fatalError = false
  let line = 0

  const fatal = async (message: string, type = "unknown") => {
    if (fatalError) return
    fatalError = true
    emit("error", Date.now(), { subtype: "error", error: { type, message } })
    reading = false
    inputStopped.resolve()
    closed = true
    await input.client.session.interrupt({ sessionID }).catch(() => {})
    writeResult({ failed: true, outcome: "failed", reason: "error", error: message, text: "", periodState: undefined })
    finished = true
    stopped.resolve()
  }

  // The first stdout error ends the run: nobody reads the lines, so the work is stopped rather than continued unseen.
  const onStdoutError = () => {
    broken = true
    reading = false
    inputStopped.resolve()
    finished = true
    stopped.resolve()
    void input.client.session.interrupt({ sessionID }).catch(() => {})
  }
  if (!input.write) process.stdout.on("error", onStdoutError)

  // Subagents run in child sessions; their asks and questions belong to this run too. Other sessions on a shared
  // server (the TUI's, another run's) are left alone.
  const ownsSession = (id: string): Promise<boolean> => {
    const known = owned.get(id)
    if (known) return known
    const result =
      id === GLOBAL_FORM_SESSION_ID
        ? Promise.resolve(false)
        : input.client.session
            .get({ sessionID: id })
            .then((session) => (session.parentID ? ownsSession(session.parentID) : false))
            .catch(() => false)
    owned.set(id, result)
    return result
  }

  const subscribe = async () => {
    const controller = new AbortController()
    const iterator = input.client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    const connected = await iterator.next()
    if (connected.done) throw new Error("Event stream disconnected before prompt admission")
    return { controller, iterator }
  }
  let events = await subscribe()

  // The init line comes before any input is read: the controller needs the session ID before it sends anything.
  out(
    jsonLine({
      type: "init",
      protocol: PROTOCOL_VERSION,
      sessionID,
      cwd: input.envelope.cwd,
      agent: input.envelope.agent ?? null,
      model: input.envelope.model ?? null,
      version: input.envelope.version,
    }),
  )

  // ---- asks -----------------------------------------------------------------------------------------------------

  const onPermission = async (request: PermissionRequest) => {
    if (pending.has(request.id)) return
    if (input.auto) {
      await input.client.permission
        .reply({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
        .catch(() => {})
      return
    }
    if (closed) {
      rejected.push({ action: request.action, resources: [...request.resources] })
      await input.client.permission
        .reply({
          sessionID: request.sessionID,
          requestID: request.id,
          decision: "reject",
          message: EOF_PERMISSION_FEEDBACK,
        })
        .catch(() => {})
      return
    }
    pending.set(request.id, {
      kind: "permission",
      sessionID: request.sessionID,
      action: request.action,
      resources: [...request.resources],
    })
    emit("permission_request", Date.now(), { request })
  }

  const cancelForm = async (form: Pick<FormRequest, "id" | "sessionID" | "metadata">, message?: string) => {
    await input.client.session.form
      .cancel(
        { sessionID: form.sessionID, formID: form.id, ...(message ? { message } : {}) },
        ...formRequestOptions(form.sessionID === GLOBAL_FORM_SESSION_ID ? input.location : undefined),
      )
      .catch((error) => {
        if (!formAlreadySettled(error)) throw error
      })
  }

  // The form as the event served it, or as the server lists it: both carry the same fields.
  const onForm = async <F extends Pick<FormRequest, "id" | "sessionID" | "metadata">>(form: F) => {
    if (pending.has(form.id)) return
    const question = form.metadata?.kind === "question"
    // The consent to send a search to a provider stays with the person: no headless path answers it.
    if (form.metadata?.kind === "websearch.provider") return cancelForm(form).catch(() => {})
    if (closed) return cancelForm(form, question ? EOF_QUESTION_FEEDBACK : undefined).catch(() => {})
    pending.set(form.id, { kind: "form", sessionID: form.sessionID })
    emit("form_request", Date.now(), { form })
  }

  // A request this driver showed and somebody else settled: an interrupt, another client, a hook or the server.
  const settledElsewhere = (id: string) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    emit("request_cancelled", Date.now(), { kind: entry.kind, id, sessionID: entry.sessionID })
  }

  // ---- results --------------------------------------------------------------------------------------------------

  const readPeriod = async (first: string, until?: string) => {
    const collected: SessionMessageInfo[] = []
    let cursor: string | undefined
    while (true) {
      const page = await input.client.message.list(
        cursor
          ? { sessionID, limit: 200, cursor }
          : { sessionID, limit: 200, order: "desc" },
      )
      for (const message of page.data) {
        collected.push(message)
        if (message.id !== first) continue
        // Ascending from the first message of the period to the idle message that ends it.
        // A queued message that started the next period bounds this one before the history has an idle message.
        const forward = collected.toReversed()
        const next = until === undefined ? -1 : forward.findIndex((item) => item.id === until)
        if (next !== -1) return { found: true, messages: forward.slice(0, next) }
        const idle = forward.findIndex((item) => item.type === "idle")
        return { found: true, messages: idle === -1 ? forward : forward.slice(0, idle + 1) }
      }
      cursor = page.cursor.next ?? undefined
      if (!cursor) return { found: false, messages: [] as SessionMessageInfo[] }
    }
  }

  const closePeriod = async (end: End, time: number, until?: string) => {
    const current = period
    // An end event with nothing running is a failure only while an admitted message has no result.
    if (!current && (end.kind === "succeeded" || unaccounted.size === 0)) return
    const closing: Period = current ?? {
      first: [...unaccounted][0] ?? "",
      startedAt: time,
      ids: new Set(unaccounted),
      steps: 0,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    period = undefined
    tools.clear()
    starts.clear()
    const history = closing.first ? await readPeriod(closing.first, until).catch(() => undefined) : undefined
    const messages = history?.messages ?? []
    const text = answerText(messages)
    const lastAssistant = messages.findLast((message) => message.type === "assistant")
    const idleOutcome = messages.findLast((message) => message.type === "idle")?.outcome
    const truncated = lastAssistant?.finish === "length"
    const heldError = closing.stepError

    let failure: string | undefined
    let limit: SessionStructuredError | undefined
    if (end.kind === "failed") {
      if (end.error.type.startsWith("limit.")) limit = end.error
      failure = end.error.message
      emit("error", time, { subtype: subtype({ failed: true, interrupted: false, limit }), error: end.error })
    }
    if (end.kind === "interrupted" && end.reason !== "user") {
      // The failure that was held back says more than the interruption that came after it.
      const error = heldError?.error ?? { type: "aborted", message: `Session interrupted: ${end.reason}` }
      failure = error.message
      emit("error", time, { subtype: "error", error })
    }
    if (end.kind === "succeeded" && idleOutcome === "failed") {
      failure = "The run ended in failure."
      emit("error", time, { subtype: "error", error: { type: "unknown", message: failure } })
    }
    if (truncated) {
      const message = "The answer was cut off by the output limit."
      emit("notice", Date.now(), { notice: "truncated", message })
    }
    const interrupted = end.kind === "interrupted"
    const failed = end.kind !== "succeeded" || failure !== undefined
    writeResult({
      failed,
      outcome: interrupted ? "interrupted" : failed ? "failed" : "succeeded",
      reason: !failed
        ? undefined
        : interrupted && end.reason === "user"
          ? "interrupted"
          : interrupted
            ? end.reason
            : "error",
      error: failure,
      text,
      truncated,
      limit,
      userInterrupt: interrupted && end.reason === "user",
      periodState: closing,
    })
    closing.ids.forEach((id) => {
      unaccounted.delete(id)
      accounted.add(id)
    })
    interruptedByUser = false
    const changed = accountedChanged
    accountedChanged = Promise.withResolvers<void>()
    changed.resolve()
  }

  function writeResult(result: {
    failed: boolean
    outcome: "succeeded" | "failed" | "interrupted"
    reason: string | undefined
    error: string | undefined
    text: string
    truncated?: boolean
    limit?: SessionStructuredError
    userInterrupt?: boolean
    periodState: Period | undefined
  }) {
    const state = result.periodState
    const line = envelopeResultLine({
      sessionID,
      text: result.text,
      failed: result.failed,
      schema: input.jsonSchema,
      subtype: subtype({ failed: result.failed, interrupted: result.userInterrupt ?? false, limit: result.limit }),
      truncated: result.truncated ?? false,
      outcome: result.outcome,
      reason: result.reason,
      error: result.error,
      steps: state?.steps ?? 0,
      duration: Date.now() - (state?.startedAt ?? Date.now()),
      cost: state?.cost ?? 0,
      tokens: state?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      rejected,
    })
    rejected = []
    spentCost += state?.cost ?? 0
    lastFailed = line.failed
    markResultWritten()
    out(line.line)
  }

  // ---- events ---------------------------------------------------------------------------------------------------

  const handle = async (event: V2Event) => {
    if (event.type === "permission.asked") {
      if (await ownsSession(event.data.sessionID)) await onPermission(event.data)
      return
    }
    if (event.type === "form.created") {
      const form = event.data.form
      if (
        (await ownsSession(form.sessionID)) ||
        (!input.attached && form.sessionID === GLOBAL_FORM_SESSION_ID && sameLocation(event.location, input.location))
      )
        await onForm(form)
      return
    }
    if (event.type === "permission.replied") return settledElsewhere(event.data.requestID)
    if (event.type === "form.replied" || event.type === "form.cancelled") return settledElsewhere(event.data.id)

    // Steps of this run's own sessions, subagents included, count toward the busy period before the filter that
    // keeps only the root session's output.
    if (
      period &&
      (event.type === "session.step.started" ||
        event.type === "session.step.ended" ||
        event.type === "session.step.failed") &&
      (await ownsSession(event.data.sessionID))
    )
      tally(period, event)
    if (!("sessionID" in event.data) || event.data.sessionID !== sessionID) return
    const time = toMillis("created" in event ? event.created : undefined)

    if (event.type === "session.inbox.delivered") {
      // A queued message waits for the work before it to end, so it starts a period of its own with its own result,
      // although the server delivers it inside the same run.
      if (period && period.ids.size > 0 && unaccounted.has(event.data.inboxID) && deliveries.get(event.data.inboxID) === "queue")
        await closePeriod({ kind: "succeeded" }, time, event.data.inboxID)
      if (!period)
        period = {
          first: event.data.inboxID,
          startedAt: Date.now(),
          ids: new Set(),
          steps: 0,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
      if (unaccounted.has(event.data.inboxID)) period.ids.add(event.data.inboxID)
      return
    }
    if (event.type === "session.execution.succeeded") return closePeriod({ kind: "succeeded" }, time)
    if (event.type === "session.execution.failed") return closePeriod({ kind: "failed", error: event.data.error }, time)
    if (event.type === "session.execution.interrupted")
      return closePeriod({ kind: "interrupted", reason: event.data.reason }, time)
    if (!period) return

    if (input.partial && event.type === "session.text.delta") {
      emit("text_delta", time, {
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        delta: event.data.delta,
      })
      return
    }
    if (input.partial && input.thinking && event.type === "session.reasoning.delta") {
      emit("reasoning_delta", time, {
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        delta: event.data.delta,
      })
      return
    }

    if (event.type === "session.step.started") {
      // Another step means that the runner recovered from the failure it held back.
      period.stepError = undefined
      emit("step_start", time, {
        part: {
          id: partID(event.id),
          sessionID,
          messageID: event.data.assistantMessageID,
          type: "step-start",
          snapshot: event.data.snapshot,
        },
      })
      return
    }
    if (event.type === "session.text.started") {
      starts.set(`text\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`, {
        id: partID(event.id),
        timestamp: time,
      })
      return
    }
    if (event.type === "session.text.ended") {
      const key = `text\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`
      const started = starts.get(key)
      starts.delete(key)
      emit("text", time, {
        part: {
          id: started?.id ?? partID(event.id),
          sessionID,
          messageID: event.data.assistantMessageID,
          type: "text",
          text: event.data.text,
          time: { start: started?.timestamp ?? time, end: time },
        },
      })
      return
    }
    if (event.type === "session.reasoning.started") {
      starts.set(`reasoning\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`, {
        id: partID(event.id),
        timestamp: time,
      })
      return
    }
    if (event.type === "session.reasoning.ended" && input.thinking) {
      const key = `reasoning\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`
      const started = starts.get(key)
      starts.delete(key)
      emit("reasoning", time, {
        part: {
          id: started?.id ?? partID(event.id),
          sessionID,
          messageID: event.data.assistantMessageID,
          type: "reasoning",
          text: event.data.text,
          metadata: event.data.state,
          time: { start: started?.timestamp ?? time, end: time },
        },
      })
      return
    }

    if (event.type === "session.tool.input.started") {
      tools.set(toolKey(event.data.assistantMessageID, event.data.id), {
        id: partID(event.id),
        timestamp: time,
        tool: event.data.name,
        input: {},
        metadata: {},
        content: [],
      })
      return
    }
    if (event.type === "session.tool.input.ended") {
      const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
      if (current) current.raw = event.data.text
      return
    }
    if (event.type === "session.tool.input.delta") {
      const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
      if (current) current.raw = (current.raw ?? "") + event.data.delta
      if (input.partial)
        emit("tool_input_delta", time, {
          messageID: event.data.assistantMessageID,
          toolID: event.data.id,
          tool: current?.tool,
          delta: event.data.delta,
        })
      return
    }
    if (event.type === "session.tool.called") {
      const key = toolKey(event.data.assistantMessageID, event.data.id)
      const current = tools.get(key)
      tools.set(key, {
        id: current?.id ?? partID(event.id),
        timestamp: current?.timestamp ?? time,
        tool: current?.tool ?? "tool",
        input: event.data.input,
        raw: current?.raw,
        provider: { executed: event.data.executed, state: event.data.state },
        metadata: {},
        content: [],
      })
      return
    }
    if (event.type === "session.tool.progress") {
      const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
      if (current) current.metadata = event.data.metadata
      return
    }
    if (event.type === "session.tool.success") {
      const key = toolKey(event.data.assistantMessageID, event.data.id)
      const current = tools.get(key) ?? fallbackTool(event)
      tools.delete(key)
      const part: MiniToolPart = {
        partID: current.id,
        sessionID,
        messageID: event.data.assistantMessageID,
        type: "tool",
        id: event.data.id,
        tool: current.tool,
        state: {
          status: "completed",
          input: current.input,
          output: toolOutputText(current.tool, event.data.content),
          title: current.tool,
          metadata: {
            metadata: event.data.metadata,
            content: event.data.content,
            providerCall: current.provider,
            providerResult: { executed: event.data.executed, state: event.data.resultState },
            rawInput: current.raw,
          },
          time: { start: current.timestamp, end: time },
        },
      }
      emit("tool_use", time, { part })
      return
    }
    if (event.type === "session.tool.failed") {
      const key = toolKey(event.data.assistantMessageID, event.data.id)
      const current = tools.get(key) ?? fallbackTool(event)
      tools.delete(key)
      const part: MiniToolPart = {
        partID: current.id,
        sessionID,
        messageID: event.data.assistantMessageID,
        type: "tool",
        id: event.data.id,
        tool: current.tool,
        state: {
          status: "error",
          input: current.input,
          error: event.data.error.message,
          metadata: {
            providerCall: current.provider,
            providerResult: { executed: event.data.executed, state: event.data.resultState },
            rawInput: current.raw,
          },
          time: { start: current.timestamp, end: time },
        },
      }
      emit("tool_use", time, { part })
      return
    }
    if (event.type === "session.step.ended") {
      emit("step_finish", time, {
        part: {
          id: partID(event.id),
          sessionID,
          messageID: event.data.assistantMessageID,
          type: "step-finish",
          reason: event.data.finish,
          snapshot: event.data.snapshot,
          cost: event.data.cost,
          tokens: event.data.tokens,
        },
      })
      return
    }
    if (event.type === "session.step.failed") {
      // The runner may recover by continuing or by switching to a fallback model; the next step to start clears this.
      period.stepError = { error: event.data.error, time }
      return
    }
    if (event.type === "session.synthetic") {
      const description = event.data.description
      const escalation = Option.getOrUndefined(decodeEscalation(event.data.metadata))
      if (escalation) return emit("notice", time, { notice: escalation.notice, replaces: escalation.replaces })
      const notice = Option.getOrUndefined(decodeNotice(event.data.metadata))
      if (notice && description) emit("notice", time, { notice: notice.notice, message: description })
    }
  }

  const eventLoop = async () => {
    while (!finished) {
      const next = await events.iterator.next().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      if (finished) return
      if ("error" in next || next.value.done) {
        await reconnect("error" in next ? next.error : undefined)
        continue
      }
      await handle(next.value.value).catch((error) => {
        UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + progress(errorMessage(error)))
      })
    }
  }

  const sleep = (ms: number) => Promise.race([Bun.sleep(ms), stopped.promise])

  // Orbit's event stream is volatile: events during a gap are lost and there is no resume ID. So the driver subscribes
  // again with an exponential delay and then reads the server's current state instead of waiting for events it missed.
  const reconnect = async (cause: unknown) => {
    events.controller.abort()
    const began = Date.now()
    let error = cause
    for (let attempt = 0; !finished; attempt++) {
      if (permanentStatus(error)) return fatal(`The event stream cannot be reopened: ${errorMessage(error)}`)
      if (Date.now() - began >= reconnectTiming.giveUpMs)
        return fatal(`The event stream did not come back: ${errorMessage(error)}`)
      const base = Math.min(reconnectTiming.capMs, reconnectTiming.baseMs * 2 ** attempt)
      await sleep(base * (0.75 + Math.random() * 0.5))
      if (finished) return
      const next = await subscribe().then(
        (value) => ({ value }),
        (failure: unknown) => ({ failure }),
      )
      if ("failure" in next) {
        error = next.failure
        continue
      }
      events = next.value
      await resync()
      return
    }
  }

  const resync = async () => {
    const current = new Set<string>()
    const asked = await listPending()
    asked.permissions.forEach((request) => current.add(request.id))
    asked.forms.forEach((form) => current.add(form.id))
    // Requests that were shown and are gone were settled during the gap.
    ;[...pending.keys()].filter((id) => !current.has(id)).forEach(settledElsewhere)
    await Promise.all([...asked.permissions.map(onPermission), ...asked.forms.map(onForm)])
    // The root session may have gone idle during the gap; its history says so, and its result is still written.
    if (period) {
      const history = await readPeriod(period.first).catch(() => undefined)
      const idle = history?.messages.findLast((message) => message.type === "idle")
      if (history && idle) {
        const spent = spentFromHistory(history.messages)
        Object.assign(period, spent)
        await closePeriod(
          idle.outcome === "succeeded"
            ? { kind: "succeeded" }
            : idle.outcome === "interrupted"
              ? { kind: "interrupted", reason: "user" }
              : { kind: "failed", error: { type: "unknown", message: "The run ended in failure." } },
          Date.now(),
        )
      }
    }
    out(jsonLine({ type: "system", subtype: "reconnected", timestamp: Date.now(), sessionID }))
  }

  const listPending = async () => {
    const sessions = (await Promise.all([...owned].map(async ([id, owns]) => ((await owns) ? [id] : [])))).flat()
    const [permissions, forms, globals] = await Promise.all([
      Promise.all(sessions.map((id) => input.client.permission.list({ sessionID: id }).catch(() => []))),
      Promise.all(sessions.map((id) => input.client.session.form.list({ sessionID: id }).catch(() => []))),
      input.attached
        ? Promise.resolve(undefined)
        : input.client.form.list({ location: { directory: input.location.directory } }).catch(() => undefined),
    ])
    return {
      permissions: permissions.flat(),
      forms: [
        ...forms.flat(),
        ...(globals && sameLocation(globals.location, input.location)
          ? globals.data.filter((form) => form.sessionID === GLOBAL_FORM_SESSION_ID)
          : []),
      ],
    }
  }

  // ---- input ----------------------------------------------------------------------------------------------------

  const admit = async (message: string, files: File[], id: string | undefined, delivery: "steer" | "queue") => {
    const prepared = await Promise.all(files.map(prepareFile))
    const messageID = id ?? SessionMessage.ID.create()
    const turn = remainingTurn(input.turn, spentCost)
    if (turn === "exhausted") {
      // The cost limit covers the whole process, so once it is spent no later message runs.
      writeResult({
        failed: true,
        outcome: "failed",
        reason: "error",
        error: "The cost limit of this run was reached.",
        text: "",
        limit: { type: "limit.cost", message: "The cost limit of this run was reached." },
        periodState: undefined,
      })
      return
    }
    admitted.add(messageID)
    deliveries.set(messageID, delivery)
    if (!accounted.has(messageID)) unaccounted.add(messageID)
    const response = await input.client.session
      .prompt({
        sessionID,
        id: messageID,
        text: [
          message,
          ...prepared.flatMap((file) => (file.text ? [file.text] : [])),
          ...(input.jsonSchema === undefined ? [] : [schemaInstruction(input.jsonSchema)]),
        ].join("\n\n"),
        files: prepared.flatMap((file) => (file.attachment ? [file.attachment] : [])),
        delivery,
        ...(turn ? { turn } : {}),
      })
      .catch((error) => {
        if (!accounted.has(messageID) && !period?.ids.has(messageID)) unaccounted.delete(messageID)
        throw error
      })
    // An older server drops the fields it does not know, so it would run without the limits that were asked for.
    if (turn && !echoes(turn, response.payload?.turn))
      await fatal(
        "The server did not accept the limits or fallback model for this run, so it may be an older version than this client. Update the server, or run without --max-steps, --max-cost, --max-tokens and --fallback-model.",
        "version-mismatch",
      )
  }

  const reply = async (id: string, kind: Pending["kind"], send: (entry: Pending) => Promise<unknown>) => {
    const entry = pending.get(id)
    if (!entry || entry.kind !== kind) {
      emit("error", Date.now(), {
        subtype: "error",
        error: { type: "unknown_request", message: "No request with this ID is waiting for an answer.", id },
      })
      return
    }
    // Forgotten before the call, so the event that follows our own answer is not reported as somebody else's.
    pending.delete(id)
    await send(entry).catch((error) => {
      if (!formAlreadySettled(error)) pending.set(id, entry)
      throw error
    })
  }

  const perform = async (message: Input) => {
    if (message.type === "user")
      return admit(
        message.text,
        await Promise.all((message.files ?? []).map(input.resolveFile)),
        message.id,
        message.delivery ?? "steer",
      )
    if (message.type === "interrupt") return void (await input.client.session.interrupt({ sessionID }))
    if (message.type === "permission_reply")
      return reply(message.requestID, "permission", (entry) =>
        input.client.permission.reply({
          sessionID: entry.sessionID,
          requestID: message.requestID,
          decision: message.decision,
          ...(message.message === undefined ? {} : { message: message.message }),
        }),
      )
    if (message.type === "form_reply")
      return reply(message.formID, "form", (entry) =>
        input.client.session.form.reply(
          { sessionID: entry.sessionID, formID: message.formID, answer: message.answer },
          ...formRequestOptions(entry.sessionID === GLOBAL_FORM_SESSION_ID ? input.location : undefined),
        ),
      )
    if (message.type === "form_cancel")
      return reply(message.formID, "form", (entry) =>
        input.client.session.form.cancel(
          {
            sessionID: entry.sessionID,
            formID: message.formID,
            ...(message.message === undefined ? {} : { message: message.message }),
          },
          ...formRequestOptions(entry.sessionID === GLOBAL_FORM_SESSION_ID ? input.location : undefined),
        ),
      )
    if (message.type === "set_model") {
      const selected =
        message.model === undefined || message.model === "default"
          ? await input.client.model.default({ location: { directory: input.location.directory } }).then((result) =>
              result.data ? { providerID: result.data.providerID, id: result.data.id } : undefined,
            )
          : parseSessionTargetModel(message.model)
      if (!selected) throw new Error("This folder has no default model")
      return void (await input.client.session.switchModel({ sessionID, model: selected }))
    }
    // end: stop what is running, then finish as at the end of the input.
    reading = false
    inputStopped.resolve()
    if (period) await input.client.session.interrupt({ sessionID })
  }

  const dispatch = async (text: string) => {
    if (text.trim() === "") return
    line += 1
    const decoded = decodeInput(text)
    if (Result.isFailure(decoded)) {
      emit("error", Date.now(), {
        subtype: "error",
        error: { type: "invalid_input", message: decoded.failure.message, path: decoded.failure.path, line },
      })
      return
    }
    const message = decoded.success
    await perform(message).catch((error) => {
      emit("error", Date.now(), {
        subtype: "error",
        error: { type: "input_failed", input: message.type, message: errorMessage(error), line },
      })
    })
  }

  const readInput = async () => {
    if (!input.stdin) return
    const iterator = input.stdin[Symbol.asyncIterator]()
    const reader = lineReader()
    const quit = inputStopped.promise.then(() => undefined)
    while (reading) {
      const next = await Promise.race([iterator.next(), quit])
      if (!reading || next === undefined) break
      if (next.done) {
        for (const rest of reader.end()) await dispatch(rest)
        break
      }
      for (const text of reader.push(next.value)) {
        if (!reading) break
        await dispatch(text)
      }
    }
    void iterator.return?.(undefined)?.catch?.(() => {})
  }

  // ---- end of input ---------------------------------------------------------------------------------------------

  // Everything that is waiting for the controller is settled, so that no run waits for an answer nobody can give.
  const settleAll = async () => {
    const asked = await listPending()
    const known = new Map(pending)
    pending.clear()
    const requests = asked.permissions.filter((request) => !known.has(request.id))
    await Promise.all([
      ...[...known].map(async ([id, entry]) => {
        if (entry.kind === "permission") {
          rejected.push({ action: entry.action ?? "unknown", resources: entry.resources ?? [] })
          return input.client.permission
            .reply({ sessionID: entry.sessionID, requestID: id, decision: "reject", message: EOF_PERMISSION_FEEDBACK })
            .catch(() => {})
        }
        const form = asked.forms.find((item) => item.id === id)
        return cancelForm(
          { id, sessionID: entry.sessionID, metadata: form?.metadata },
          form?.metadata?.kind === "question" ? EOF_QUESTION_FEEDBACK : undefined,
        ).catch(() => {})
      }),
      ...requests.map(onPermission),
      ...asked.forms.filter((form) => !known.has(form.id)).map(onForm),
    ])
  }

  const settled = async () => {
    // Nothing is waiting for the controller any more: an ask that arises from here on is settled where it appears.
    let idleSince: number | undefined
    while (!finished) {
      await input.client.session.wait({ sessionID })
      const inbox = await input.client.session.inbox.list({ sessionID }).catch(() => [])
      if (inbox.length > 0) {
        // The runner delivers the queue at its next boundary; a queue that stays put is not going to run.
        idleSince ??= Date.now()
        if (Date.now() - idleSince > 10_000) return
        await Bun.sleep(100)
        continue
      }
      idleSince = undefined
      // The events can trail the history: an admitted message has no result until its busy period ends.
      const deadline = Date.now() + 5_000
      while ((unaccounted.size > 0 || period) && Date.now() < deadline) {
        await Promise.race([accountedChanged.promise, Bun.sleep(100)])
      }
      if (unaccounted.size > 0 || period) {
        period = undefined
        writeResult({
          failed: true,
          outcome: "failed",
          reason: "incomplete",
          error: "The run ended before the message had a result.",
          text: "",
          periodState: undefined,
        })
        unaccounted.clear()
      }
      return
    }
  }

  // ---- run ------------------------------------------------------------------------------------------------------

  const onSigint = () => {
    if (interruptedByUser) process.exit(130)
    interruptedByUser = true
    exitCode = 130
    reading = false
    inputStopped.resolve()
    void input.client.session.interrupt({ sessionID }).catch(() => {})
  }
  process.on("SIGINT", onSigint)

  const loop = eventLoop()
  try {
    if (input.agent) await input.client.session.switchAgent({ sessionID, agent: input.agent })
    const selected = input.model
      ? { providerID: input.model.providerID, id: input.model.modelID, variant: input.variant }
      : undefined
    if (selected) await input.client.session.switchModel({ sessionID, model: selected })
    if (input.first) await admit(input.first.message, input.first.files, undefined, "steer")
    await readInput()
    closed = true
    await settleAll()
    await settled()
  } catch (error) {
    await fatal(errorMessage(error))
  } finally {
    finished = true
    stopped.resolve()
    process.off("SIGINT", onSigint)
    if (!input.write) process.stdout.off("error", onStdoutError)
    events.controller.abort()
    void events.iterator.return?.(undefined).catch(() => {})
    await loop.catch(() => {})
  }
  if (exitCode === 0 && (fatalError || lastFailed)) exitCode = 1
  return exitCode
}

type ToolState = {
  id: string
  timestamp: number
  tool: string
  input: Record<string, JsonValue>
  raw?: string
  provider?: unknown
  metadata: Record<string, JsonValue>
  content: ToolContent[]
}

function fallbackTool(event: { id: string; created: number }): ToolState {
  return { id: partID(event.id), timestamp: toMillis(event.created), tool: "tool", input: {}, metadata: {}, content: [] }
}

function tally(
  period: Period,
  event: Extract<V2Event, { type: "session.step.started" | "session.step.ended" | "session.step.failed" }>,
) {
  if (event.type === "session.step.started") {
    period.steps += 1
    return
  }
  period.cost += event.data.cost ?? 0
  const tokens = event.data.tokens
  if (!tokens) return
  period.tokens.input += tokens.input
  period.tokens.output += tokens.output
  period.tokens.reasoning += tokens.reasoning
  period.tokens.cache.read += tokens.cache.read
  period.tokens.cache.write += tokens.cache.write
}

// What the responses of a busy period spent, read from the history when the events that carried it were missed.
function spentFromHistory(messages: SessionMessageInfo[]) {
  const assistants = messages.filter((message) => message.type === "assistant")
  return {
    steps: assistants.filter((message) => message.finish && countedFinishes.has(message.finish)).length,
    cost: assistants.reduce((total, message) => total + (message.cost ?? 0), 0),
    tokens: assistants.reduce(
      (total, message) => ({
        input: total.input + (message.tokens?.input ?? 0),
        output: total.output + (message.tokens?.output ?? 0),
        reasoning: total.reasoning + (message.tokens?.reasoning ?? 0),
        cache: {
          read: total.cache.read + (message.tokens?.cache.read ?? 0),
          write: total.cache.write + (message.tokens?.cache.write ?? 0),
        },
      }),
      { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ),
  }
}

// The answer of a busy period: its text parts, trimmed and joined by blank lines. A step that stopped at the output
// limit is continued by the next one, which can start in the middle of a word, so those join without a separator.
function answerText(messages: SessionMessageInfo[]) {
  const parts: string[] = []
  let continued = false
  messages.forEach((message) => {
    if (message.type !== "assistant") return
    let first = true
    message.content.forEach((item) => {
      if (item.type !== "text") return
      if (first && continued && parts.length > 0) parts[parts.length - 1] += item.text
      else parts.push(item.text)
      first = false
    })
    if (message.content.some((item) => item.type === "text")) continued = message.finish === "length"
  })
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n")
}

// The cost limit covers the whole process, so each admission carries what is left of it.
function remainingTurn(turn: SessionTurnOptions | undefined, spent: number) {
  if (!turn || turn.maxCost === undefined) return turn
  const left = turn.maxCost - spent
  if (left <= 0) return "exhausted" as const
  return { ...turn, maxCost: left }
}

// A status that reopening cannot change: the credential is refused or the route is gone.
function permanentStatus(error: unknown) {
  const cause = typeof error === "object" && error !== null && "cause" in error ? error.cause : undefined
  const status = typeof cause === "object" && cause !== null && "status" in cause ? cause.status : undefined
  return status === 401 || status === 403 || status === 404
}

