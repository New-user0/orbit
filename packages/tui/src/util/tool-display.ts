import type { SessionMessageInfo } from "@orbit/client"
import { ToolNames } from "@orbit/schema/tool-names"

// The views are written against the names and input fields the tools had before they took the reference interface,
// so a call is read under those whichever name it was recorded with.
export function canonicalToolName(name: string) {
  const named = ToolNames.legacy(name)
  if (named === "bash") return "shell"
  if (named === "task") return "subagent"
  if (named === "apply_patch") return "patch"
  return named
}

/** The input of a call under the field names the views read: a call recorded after the rename carries the new ones. */
export function legacyToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown>
export function legacyToolInput(tool: string, input: unknown): unknown
export function legacyToolInput(tool: string, input: unknown) {
  return ToolNames.raiseInput(tool, input)
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

export function primitiveInputSummary(input: Record<string, unknown>, omit: readonly string[] = []) {
  const entries = Object.entries(input).filter(([key, value]) => {
    if (omit.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (entries.length === 0) return ""
  return `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

export type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

export function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!isRecord(call)) return []
    const tool = call.tool
    const status = call.status
    if (typeof tool !== "string" || (status !== "running" && status !== "completed" && status !== "error")) return []
    return [{ tool, status, input: isRecord(call.input) ? call.input : undefined }]
  })
}

export function executeCallSummary(call: ExecuteCall) {
  const args = primitiveInputSummary(call.input ?? {}).replace(/\s+/g, " ")
  return `${call.tool}${args ? ` ${args}` : ""}`
}

export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed" }

/** The todo tool's plan as the model sent it; malformed entries are dropped. */
export function todoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.content !== "string") return []
    const status = entry.status
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return []
    return [{ content: entry.content, status }]
  })
}

/**
 * The plan in the latest assistant message that carries one, whichever name its tool call was recorded with. The plan dock
 * and `/todos` both read it here, so they never disagree.
 */
export function latestTodos(messages: ReadonlyArray<SessionMessageInfo>) {
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue
    // A todo call carries the plan in its input; the task tools report the whole task list in their metadata.
    const call = message.content.findLast(
      (part) =>
        part.type === "tool" &&
        (canonicalToolName(part.name) === "todo" ||
          (canonicalToolName(part.name).startsWith("task_") && toolDisplayMetadata(part.state).todos)),
    )
    if (call?.type !== "tool") continue
    if (canonicalToolName(call.name) !== "todo") return todoItems(toolDisplayMetadata(call.state).todos)
    if (typeof call.state.input !== "string") return todoItems(call.state.input.todos)
  }
  return []
}

export type WorkflowAgent = {
  sessionID: string
  description: string
  agent: string
  status: "running" | "completed" | "failed"
  phase?: string
  model?: string
  started?: number
  ended?: number
  tokens?: number
}

export function workflowAgents(value: unknown): WorkflowAgent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const status = entry.status
    if (typeof entry.sessionID !== "string" || typeof entry.description !== "string" || typeof entry.agent !== "string")
      return []
    if (status !== "running" && status !== "completed" && status !== "failed") return []
    return [
      {
        sessionID: entry.sessionID,
        description: entry.description,
        agent: entry.agent,
        status,
        ...(typeof entry.phase === "string" && entry.phase ? { phase: entry.phase } : {}),
        ...(typeof entry.model === "string" ? { model: entry.model } : {}),
        ...(finiteNumber(entry.started) !== undefined ? { started: finiteNumber(entry.started) } : {}),
        ...(finiteNumber(entry.ended) !== undefined ? { ended: finiteNumber(entry.ended) } : {}),
        ...(finiteNumber(entry.tokens) !== undefined ? { tokens: finiteNumber(entry.tokens) } : {}),
      },
    ]
  })
}

/** Agents grouped by phase in order of first appearance; agents without one share an unnamed group. */
export function workflowPhases(agents: WorkflowAgent[]) {
  const names = [...new Set(agents.map((agent) => agent.phase ?? ""))]
  return names.map((name) => ({ name, agents: agents.filter((agent) => (agent.phase ?? "") === name) }))
}

export function webSearchProviderName(provider: unknown) {
  if (typeof provider !== "string" || !provider) return ""
  if (provider === "orbit") return "Orbit"
  return `${provider[0].toUpperCase()}${provider.slice(1)}`
}

export function webSearchProviderLabel(provider: unknown) {
  const name = webSearchProviderName(provider)
  return name ? `Web Search via ${name}` : "Web Search"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "streaming") return {}
  if (!("metadata" in state) || !state.metadata || typeof state.metadata !== "object") return {}
  if (Array.isArray(state.metadata)) return {}
  return state.metadata as Record<string, unknown>
}

export function toolDisplayContent(state: SessionMessageAssistantTool["state"]) {
  if (state.status === "streaming" || state.status === "running") return []
  return state.content ?? []
}

export function nonEmptyToolContent<T>(content: ReadonlyArray<T> | undefined): [T, ...T[]] | undefined {
  if (!content) return undefined
  const [first, ...rest] = content
  return first === undefined ? undefined : [first, ...rest]
}

/**
 * What a completed Write wrote, read from the diff the tool recorded and never from the model's `content`: an approval
 * answered with the person's own version writes that version instead (class 8). A new file comes with its whole text, the
 * added lines of its diff; a file that was there comes with the diff alone. A call that recorded no diff gives nothing.
 */
export function writtenFile(metadata: Record<string, unknown>) {
  const item: unknown = Array.isArray(metadata.files) ? metadata.files[0] : undefined
  if (!isRecord(item) || typeof item.file !== "string" || item.file === "" || typeof item.patch !== "string") return
  const lines = item.patch.split("\n")
  const start = lines.findIndex((line) => line.startsWith("@@"))
  const body = start === -1 ? [] : lines.slice(start)
  const added = body.filter((line) => line.startsWith("+")).map((line) => line.slice(1))
  const end = added.length === 0 || body.includes("\\ No newline at end of file") ? "" : "\n"
  return { file: item.file, patch: item.patch, text: item.status === "added" ? added.join("\n") + end : undefined }
}
import type { SessionMessageAssistantTool } from "@orbit/client/promise"
import { isRecord } from "./record"
