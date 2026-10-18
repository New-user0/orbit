import type {
  EventSubscribeOutput,
  JsonValue,
  LocationRef,
  OrbitClient,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionStructuredError,
  SessionTurnOptions,
  ToolContent,
} from "@orbit/client/promise"
import { jsonLine, progress } from "@orbit/flow/plain"
import { errorMessage } from "../util/error"
import { waitForBackground } from "@orbit/flow/background"
import { Event } from "@orbit/schema/event"
import { SessionMessage } from "@orbit/schema/session-message"
import { EOL } from "node:os"
import { Option, Schema } from "effect"
import {
  GLOBAL_FORM_SESSION_ID,
  contentKey,
  stepIDs,
  decodeEscalation,
  decodeNotice,
  echoes,
  envelopeResultLine,
  formAlreadySettled,
  formRequestOptions,
  markResultWritten,
  failureReason,
  partID,
  prepareFile,
  projectedPartID,
  sameLocation,
  structuredAnswer,
  subtype,
  toMillis,
  toolKey,
  type EnvelopeResult,
  type File,
} from "./format"
import { nonEmptyToolContent, toolOutputText, type MiniToolPart } from "@orbit/tui/mini/tool"
import { UI } from "./ui"

type Model = {
  providerID: string
  modelID: string
}

type Input = {
  client: OrbitClient
  sessionID: string
  location: LocationRef
  message: string
  files: File[]
  agent?: string
  model?: Model
  variant?: string
  thinking: boolean
  /** "json" and "stream-json" emit one JSON event per line; "result" prints one JSON object when the run ends. */
  format: "default" | "json" | "stream-json" | "result"
  /** A JSON Schema the final answer must follow; the result then carries the parsed value. */
  jsonSchema?: unknown
  /** Limits and a fallback model for this prompt; the server must echo them back or the run stops. */
  turn?: SessionTurnOptions
  auto: boolean
  /**
   * The headless output contract of `orb -p`. With `format` "result" or "stream-json" it adds an init line before the
   * prompt is admitted and ends with exactly one enriched result line; with "default" and a schema it prints only the
   * parsed JSON. Without it the run prints what `orb run --format` always printed.
   */
  envelope?: { cwd: string; agent?: string; model?: string; version: string }
  /** With the stream-json envelope: a line for every text, reasoning and tool input fragment as it streams. */
  partial?: boolean
  /** With the text format: tool output bodies and one usage line per step, on stderr. */
  verbose?: boolean
  /** True when the client is attached to a shared server rather than an exclusive in-process one. */
  attached: boolean
  compatibility?: "v1"
  renderTool: (part: SessionMessageAssistantTool) => Promise<void>
  renderToolError: (part: SessionMessageAssistantTool) => Promise<void>
}

type StartedPart = {
  id: string
  timestamp: number
}

type ToolState = StartedPart & {
  assistantMessageID: string
  tool: string
  input: Record<string, JsonValue>
  raw?: string
  provider?: unknown
  providerState?: SessionMessageAssistantTool["providerState"]
  metadata: Record<string, JsonValue>
  content: ToolContent[]
}

// Output that is not written yet, in the order it arrived: the text parts that one answer runs across, and the notes
// about tool calls that the output limit cut off. See `release`.
type Held =
  | { type: "text"; parts: { messageID: string; text: string }[] }
  | { type: "note"; messageID: string; line: string }

type V2Event = EventSubscribeOutput
type FormRequest = Extract<V2Event, { type: "form.created" }>["data"]["form"]

const QUESTION_CANCELLED_FEEDBACK =
  "This non-interactive run cannot ask the user questions, so the question was cancelled. Continue without an answer; make reasonable assumptions and state them."

const PERMISSION_REJECTED_FEEDBACK =
  "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action."

export { wroteResult } from "./format"

export async function runNonInteractivePrompt(input: Input) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const stream = input.client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
  const connected = await stream.next()
  if (connected.done) throw new Error("Event stream disconnected before prompt admission")
  // The lines of the envelope, and the schema text mode that prints only the parsed answer.
  const lines = input.envelope !== undefined && (input.format === "result" || input.format === "stream-json")
  const schemaText = input.envelope !== undefined && input.format === "default" && input.jsonSchema !== undefined
  // The answer of these runs is gathered through `hold`, so every format joins output-limit continuations the same way.
  const collecting = input.format === "result" || schemaText || (lines && input.format === "stream-json")
  if (lines && input.envelope && input.format === "stream-json") {
    process.stdout.write(
      jsonLine({
        type: "init",
        protocol: 1,
        sessionID: input.sessionID,
        cwd: input.envelope.cwd,
        agent: input.envelope.agent ?? null,
        model: input.envelope.model ?? null,
        version: input.envelope.version,
      }) + EOL,
    )
  }

  const messageID = SessionMessage.ID.create()
  const starts = new Map<string, StartedPart>()
  const tools = new Map<string, ToolState>()
  const renderedText = new Map<string, string>()
  const renderedReasoning = new Map<string, string>()
  const renderedTools = new Set<string>()
  let submitted = false
  let promoted = false
  let emittedError = false
  let reachedEnd = false
  let permissionRejected = false
  let formCancelled = false
  let interrupted = false
  // Why the runner stopped the run when the user did not: a shutdown, inactivity or a newer prompt. The result reports
  // it as an interruption with that reason.
  let interruption: string | undefined
  let v1InvalidOutput = false
  let prePromotionError: { message: string; [key: string]: unknown } | undefined
  let finalizing = false
  let admission: AbortController | undefined
  let pendingStep: { timestamp: number; part: Record<string, unknown>; label: string } | undefined
  // A step that failed, which the runner may still recover from by continuing after an early end of stream or by
  // switching to a fallback model. The next step to start clears it. It is reported only when the run ends without one.
  let pendingStepError: { error: SessionStructuredError; time: number } | undefined
  let held: Held[] = []
  // What the result line reports: the message of the failure, the totals of this run's sessions and the requests that
  // were rejected because nobody could approve them.
  let failure: string | undefined
  const totals = { steps: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  const rejected: { action: string; resources: string[] }[] = []
  // The assistant messages whose step ended at the output limit, and the ones that a notice replaced.
  const lengthMessages = new Set<string>()
  const replaced = new Set<string>()
  // Messages of notices that were already shown, so the history does not show again what the events did.
  const shown = new Set<string>()
  // What this session's own responses to this prompt spent (not its subagents'), read from the projected messages when
  // the run ends; and how the last step finished, for the truncation warning.
  const spent = { steps: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let lastFinish: string | undefined
  let limit: SessionStructuredError | undefined
  // The type of the error that ended the busy period, and the accepted structured answer read from the history.
  let endType: string | undefined
  let structured: { value: unknown } | undefined
  let ended = false

  const streaming = input.format === "json" || input.format === "stream-json"
  const answer: string[] = []
  const emit = (type: string, timestamp: number, data: Record<string, unknown>) => {
    if (!streaming) return false
    process.stdout.write(jsonLine({ type, timestamp, sessionID: input.sessionID, ...data }) + EOL)
    return true
  }

  const printText = (value: string) => {
    const text = value.trim()
    if (!text) return
    if (collecting) return void answer.push(text)
    if (!process.stdout.isTTY) {
      process.stdout.write(text + EOL)
      return
    }
    UI.empty()
    UI.println(text)
    UI.empty()
  }

  // The text of a step is written when what comes after it shows that it is complete. A step that stops at the output
  // limit is continued by the next one, which can start in the middle of a word, and the runner can drop that attempt
  // and answer again from the start. So text waits until its step ends without the limit, until something else is
  // written, or until the run ends.
  const release = () => {
    const items = held
    held = []
    items.forEach((item) => {
      if (item.type === "text") return printText(item.parts.map((part) => part.text).join(""))
      UI.println(UI.Style.TEXT_DIM + item.line + UI.Style.TEXT_NORMAL)
    })
  }

  const hold = (messageID: string, text: string) => {
    const last = held.at(-1)
    if (last?.type === "text") {
      // Joined as it is, with no separator and no trimming: the cut can fall inside a word or a JSON string.
      const previous = last.parts[last.parts.length - 1].messageID
      if (previous !== messageID && lengthMessages.has(previous)) return void last.parts.push({ messageID, text })
    }
    held.push({ type: "text", parts: [{ messageID, text }] })
  }

  const discard = (messageID: string) => {
    held = held.flatMap((item): Held[] => {
      if (item.type === "note") return item.messageID === messageID ? [] : [item]
      const parts = item.parts.filter((part) => part.messageID !== messageID)
      return parts.length === 0 ? [] : [{ ...item, parts }]
    })
  }

  // The runner raised the output limit and is answering again from the start. What the cut-off attempt wrote is
  // dropped from the answer, and a program that reads the JSON lines is told which message to drop.
  const replace = (id: string, metadata: unknown, description: string | undefined, time: number) => {
    const notice = Option.getOrUndefined(decodeEscalation(metadata))
    if (!notice) return showNotice(id, metadata, description, time)
    discard(notice.replaces)
    if (replaced.has(notice.replaces)) return
    replaced.add(notice.replaces)
    emit("notice", time, { notice: notice.notice, replaces: notice.replaces })
  }

  // The output-escalation notice above prints no line and carries no message even when it has a description: a program
  // reads it to drop the replaced text, and loop-robustness-16 decides whether to word it for a person.
  // A message that the runner records for the person to read, such as a switch to the fallback model, names its kind in
  // `metadata.notice` and says what happened in its description. A reminder only the model reads has no description,
  // and prints nothing. The text comes from the runner but can quote a file, so it is written out as `progress` does.
  const showNotice = (id: string, metadata: unknown, description: string | undefined, time: number) => {
    const notice = Option.getOrUndefined(decodeNotice(metadata))
    if (!notice || !description) return
    // Keyed by the message, which the event and the history share, so two notices with the same words both print.
    if (shown.has(id)) return
    shown.add(id)
    if (emit("notice", time, { notice: notice.notice, message: description })) return
    UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + progress(description))
  }

  const endStep = (messageID: string, finish: string | undefined) => {
    lastFinish = finish
    if (finish === "length") return void lengthMessages.add(messageID)
    release()
  }

  // A tool call that the model wrote only part of is not a failure to report, because the runner tells the model and it
  // writes the call again. The note waits with the text of its step, which can be replaced.
  const noteTruncated = (messageID: string, tool: string) =>
    void held.push({ type: "note", messageID, line: progress(`Tool call cut off by the output limit: ${tool}`) })

  // A declined tool call ends its step with an interrupted-step error that is only a consequence of our own rejection,
  // which was reported when the call was declined.
  const surfaceStepError = () => {
    const step = pendingStepError
    pendingStepError = undefined
    if (!step || emittedError || permissionRejected || formCancelled) return
    emittedError = true
    process.exitCode = 1
    failure = step.error.message
    if (!emit("error", step.time, { subtype: "error", error: step.error })) UI.error(step.error.message)
  }

  const writeText = (part: { messageID: string; text: string; [key: string]: unknown }, timestamp: number) => {
    const written = emit("text", timestamp, { part })
    if (written && !collecting) return
    if (input.compatibility === "v1") return printText(part.text)
    hold(part.messageID, part.text)
  }

  const writeReasoning = (part: { text: string; [key: string]: unknown }, timestamp: number) => {
    if (emit("reasoning", timestamp, { part })) return
    if (collecting) return
    const text = part.text.trim()
    if (!text) return
    release()
    const line = `Thinking: ${text}`
    if (!process.stdout.isTTY) return void process.stdout.write(line + EOL)
    UI.empty()
    UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
    UI.empty()
  }

  const flushStep = () => {
    if (!pendingStep) return
    const value = pendingStep
    pendingStep = undefined
    if (!emit("step_start", value.timestamp, { part: value.part }) && input.format === "default") {
      UI.empty()
      UI.println(value.label)
      UI.empty()
    }
  }

  // Subagents run in child sessions; their asks and questions belong to this run too. Other
  // sessions on a shared server (e.g. the TUI's) must be left alone.
  const owned = new Map<string, Promise<boolean>>([[input.sessionID, Promise.resolve(true)]])
  const ownsSession = (sessionID: string): Promise<boolean> => {
    const known = owned.get(sessionID)
    if (known) return known
    const result =
      sessionID === GLOBAL_FORM_SESSION_ID
        ? Promise.resolve(false)
        : input.client.session
            .get({ sessionID })
            .then((session) => (session.parentID ? ownsSession(session.parentID) : false))
            .catch(() => false)
    owned.set(sessionID, result)
    return result
  }

  const replyPermission = async (request: {
    id: string
    sessionID: string
    action: string
    resources: ReadonlyArray<string>
  }) => {
    // Nobody can approve here. Outside V1 compatibility, reject with feedback so the tool fails
    // as ordinary model-visible output and the model continues without the action.
    const continuing = !input.auto && input.compatibility !== "v1"
    if (!input.auto) {
      if (!continuing) permissionRejected = true
      rejected.push({ action: request.action, resources: [...request.resources] })
      release()
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "!",
        UI.Style.TEXT_NORMAL +
          progress(`permission requested: ${request.action} (${request.resources.join(", ")}); auto-rejecting`),
      )
    }
    await input.client.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.id,
        decision: input.auto ? "once" : "reject",
        ...(continuing ? { message: PERMISSION_REJECTED_FEEDBACK } : {}),
      })
      .catch(() => {})
    if (!input.auto && !continuing) {
      await input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {})
    }
  }

  const cancelForm = async (request: Pick<FormRequest, "id" | "sessionID" | "metadata">) => {
    // Nobody can answer a question here. Outside V1 compatibility, cancel it with a message so the
    // question tool fails as ordinary model-visible output and the model continues without an answer.
    const continuing = request.metadata?.kind === "question" && input.compatibility !== "v1"
    try {
      await input.client.session.form.cancel(
        {
          sessionID: request.sessionID,
          formID: request.id,
          ...(continuing ? { message: QUESTION_CANCELLED_FEEDBACK } : {}),
        },
        ...formRequestOptions(request.sessionID === GLOBAL_FORM_SESSION_ID ? input.location : undefined),
      )
    } catch (error) {
      if (!formAlreadySettled(error)) throw error
    }
    if (continuing) return
    formCancelled = true
    if (input.compatibility !== "v1") process.exitCode = 1
  }

  // The events can trail the history. Once the history is being read, the last steps may not have reached this loop yet,
  // so the text that waits for a step to continue it and the failure that a step may have recovered from are left to the
  // history, which writes them when it is done.
  const endEvents = () => {
    if (finalizing) return
    release()
    surfaceStepError()
  }

  const tally = (
    event: Extract<V2Event, { type: "session.step.started" | "session.step.ended" | "session.step.failed" }>,
  ) => {
    if (event.type === "session.step.started") {
      totals.steps += 1
      return
    }
    const tokens = event.data.tokens
    totals.cost += event.data.cost ?? 0
    if (tokens) {
      totals.tokens.input += tokens.input
      totals.tokens.output += tokens.output
      totals.tokens.reasoning += tokens.reasoning
      totals.tokens.cache.read += tokens.cache.read
      totals.tokens.cache.write += tokens.cache.write
    }
    if (input.verbose && input.format === "default" && event.data.cost !== undefined && tokens)
      UI.println(
        UI.Style.TEXT_DIM +
          progress(
            `usage: ${tokens.input} in, ${tokens.output} out, ${tokens.reasoning} reasoning, ${tokens.cache.read} cache read, ${tokens.cache.write} cache write, cost ${event.data.cost}`,
          ) +
          UI.Style.TEXT_NORMAL,
      )
  }

  const consume = async () => {
    while (!controller.signal.aborted) {
      const next = await stream.next().catch((error) => {
        // The stream ending does not hide a failure that is held back, which is reported below.
        if (!emittedError && !pendingStepError) throw error
        return { done: true as const, value: undefined }
      })
      if (next.done) {
        endEvents()
        if (emittedError) return
        throw new Error("Event stream disconnected during prompt execution")
      }
      const event = next.value

      if (event.type === "permission.asked" && submitted && (await ownsSession(event.data.sessionID))) {
        await replyPermission(event.data)
        continue
      }
      if (
        event.type === "form.created" &&
        submitted &&
        ((await ownsSession(event.data.form.sessionID)) ||
          (!input.attached &&
            event.data.form.sessionID === GLOBAL_FORM_SESSION_ID &&
            sameLocation(event.location, input.location)))
      ) {
        await cancelForm(event.data.form)
        continue
      }
      // Steps of this run's own sessions, subagents included, are counted before the filter that keeps only the root
      // session's output. Other clients' sessions on a shared server are not owned and so are not counted.
      if (
        promoted &&
        (input.envelope !== undefined || input.verbose) &&
        (event.type === "session.step.started" ||
          event.type === "session.step.ended" ||
          event.type === "session.step.failed") &&
        (await ownsSession(event.data.sessionID))
      )
        tally(event)
      if (!("sessionID" in event.data) || event.data.sessionID !== input.sessionID) continue
      const time = toMillis("created" in event ? event.created : undefined)

      if (event.type === "session.inbox.delivered") {
        if (event.data.inboxID === messageID) {
          promoted = true
          prePromotionError = undefined
          continue
        }
      }
      if (
        event.type === "session.execution.interrupted" &&
        event.data.reason === "user" &&
        (interrupted || permissionRejected || formCancelled)
      ) {
        // The run was stopped on purpose, so a failure held back is not reported on top of it.
        pendingStepError = undefined
        endEvents()
        return
      }
      if (!promoted && event.type === "session.execution.failed") {
        prePromotionError = event.data.error
        if (finalizing) return
        continue
      }
      if (
        !promoted &&
        finalizing &&
        (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted")
      )
        return
      if (!promoted) continue
      if (lines && input.partial && event.type === "session.text.delta") {
        emit("text_delta", time, {
          messageID: event.data.assistantMessageID,
          ordinal: event.data.ordinal,
          delta: event.data.delta,
        })
        continue
      }
      if (lines && input.partial && input.thinking && event.type === "session.reasoning.delta") {
        emit("reasoning_delta", time, {
          messageID: event.data.assistantMessageID,
          ordinal: event.data.ordinal,
          delta: event.data.delta,
        })
        continue
      }
      if (finalizing && !event.type.startsWith("session.execution.")) continue

      if (event.type === "session.step.started") {
        // Another step means that the runner recovered from the failure it held back.
        pendingStepError = undefined
        const part = {
          id: partID(event.id),
          sessionID: input.sessionID,
          messageID: event.data.assistantMessageID,
          type: "step-start",
          snapshot: event.data.snapshot,
        }
        const label = progress(`> ${event.data.agent} · ${event.data.model.id}`)
        if (input.compatibility === "v1") {
          pendingStep = { timestamp: time, part, label }
          continue
        }
        if (!emit("step_start", time, { part }) && input.format === "default") {
          UI.empty()
          UI.println(label)
          UI.empty()
        }
        continue
      }

      if (event.type === "session.text.started") {
        flushStep()
        starts.set(`text\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`, {
          id: partID(event.id),
          timestamp: time,
        })
        continue
      }
      if (event.type === "session.text.ended") {
        const key = contentKey(event.data.assistantMessageID, event.data.ordinal)
        const started = starts.get(`text\u0000${key}`)
        starts.delete(`text\u0000${key}`)
        const part = {
          id: started?.id ?? partID(event.id),
          sessionID: input.sessionID,
          messageID: event.data.assistantMessageID,
          type: "text",
          text: event.data.text,
          time: { start: started?.timestamp ?? time, end: time },
        }
        renderedText.set(key, event.data.text)
        writeText(part, time)
        continue
      }

      if (event.type === "session.reasoning.started") {
        flushStep()
        starts.set(`reasoning\u0000${contentKey(event.data.assistantMessageID, event.data.ordinal)}`, {
          id: partID(event.id),
          timestamp: time,
        })
        continue
      }
      if (event.type === "session.reasoning.ended" && input.thinking) {
        const key = contentKey(event.data.assistantMessageID, event.data.ordinal)
        const started = starts.get(`reasoning\u0000${key}`)
        starts.delete(`reasoning\u0000${key}`)
        const part = {
          id: started?.id ?? partID(event.id),
          sessionID: input.sessionID,
          messageID: event.data.assistantMessageID,
          type: "reasoning",
          text: event.data.text,
          metadata: event.data.state,
          time: { start: started?.timestamp ?? time, end: time },
        }
        renderedReasoning.set(key, event.data.text)
        writeReasoning(part, time)
        continue
      }

      if (event.type === "session.tool.input.started") {
        flushStep()
        tools.set(toolKey(event.data.assistantMessageID, event.data.id), {
          id: partID(event.id),
          timestamp: time,
          assistantMessageID: event.data.assistantMessageID,
          tool: event.data.name,
          input: {},
          metadata: {},
          content: [],
        })
        continue
      }
      if (event.type === "session.tool.input.ended") {
        const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
        if (current) current.raw = event.data.text
        continue
      }
      if (event.type === "session.tool.input.delta") {
        const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
        if (current) current.raw = (current.raw ?? "") + event.data.delta
        if (lines && input.partial)
          emit("tool_input_delta", time, {
            messageID: event.data.assistantMessageID,
            toolID: event.data.id,
            tool: current?.tool,
            delta: event.data.delta,
          })
        continue
      }
      if (event.type === "session.tool.called") {
        flushStep()
        // A call that goes ahead ends the text before it, which nothing can continue or replace now.
        release()
        const key = toolKey(event.data.assistantMessageID, event.data.id)
        const current = tools.get(key)
        tools.set(key, {
          id: current?.id ?? partID(event.id),
          timestamp: current?.timestamp ?? time,
          assistantMessageID: event.data.assistantMessageID,
          tool: current?.tool ?? "tool",
          input: event.data.input,
          raw: current?.raw,
          provider: { executed: event.data.executed, state: event.data.state },
          providerState: event.data.state,
          metadata: {},
          content: [],
        })
        continue
      }
      if (event.type === "session.tool.progress") {
        const current = tools.get(toolKey(event.data.assistantMessageID, event.data.id))
        if (current) {
          current.metadata = event.data.metadata
        }
        continue
      }
      if (event.type === "session.tool.success") {
        const key = toolKey(event.data.assistantMessageID, event.data.id)
        const current = tools.get(key) ?? fallbackTool(event)
        const tool: SessionMessageAssistantTool = {
          type: "tool",
          id: event.data.id,
          name: current.tool,
          executed: event.data.executed,
          providerState: current.providerState,
          providerResultState: event.data.resultState,
          state: {
            status: "completed",
            input: current.input,
            metadata: event.data.metadata,
            content: event.data.content,
          },
          time: { created: current.timestamp, ran: current.timestamp, completed: time },
        }
        const part: MiniToolPart = {
          partID: current.id,
          sessionID: input.sessionID,
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
        tools.delete(key)
        renderedTools.add(key)
        if (!emit("tool_use", time, { part })) {
          release()
          await input.renderTool(tool)
        }
        continue
      }
      if (event.type === "session.tool.failed") {
        const key = toolKey(event.data.assistantMessageID, event.data.id)
        const current = tools.get(key) ?? fallbackTool(event)
        const error = event.data.error.message
        const metadata = event.data.metadata ?? current.metadata
        const content = event.data.content ?? nonEmptyToolContent(current.content)
        const tool: SessionMessageAssistantTool = {
          type: "tool",
          id: event.data.id,
          name: current.tool,
          executed: event.data.executed,
          providerState: current.providerState,
          providerResultState: event.data.resultState,
          state: {
            status: "error",
            input: current.input,
            metadata,
            content,
            error: event.data.error,
          },
          time: { created: current.timestamp, ran: current.timestamp, completed: time },
        }
        const part: MiniToolPart = {
          partID: current.id,
          sessionID: input.sessionID,
          messageID: event.data.assistantMessageID,
          type: "tool",
          id: event.data.id,
          tool: current.tool,
          state: {
            status: "error",
            input: current.input,
            error,
            metadata: {
              providerCall: current.provider,
              providerResult: { executed: event.data.executed, state: event.data.resultState },
              rawInput: current.raw,
            },
            time: { start: current.timestamp, end: time },
          },
        }
        tools.delete(key)
        renderedTools.add(key)
        if (input.compatibility === "v1" && (permissionRejected || formCancelled)) continue
        if (!emit("tool_use", time, { part })) {
          if (event.data.error.type === "tool.input-truncated" && input.compatibility !== "v1") {
            noteTruncated(event.data.assistantMessageID, current.tool)
            continue
          }
          release()
          if (content && toolOutputText(current.tool, content).trim())
            await input.renderTool({
              ...tool,
              state: {
                status: "completed",
                input: current.input,
                metadata,
                content,
              },
            })
          await input.renderToolError(tool)
          UI.error(error)
        }
        continue
      }

      if (event.type === "session.step.ended") {
        flushStep()
        endStep(event.data.assistantMessageID, event.data.finish)
        const part = {
          id: partID(event.id),
          sessionID: input.sessionID,
          messageID: event.data.assistantMessageID,
          type: "step-finish",
          reason: event.data.finish,
          snapshot: event.data.snapshot,
          cost: event.data.cost,
          tokens: event.data.tokens,
        }
        emit("step_finish", time, { part })
        continue
      }
      if (event.type === "session.step.failed") {
        if (input.compatibility === "v1" && event.data.error.message === "The provider response ended unexpectedly.") {
          pendingStep = undefined
          v1InvalidOutput = true
          continue
        }
        if (interrupted || permissionRejected || formCancelled) continue
        flushStep()
        release()
        if (input.compatibility !== "v1") {
          pendingStepError = { error: event.data.error, time }
          continue
        }
        emittedError = true
        process.exitCode = 1
        if (!emit("error", time, { subtype: "error", error: event.data.error })) UI.error(event.data.error.message)
        continue
      }
      if (event.type === "session.execution.failed") {
        if (input.compatibility === "v1" && (v1InvalidOutput || permissionRejected || formCancelled)) return
        flushStep()
        // What ended the run replaces the failure of a step that was held back.
        pendingStepError = undefined
        endEvents()
        if (event.data.error.type.startsWith("limit.")) limit = event.data.error
        endType = event.data.error.type
        if (!emittedError && !formCancelled) {
          emittedError = true
          process.exitCode = 1
          failure = event.data.error.message
          if (
            !emit("error", time, {
              subtype: subtype({ failed: true, interrupted: false, limit }),
              error: event.data.error,
            })
          )
            UI.error(event.data.error.message)
        }
        return
      }
      if (event.type === "session.execution.interrupted") {
        if (input.compatibility === "v1" && (permissionRejected || formCancelled)) return
        // The failure that was held back says more than the interruption that came after it.
        endEvents()
        if (event.data.reason === "user" && interrupted) process.exitCode = 130
        // A declined tool call ends the step with an interruption; it was already reported above.
        if (event.data.reason !== "user" && !emittedError && !permissionRejected && !formCancelled) {
          emittedError = true
          interruption = event.data.reason
          process.exitCode = 1
          const error = { type: "aborted" as const, message: `Session interrupted: ${event.data.reason}` }
          failure = error.message
          if (!emit("error", time, { subtype: "error", error })) UI.error(error.message)
        }
        return
      }
      if (event.type === "session.execution.succeeded") {
        endEvents()
        return
      }
      if (event.type === "session.synthetic") {
        if (input.compatibility !== "v1")
          replace(
            SessionMessage.ID.fromEvent(Event.ID.make(event.id)),
            event.data.metadata,
            event.data.description,
            time,
          )
        continue
      }
    }
  }

  const projectedMessages = async () => {
    const messages: SessionMessageInfo[] = []
    let cursor: string | undefined
    while (true) {
      const page = await input.client.message.list(
        cursor
          ? { sessionID: input.sessionID, limit: 200, cursor }
          : { sessionID: input.sessionID, limit: 200, order: "desc" },
      )
      for (const message of page.data) {
        if (message.id === messageID) return { found: true, messages: messages.toReversed() }
        messages.push(message)
      }
      cursor = page.cursor.next ?? undefined
      if (!cursor) return { found: false, messages: [] }
    }
  }

  const reconcile = async () => {
    const projected = await projectedMessages()
    structured = structuredAnswer(projected.messages)
    Object.assign(spent, { steps: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    const steps = stepIDs(projected.messages)
    for (const message of projected.messages) {
      if (message.type === "synthetic") {
        replace(message.id, message.metadata, message.description, message.time.created)
        continue
      }
      if (message.type !== "assistant") continue
      // Only a response that finished one of these ways is a step, though what any response spent counts, as the
      // server counts them (a failed or unknown finish is not a step).
      if (steps.has(message.id)) spent.steps += 1
      spent.cost += message.cost ?? 0
      spent.input += message.tokens?.input ?? 0
      spent.output += message.tokens?.output ?? 0
      spent.reasoning += message.tokens?.reasoning ?? 0
      spent.cacheRead += message.tokens?.cache.read ?? 0
      spent.cacheWrite += message.tokens?.cache.write ?? 0
      const timestamp = message.time.completed ?? message.time.created
      let textOrdinal = 0
      let reasoningOrdinal = 0
      for (const item of message.content) {
        if (item.type === "text") {
          const ordinal = textOrdinal++
          const key = contentKey(message.id, ordinal)
          const rendered = renderedText.get(key) ?? ""
          if (rendered === item.text || !item.text.startsWith(rendered)) continue
          const text = item.text.slice(rendered.length)
          writeText(
            {
              id: projectedPartID(message.id, `text-${ordinal}`),
              sessionID: input.sessionID,
              messageID: message.id,
              type: "text",
              text,
              time: { start: message.time.created, end: timestamp },
            },
            timestamp,
          )
          renderedText.set(key, item.text)
          continue
        }
        if (item.type === "reasoning") {
          const ordinal = reasoningOrdinal++
          if (!input.thinking) continue
          const key = contentKey(message.id, ordinal)
          const rendered = renderedReasoning.get(key) ?? ""
          if (rendered === item.text || !item.text.startsWith(rendered)) continue
          const text = item.text.slice(rendered.length)
          const part = {
            id: projectedPartID(message.id, `reasoning-${ordinal}`),
            sessionID: input.sessionID,
            messageID: message.id,
            type: "reasoning",
            text,
            metadata: item.state,
            time: { start: message.time.created, end: timestamp },
          }
          renderedReasoning.set(key, item.text)
          writeReasoning(part, timestamp)
          continue
        }

        const key = toolKey(message.id, item.id)
        if (renderedTools.has(key) || item.state.status === "streaming" || item.state.status === "running") continue
        const part: MiniToolPart = {
          partID: projectedPartID(message.id, `tool-${item.id}`),
          sessionID: input.sessionID,
          messageID: message.id,
          type: "tool",
          id: item.id,
          tool: item.name,
          state:
            item.state.status === "completed"
              ? {
                  status: "completed",
                  input: item.state.input,
                  output: toolOutputText(item.name, item.state.content),
                  title: item.name,
                  metadata: { metadata: item.state.metadata, content: item.state.content },
                  time: { start: item.time.ran ?? item.time.created, end: item.time.completed ?? timestamp },
                }
              : {
                  status: "error",
                  input: item.state.input,
                  error: item.state.error.message,
                  metadata: { metadata: item.state.metadata, content: item.state.content },
                  time: { start: item.time.ran ?? item.time.created, end: item.time.completed ?? timestamp },
                },
        }
        renderedTools.add(key)
        if (emit("tool_use", timestamp, { part })) continue
        if (item.state.status === "error" && item.state.error.type === "tool.input-truncated") {
          noteTruncated(message.id, item.name)
          continue
        }
        release()
        if (item.state.status === "completed") {
          await input.renderTool(item)
          continue
        }
        if (item.state.content && toolOutputText(item.name, item.state.content).trim()) {
          await input.renderTool({
            ...item,
            state: {
              status: "completed",
              input: item.state.input,
              metadata: item.state.metadata,
              content: item.state.content,
            },
          })
        }
        await input.renderToolError(item)
        UI.error(item.state.error.message)
      }

      endStep(message.id, message.finish)
    }
    release()
    // Only the last assistant message counts: a failure that a later step followed was recovered.
    const last = projected.messages.findLast((message) => message.type === "assistant")
    if (last) {
      pendingStepError = last.error ? { error: last.error, time: last.time.completed ?? last.time.created } : undefined
    }
    const failed = projected.messages.findLast((message) => message.type === "idle")?.outcome === "failed"
    // A busy period that failed after a response that failed part way may have been stopped by a limit that the runner
    // checked before retrying, so its terminal event, not the response, says why. The failure is held until that event
    // has been waited for.
    if (!failed || ended) surfaceStepError()
    return {
      found: projected.found,
      failed,
      cutOff: failed || last?.finish === "tool-calls",
      responded: projected.messages.some((message) => message.type === "assistant"),
    }
  }

  const interrupt = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    process.exitCode = 130
    admission?.abort()
    void input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {})
  }
  process.on("SIGINT", interrupt)

  let completed: Promise<void> | undefined
  // Whether the loop has consumed the event that ended the run, which can trail the history and the wait.
  try {
    if (input.agent) {
      await input.client.session.switchAgent({ sessionID: input.sessionID, agent: input.agent })
    }
    const selected = input.model
      ? { providerID: input.model.providerID, id: input.model.modelID, variant: input.variant }
      : input.variant
        ? await input.client.session
            .get({ sessionID: input.sessionID })
            .then((result) => result.model)
            .then(async (model) => {
              if (model) return { ...model, variant: input.variant }
              const result = await input.client.model.default()
              const fallback = result.data
              return fallback ? { providerID: fallback.providerID, id: fallback.id, variant: input.variant } : undefined
            })
        : undefined
    if (input.variant && !selected) throw new Error("Cannot select a variant before selecting a model")
    if (selected) {
      await input.client.session.switchModel({ sessionID: input.sessionID, model: selected })
    }

    const prepared = await Promise.all(input.files.map(prepareFile))
    if (interrupted) return
    submitted = true
    completed = consume().finally(() => {
      ended = true
    })
    admission = new AbortController()
    const response = await input.client.session
      .prompt(
        {
          sessionID: input.sessionID,
          id: messageID,
          text: [input.message, ...prepared.flatMap((file) => (file.text ? [file.text] : []))].join("\n\n"),
          files: prepared.flatMap((file) => (file.attachment ? [file.attachment] : [])),
          delivery: "steer",
          ...(input.turn ? { turn: input.turn } : {}),
        },
        { signal: admission.signal },
      )
      .catch(async (error) => {
        if (interrupted) {
          await input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {})
        }
        controller.abort()
        await completed?.catch(() => {})
        if (interrupted || emittedError) return undefined
        throw error
      })
    admission = undefined
    if (!response) return
    // An older server drops the fields it does not know, so it would run without the limits that were asked for.
    if (input.turn && !echoes(input.turn, response.payload?.turn)) {
      emittedError = true
      process.exitCode = 1
      failure =
        "The server did not accept the limits, fallback model or output schema for this run, so it may be an older version than this client. Update the server, or run without --max-steps, --max-cost, --max-tokens, --fallback-model and --json-schema."
      // Stop reading the stream first, so no event of the withdrawn run is printed before the error.
      controller.abort()
      // The prompt is admitted and its drain may not have started, where an interrupt is a no-op: withdraw it first. An
      // item that was already delivered is left alone by the cancel, and the interrupt then stops its drain.
      await input.client.session.inbox.cancel({ sessionID: input.sessionID, inboxID: messageID }).catch(() => {})
      await input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {})
      await completed?.catch(() => {})
      if (!emit("error", Date.now(), { subtype: "error", error: { type: "version-mismatch", message: failure } }))
        UI.error(failure)
      return
    }
    if (interrupted) await input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {})

    const [permissions, forms, globals] = await Promise.all([
      input.client.permission.list({ sessionID: input.sessionID }).catch(() => undefined),
      input.client.session.form.list({ sessionID: input.sessionID }).catch(() => undefined),
      input.attached
        ? Promise.resolve(undefined)
        : input.client.form
            .list({
              location: { directory: input.location.directory },
            })
            .catch(() => undefined),
    ])
    await Promise.all([
      ...(permissions ?? []).map(replyPermission),
      ...(forms ?? []).map(cancelForm),
      ...(globals && sameLocation(globals.location, input.location)
        ? globals.data.filter((form) => form.sessionID === GLOBAL_FORM_SESSION_ID).map(cancelForm)
        : []),
    ])
    if (input.compatibility === "v1") {
      await completed
      return
    }

    const waiting = input.client.session.wait({ sessionID: input.sessionID })
    await Promise.race([waiting, completed.then(() => waiting)])
    await waitForBackground({
      client: input.client,
      sessionID: input.sessionID,
      location: input.location,
      abandoned: () => interrupted || permissionRejected || formCancelled || emittedError,
    })
    finalizing = true
    const projected = await reconcile()
    const unsettled = !projected.responded
    // A limit stop leaves no error in the history, only a last response that is not a final one, so such a history is
    // not written out as a success before the event that says why has been read. The bound keeps a lost event from
    // hanging the run.
    const cutOff = projected.cutOff && !ended
    if (
      (unsettled || cutOff) &&
      !interrupted &&
      !permissionRejected &&
      !formCancelled &&
      !emittedError &&
      !prePromotionError
    ) {
      const timer = cutOff && !unsettled ? Promise.withResolvers<void>() : undefined
      const timeout = timer && setTimeout(timer.resolve, 5000)
      await (timer ? Promise.race([completed, timer.promise]) : completed).finally(() => clearTimeout(timeout))
    }
    surfaceStepError()
    // The history alone marks a failed run as failed, even when no event said why.
    if (projected.failed && !emittedError && !interrupted && !permissionRejected && !formCancelled) {
      const error = { type: "unknown", message: "The run ended in failure." }
      emittedError = true
      process.exitCode = 1
      failure = error.message
      if (!emit("error", Date.now(), { subtype: "error", error })) UI.error(error.message)
    }
    if (!projected.found && !interrupted && !permissionRejected && !formCancelled && !emittedError) {
      const error = prePromotionError ?? { type: "unknown", message: "Prompt was not promoted" }
      emittedError = true
      process.exitCode = 1
      failure = error.message
      if (!emit("error", Date.now(), { subtype: "error", error })) UI.error(error.message)
    }
    // The step events of the last steps can still be on their way, and the totals count them.
    if (lines) await Promise.race([completed.catch(() => {}), Bun.sleep(3000)])
    reachedEnd = true
  } catch (error) {
    failure ??= errorMessage(error)
    throw error
  } finally {
    // Whatever way the run ends, the text that was waiting for a continuation is written, so a result holds all of it.
    release()
    const failed = !reachedEnd || emittedError || interrupted || permissionRejected || formCancelled
    // A run that stopped at the output limit has an answer that ends in the middle; say so rather than pass it off.
    const truncated = lastFinish === "length"
    if (truncated) {
      const message = "The answer was cut off by the output limit."
      if (!emit("notice", Date.now(), { notice: "truncated", message }))
        UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + message)
    }
    // Every way out of the run prints exactly one result, failed unless the run reached its end cleanly.
    if (lines) {
      writeEnvelopeResult({
        sessionID: input.sessionID,
        text: answer.join("\n\n"),
        failed,
        schema: input.jsonSchema,
        structured,
        subtype: subtype({ failed, interrupted, limit }),
        truncated,
        outcome: interrupted || interruption !== undefined ? "interrupted" : failed ? "failed" : "succeeded",
        reason: !failed
          ? undefined
          : interrupted
            ? "interrupted"
            : interruption !== undefined
              ? interruption
              : failure !== undefined
                ? (failureReason(endType) ?? "error")
                : permissionRejected
                  ? "permission_rejected"
                  : formCancelled
                    ? "form_cancelled"
                    : "incomplete",
        error: failure,
        steps: totals.steps,
        duration: Date.now() - startedAt,
        cost: totals.cost,
        tokens: totals.tokens,
        rejected,
      })
    } else if (schemaText) writeSchemaText(structured, failed)
    else if (input.format === "result")
      writeResult({
        sessionID: input.sessionID,
        text: answer.join("\n\n"),
        failed,
        schema: input.jsonSchema,
        structured,
        subtype: subtype({ failed, interrupted, limit }),
        usage: spent,
        truncated,
        error: failure,
      })
    // Nobody could approve these, so the model went on without them; the exit code does not change.
    if (input.envelope && input.format === "default" && rejected.length > 0)
      UI.println(
        UI.Style.TEXT_WARNING_BOLD + "!",
        UI.Style.TEXT_NORMAL +
          progress(
            `${rejected.length} request${rejected.length === 1 ? " was" : "s were"} auto-rejected: ${rejected.map((request) => request.action).join(", ")}`,
          ),
      )
    process.off("SIGINT", interrupt)
    controller.abort()
    if (input.compatibility === "v1") await stream.return?.(undefined).catch(() => {})
    else void stream.return?.(undefined).catch(() => {})
  }
}

function fallbackTool(event: {
  id: string
  created: number
  data: { assistantMessageID: string; id: string }
}): ToolState {
  return {
    id: partID(event.id),
    timestamp: toMillis(event.created),
    assistantMessageID: event.data.assistantMessageID,
    tool: "tool",
    input: {},
    metadata: {},
    content: [],
  }
}

// One JSON object for scripts: the final answer, whether the run failed, and with a schema, the parsed value.
function writeResult(input: {
  sessionID: string
  text: string
  failed: boolean
  schema: unknown
  structured: { value: unknown } | undefined
  subtype: string
  usage: {
    steps: number
    cost: number
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  truncated: boolean
  error: string | undefined
}) {
  const invalid = input.schema !== undefined && !input.failed && input.structured === undefined
  if (input.failed || invalid) process.exitCode = 1
  markResultWritten()
  process.stdout.write(
    jsonLine({
      type: "result",
      sessionID: input.sessionID,
      is_error: input.failed || invalid,
      subtype: invalid && !input.failed ? "error" : input.subtype,
      result: input.text,
      usage: {
        steps: input.usage.steps,
        cost: input.usage.cost,
        tokens: {
          input: input.usage.input,
          output: input.usage.output,
          reasoning: input.usage.reasoning,
          cache: { read: input.usage.cacheRead, write: input.usage.cacheWrite },
        },
      },
      truncated: input.truncated,
      ...(input.structured === undefined || input.failed ? {} : { structured_output: input.structured.value }),
      ...(invalid
        ? { error: "The run ended without an accepted structured answer." }
        : input.error
          ? { error: input.error }
          : {}),
    }) + EOL,
  )
}

// The result line of the envelope: what writeResult prints, plus how the run ended and what it used.
function writeEnvelopeResult(run: EnvelopeResult) {
  const result = envelopeResultLine(run)
  if (result.failed) process.exitCode = process.exitCode || 1
  markResultWritten()
  process.stdout.write(result.line + EOL)
}

// `orb -p --json-schema` in text format: stdout holds only the accepted answer, and a run without one is an error.
function writeSchemaText(answer: { value: unknown } | undefined, failed: boolean) {
  if (failed || !answer) process.exitCode = process.exitCode || 1
  // The error was already printed when it happened.
  if (failed) return
  if (!answer) return UI.error("The run ended without an accepted structured answer.")
  process.stdout.write(jsonLine(answer.value) + EOL)
}
