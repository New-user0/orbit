export * as SessionToolText from "./tool-text.js"

import { type ContentPart, Message } from "@orbit/ai"
import type { SessionMessage } from "./message.js"

// A leaf module: Session generation and compaction both need these, and neither may import the other's graph.
const TOOL_OUTPUT_MAX_CHARS = 1_250

export const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value

  // Count code points so a surrogate pair is never split.
  let end = 0
  let kept = 0
  for (const char of value) {
    if (kept === TOOL_OUTPUT_MAX_CHARS) break
    end += char.length
    kept++
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

/**
 * A request message with its tool calls and results written out as transcript text, so that a request that sends no
 * tool definitions can carry it: some providers refuse tool blocks without the definitions. A tool message becomes a
 * user message, the side that providers put a tool result on.
 */
export const withoutToolBlocks = (message: Message) => {
  if (!message.content.some((part) => part.type === "tool-call" || part.type === "tool-result")) return message
  return Message.make({
    id: message.id,
    role: message.role === "tool" ? "user" : message.role,
    content: message.content.map((part) =>
      part.type === "tool-call" || part.type === "tool-result" ? Message.text(toolPartText(part)) : part,
    ),
  })
}

export const toolPartText = (part: Extract<ContentPart, { type: "tool-call" | "tool-result" }>) => {
  if (part.type === "tool-call") return `[Assistant tool call]: ${part.name}(${JSON.stringify(part.input) ?? ""})`
  const result = part.result
  const output =
    result.type === "content"
      ? serializeToolContent(result.value)
      : typeof result.value === "string"
        ? result.value
        : (JSON.stringify(result.value) ?? "")
  return `[${result.type === "error" ? "Tool error" : "Tool result"}]: ${truncateToolOutput(output)}`
}

export const serializeToolContent = (content: ReadonlyArray<SessionMessage.ToolStateCompleted["content"][number]>) =>
  content
    .map((item) => {
      if (item.type === "text") return item.text
      return `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`
    })
    .join("\n")
