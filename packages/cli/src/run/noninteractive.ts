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
import { SessionMessage } from "@orbit/schema/session-message"
import { EOL } from "node:os"
import { Option, Schema } from "effect"
import { readFile } from "node:fs/promises"
import { nonEmptyToolContent, toolOutputText, type MiniToolPart } from "@orbit/tui/mini/tool"
import { UI } from "./ui"

type Model = {
  providerID: string
  modelID: string
}

type File = {
  url: string
  filename: string
  mime: string
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

// MCP elicitations are temporarily owned by the "global" sentinel instead of a real
// session. An exclusive local process may treat them as this run's blockers; an
// attached client must not cancel input that may belong to another session.
const GLOBAL_FORM_SESSION_ID = "global"

const QUESTION_CANCELLED_FEEDBACK =
  "This non-interactive run cannot ask the user questions, so the question was cancelled. Continue without an answer; make reasonable assumptions and state them."

const PERMISSION_REJECTED_FEEDBACK =
  "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action."

export async function runNonInteractivePrompt(input: Input) {
  const controller = new AbortController()
  const stream = input.client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
  const connected = await stream.next()
  if (connected.done) throw new Error("Event stream disconnected before prompt admission")

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
  let v1InvalidOutput = false
  let prePromotionError: { message: string; [key: string]: unknown } | undefined
  let finalizing = false
  let admission: AbortController | undefined
  let pendingStep: { timestamp: number; part: Record<string, unknown>; label: string } | undefined
  // A step that failed, which the runner may still recover from by continuing after an early end of stream or by
  // switching to a fallback model. The next step to start clears it. It is reported only when the run ends without one.
  let pendingStepError: { error: SessionStructuredError; time: number } | undefined
  let held: Held[] = []
  // The assistant messages whose step ended at the output limit, and the ones that a notice replaced.
  const lengthMessages = new Set<string>()
  const replaced = new Set<string>()
  // Notices that were already shown, so the history does not show again what the events did.
  const shown = new Set<string>()
  // What this session's own responses to this prompt spent (not its subagents'), read from the projected messages when
  // the run ends; and how the last step finished, for the truncation warning.
  const spent = { steps: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let lastFinish: string | undefined
  let limit: SessionStructuredError | undefined
  let failure: string | undefined

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
    if (input.format === "result") return void answer.push(text)
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
  const replace = (metadata: unknown, description: string | undefined, time: number) => {
    const notice = Option.getOrUndefined(decodeEscalation(metadata))
    if (!notice) return showNotice(metadata, description, time)
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
  const showNotice = (metadata: unknown, description: string | undefined, time: number) => {
    const notice = Option.getOrUndefined(decodeNotice(metadata))
    if (!notice || !description) return
    const key = `${notice.notice}\u0000${description}`
    if (shown.has(key)) return
    shown.add(key)
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
    const failure = pendingStepError
    pendingStepError = undefined
    if (!failure || emittedError || permissionRejected || formCancelled) return
    emittedError = true
    process.exitCode = 1
    if (!emit("error", failure.time, { error: failure.error })) UI.error(failure.error.message)
  }

  const writeText = (part: { messageID: string; text: string; [key: string]: unknown }, timestamp: number) => {
    if (emit("text", timestamp, { part })) return
    if (input.compatibility === "v1") return printText(part.text)
    hold(part.messageID, part.text)
  }

  const writeReasoning = (part: { text: string; [key: string]: unknown }, timestamp: number) => {
    if (emit("reasoning", timestamp, { part })) return
    if (input.format === "result") return
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
        if (!emit("error", time, { error: event.data.error })) UI.error(event.data.error.message)
        continue
      }
      if (event.type === "session.execution.failed") {
        if (input.compatibility === "v1" && (v1InvalidOutput || permissionRejected || formCancelled)) return
        flushStep()
        // What ended the run replaces the failure of a step that was held back.
        pendingStepError = undefined
        endEvents()
        if (event.data.error.type.startsWith("limit.")) limit = event.data.error
        if (!emittedError && !formCancelled) {
          emittedError = true
          process.exitCode = 1
          failure = event.data.error.message
          if (!emit("error", time, { subtype: subtype({ failed: true, interrupted: false, limit }), error: event.data.error }))
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
          process.exitCode = 1
          const error = { type: "aborted" as const, message: `Session interrupted: ${event.data.reason}` }
          if (!emit("error", time, { error })) UI.error(error.message)
        }
        return
      }
      if (event.type === "session.execution.succeeded") {
        endEvents()
        return
      }
      if (event.type === "session.synthetic") {
        if (input.compatibility !== "v1") replace(event.data.metadata, event.data.description, time)
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
    Object.assign(spent, { steps: 0, cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    for (const message of projected.messages) {
      if (message.type === "synthetic") {
        replace(message.metadata, message.description, message.time.created)
        continue
      }
      if (message.type !== "assistant") continue
      // A response that failed part way is not a step, though what it spent counts, as the server counts them.
      if (message.finish !== undefined && message.finish !== "error") spent.steps += 1
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
    surfaceStepError()
    return {
      found: projected.found,
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
    completed = consume()
    admission = new AbortController()
    const response = await input.client.session
      .prompt(
        {
          sessionID: input.sessionID,
          id: messageID,
          text: [
            input.message,
            ...prepared.flatMap((file) => (file.text ? [file.text] : [])),
            ...(input.jsonSchema === undefined ? [] : [schemaInstruction(input.jsonSchema)]),
          ].join("\n\n"),
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
        "The server did not accept the limits or fallback model for this run, so it may be an older version than this client. Update the server, or run without --max-steps, --max-cost, --max-tokens and --fallback-model."
      await input.client.session.interrupt({ sessionID: input.sessionID }).catch(() => {})
      controller.abort()
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
    finalizing = true
    const projected = await reconcile()
    if (
      !projected.responded &&
      !interrupted &&
      !permissionRejected &&
      !formCancelled &&
      !emittedError &&
      !prePromotionError
    ) {
      await completed
    }
    if (!projected.found && !interrupted && !permissionRejected && !formCancelled && !emittedError) {
      const error = prePromotionError ?? { type: "unknown", message: "Prompt was not promoted" }
      emittedError = true
      process.exitCode = 1
      if (!emit("error", Date.now(), { error })) UI.error(error.message)
    }
    reachedEnd = true
  } finally {
    // Whatever way the run ends, the text that was waiting for a continuation is written, so a result holds all of it.
    release()
    const failed = !reachedEnd || emittedError || interrupted || permissionRejected || formCancelled
    // A run that stopped at the output limit has an answer that ends in the middle; say so rather than pass it off.
    const truncated = lastFinish === "length"
    if (truncated) {
      const message = "The answer was cut off by the output limit."
      if (!emit("notice", Date.now(), { notice: "truncated", message }) && input.format !== "result")
        UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + message)
    }
    // Every way out of the run prints exactly one result, failed unless the run reached its end cleanly.
    if (input.format === "result")
      writeResult({
        sessionID: input.sessionID,
        text: answer.join("\n\n"),
        failed,
        schema: input.jsonSchema,
        subtype: subtype({ failed, interrupted, limit }),
        usage: spent,
        truncated,
        error: failure,
      })
    process.off("SIGINT", interrupt)
    controller.abort()
    if (input.compatibility === "v1") await stream.return?.(undefined).catch(() => {})
    else void stream.return?.(undefined).catch(() => {})
  }
}

function sameLocation(left: LocationRef | undefined, right: LocationRef) {
  return !!left && left.directory === right.directory
}

function formRequestOptions(location: LocationRef | undefined): [] | [{ headers: Record<string, string> }] {
  if (!location) return []
  return [
    {
      headers: {
        "x-orbit-directory": encodeURIComponent(location.directory),
      },
    },
  ]
}

function formAlreadySettled(error: unknown) {
  return !!error && typeof error === "object" && "_tag" in error && error._tag === "FormAlreadySettledError"
}

function partID(eventID: string) {
  return `prt_${eventID.replace(/^evt_/, "")}`
}

function toolKey(messageID: string, id: string) {
  return `${messageID}\u0000${id}`
}

function contentKey(messageID: string, ordinal: number) {
  return `${messageID}\u0000${ordinal}`
}

function projectedPartID(messageID: string, part: string) {
  return `prt_${messageID.replace(/^msg_/, "")}_${part}`
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

function toMillis(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value === "string") return new Date(value).getTime()
  return Date.now()
}

async function prepareFile(file: File) {
  if (file.mime !== "text/plain") {
    const uri = file.url.startsWith("data:")
      ? file.url
      : `data:${file.mime};base64,${(await readFile(new URL(file.url))).toString("base64")}`
    return { attachment: { uri, name: file.filename } }
  }
  const content = file.url.startsWith("data:")
    ? Buffer.from(file.url.slice(file.url.indexOf(",") + 1), "base64").toString("utf8")
    : await readFile(new URL(file.url), "utf8")
  return { text: `<file name="${file.filename}">\n${content}\n</file>` }
}

function schemaInstruction(schema: unknown) {
  return [
    "Reply with only a JSON value that follows this JSON Schema, with no other text and no code fence:",
    JSON.stringify(schema, null, 2),
  ].join("\n")
}

let resultWritten = false

/** Whether this process already printed its result object, so a late error report does not print a second. */
export function wroteResult() {
  return resultWritten
}

// One JSON object for scripts: the final answer, whether the run failed, and with a schema, the parsed value.
function writeResult(input: {
  sessionID: string
  text: string
  failed: boolean
  schema: unknown
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
  const unfenced = input.text.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")
  const parsed = input.schema === undefined ? undefined : parseJson(unfenced)
  const invalid = input.schema !== undefined && parsed === undefined
  if (input.failed || invalid) process.exitCode = 1
  resultWritten = true
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
      ...(parsed === undefined ? {} : { structured_output: parsed.value }),
      ...(invalid ? { error: "The answer was not valid JSON." } : input.error ? { error: input.error } : {}),
    }) + EOL,
  )
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// The notice that the runner publishes when it raises the output limit and answers again, with the message it replaces.
const decodeEscalation = Schema.decodeUnknownOption(
  Schema.Struct({ notice: Schema.Literal("output-escalation"), replaces: SessionMessage.ID }),
)

const decodeNotice = Schema.decodeUnknownOption(Schema.Struct({ notice: Schema.String }))

// The limit that ended the run names its result subtype. `limit.cost-unknown` is the server refusing a cost limit it
// cannot count, which is a plain error, not a limit that was reached.
function subtype(input: { failed: boolean; interrupted: boolean; limit: SessionStructuredError | undefined }) {
  if (input.interrupted) return "interrupted"
  const type = input.limit?.type
  if (type === "limit.steps") return "error_max_steps"
  if (type === "limit.tokens") return "error_max_tokens"
  if (type === "limit.cost") return "error_max_cost"
  return input.failed ? "error" : "success"
}

// Whether the prompt the server admitted carries what was asked for.
function echoes(sent: SessionTurnOptions, admitted: SessionTurnOptions | undefined) {
  if (!admitted) return false
  const model = (value: SessionTurnOptions["fallbackModel"]) =>
    value && `${value.providerID}/${value.id}#${value.variant ?? ""}`
  return (
    sent.maxSteps === admitted.maxSteps &&
    sent.maxCost === admitted.maxCost &&
    sent.maxTokens === admitted.maxTokens &&
    model(sent.fallbackModel) === model(admitted.fallbackModel)
  )
}

function parseJson(text: string): { value: unknown } | undefined {
  return Option.match(decodeJson(text), { onNone: () => undefined, onSome: (value) => ({ value }) })
}
