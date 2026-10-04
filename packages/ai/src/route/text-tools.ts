import { Option, Schema, Stream } from "effect"
import { ProviderShared } from "../protocols/shared.js"
import {
  LLMRequest,
  Message,
  SystemPart,
  type ContentPart,
  type LLMEvent,
  type ToolDefinition,
  type ToolResultValue,
} from "../schema/index.js"

/**
 * Tool calling through plain text, for models that have no native function calling (compatibility
 * `toolCalling: "text"`). The request carries tool definitions as instructions and earlier tool calls and results as
 * text; the model answers with `<tool_call>{"name": …, "arguments": …}</tool_call>` blocks, which become ordinary
 * tool-call events. A block that is not valid JSON becomes a malformed tool input, which the session reports back to
 * the model so it can retry.
 */
const open = "<tool_call>"
const close = "</tool_call>"

export const applies = (request: LLMRequest) => request.model.compatibility?.toolCalling === "text"

export function lower(request: LLMRequest): LLMRequest {
  const flat = ProviderShared.flattenToolRequest(request)
  const tools = request.toolChoice?.type === "none" ? [] : flat.tools
  return LLMRequest.update(flat.request, {
    system: tools.length === 0 ? request.system : [...request.system, SystemPart.make(instructions(tools, request))],
    messages: mergeAdjacentUsers(flat.request.messages.map(lowerMessage)),
    tools: [],
    toolChoice: undefined,
  })
}

export function raise<E, R>(events: Stream.Stream<LLMEvent, E, R>) {
  return Stream.suspend(() => {
    const blocks = new Map<string, { pending: string; call: string | undefined; text: string }>()
    const state = { calls: 0, lastStep: 0 }

    const parse = (raw: string): LLMEvent => {
      const id = `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`
      const call = decodeCall(raw)
      state.calls++
      if (!call)
        return { type: "tool-input-error", id, name: /"name"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ?? "unknown", raw }
      return { type: "tool-call", id, name: call.name, input: call.arguments }
    }

    // Emit text up to a possible tag, hold back any suffix that could still become one.
    const scan = (id: string, block: { pending: string; call: string | undefined; text: string }): LLMEvent[] => {
      if (block.call !== undefined) {
        const end = block.pending.indexOf(close)
        if (end === -1) return []
        const raw = block.call + block.pending.slice(0, end)
        block.call = undefined
        block.pending = block.pending.slice(end + close.length)
        return [parse(raw), ...scan(id, block)]
      }
      const start = block.pending.indexOf(open)
      if (start !== -1) {
        const text = block.pending.slice(0, start)
        block.call = ""
        block.pending = block.pending.slice(start + open.length)
        return [...emitText(id, block, text), ...scan(id, block)]
      }
      const keep = partialTag(block.pending)
      const text = block.pending.slice(0, block.pending.length - keep)
      block.pending = block.pending.slice(block.pending.length - keep)
      return emitText(id, block, text)
    }

    const emitText = (id: string, block: { text: string }, text: string): LLMEvent[] => {
      if (text === "") return []
      block.text += text
      return [{ type: "text-delta", id, text }]
    }

    // A model often stops right after the arguments without writing the closing tag.
    const flush = (id: string): LLMEvent[] => {
      const block = blocks.get(id)
      if (!block) return []
      blocks.delete(id)
      if (block.call !== undefined) return [parse(block.call + block.pending)]
      return emitText(id, block, block.pending)
    }

    return events.pipe(
      Stream.flatMap((event: LLMEvent): Stream.Stream<LLMEvent> => {
        switch (event.type) {
          case "text-start":
            blocks.set(event.id, { pending: "", call: undefined, text: "" })
            return Stream.make(event)
          case "text-delta": {
            const block = blocks.get(event.id) ?? { pending: "", call: undefined, text: "" }
            blocks.set(event.id, block)
            block.pending += event.text
            return Stream.fromIterable(scan(event.id, block))
          }
          case "text-end": {
            const text = blocks.get(event.id)?.text ?? ""
            const flushed = flush(event.id)
            const final = text + flushed.flatMap((item) => (item.type === "text-delta" ? [item.text] : [])).join("")
            return Stream.fromIterable([...flushed, { ...event, ...(event.text === undefined ? {} : { text: final }) }])
          }
          case "step-finish":
          case "finish": {
            const flushed = [...blocks.keys()].flatMap(flush)
            // The final finish follows the last step-finish, so it reports the calls that step made.
            const calls = event.type === "finish" ? state.calls + state.lastStep : state.calls
            const reason =
              calls > 0 && (event.reason.normalized === "stop" || event.reason.normalized === "unknown")
                ? { ...event.reason, normalized: "tool-calls" as const }
                : event.reason
            if (event.type === "step-finish") {
              state.lastStep = state.calls
              state.calls = 0
            }
            return Stream.fromIterable([...flushed, { ...event, reason }])
          }
          default:
            return Stream.make(event)
        }
      }),
    )
  })
}

function instructions(tools: ReadonlyArray<ToolDefinition>, request: LLMRequest) {
  const choice = request.toolChoice
  return [
    "# Tools",
    "",
    "You can call the tools listed below. To call one, write a block in exactly this form, with the arguments as JSON matching the tool's parameters:",
    "",
    open,
    '{"name": "<tool name>", "arguments": {"<parameter>": "<value>"}}',
    close,
    "",
    "Write one block per call; several blocks call several tools. After your tool calls, stop and wait: each result comes back in a <tool_response> block. Only use these tool names, exactly as written.",
    ...(choice?.type === "required" ? ["", "You must call at least one tool in this reply."] : []),
    ...(choice?.type === "tool" && choice.name ? ["", `You must call the ${choice.name} tool in this reply.`] : []),
    "",
    "## Available tools",
    ...tools.flatMap((tool) => [
      "",
      `### ${tool.name}`,
      tool.description,
      `Parameters: ${JSON.stringify(tool.inputSchema)}`,
    ]),
  ].join("\n")
}

function lowerMessage(message: Message): Message {
  if (message.role === "tool") return new Message({ ...message, role: "user", content: message.content.map(lowerPart) })
  if (!message.content.some((part) => part.type === "tool-call" || part.type === "tool-result")) return message
  return new Message({ ...message, content: message.content.map(lowerPart) })
}

function lowerPart(part: ContentPart): ContentPart {
  if (part.type === "tool-call")
    return Message.text(`${open}\n${JSON.stringify({ name: part.name, arguments: part.input })}\n${close}`)
  if (part.type === "tool-result")
    return Message.text(`<tool_response name="${part.name}">\n${resultText(part.result)}\n</tool_response>`)
  return part
}

function resultText(result: ToolResultValue) {
  if (result.type === "content")
    return result.value.map((item) => (item.type === "text" ? item.text : `[${item.type} omitted]`)).join("\n")
  const text = typeof result.value === "string" ? result.value : JSON.stringify(result.value)
  return result.type === "error" ? `Error: ${text}` : text
}

// Several tool results in a row become one user turn, since chat templates expect user and assistant to alternate.
function mergeAdjacentUsers(messages: ReadonlyArray<Message>) {
  return messages.reduce<Message[]>((merged, message) => {
    const previous = merged.at(-1)
    if (previous?.role !== "user" || message.role !== "user") return [...merged, message]
    return [...merged.slice(0, -1), new Message({ ...previous, content: [...previous.content, ...message.content] })]
  }, [])
}

function partialTag(text: string) {
  const longest = Math.min(text.length, open.length - 1)
  return (
    Array.from({ length: longest }, (_, index) => longest - index).find((size) => open.startsWith(text.slice(-size))) ??
    0
  )
}

function decodeCall(raw: string): { readonly name: string; readonly arguments: unknown } | undefined {
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/```$/, "")
    .trim()
  const value = parseJson(body)
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string") return
  const input = "arguments" in value ? value.arguments : "parameters" in value ? value.parameters : {}
  const args = typeof input === "string" ? parseJson(input) : input
  if (typeof args !== "object" || args === null) return
  return { name: value.name, arguments: args }
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parseJson(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

export * as TextTools from "./text-tools.js"
