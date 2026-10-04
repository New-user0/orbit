export function canonicalToolName(name: string) {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
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
import type { SessionMessageAssistantTool } from "@orbit/client/promise"
import { isRecord } from "./record"
