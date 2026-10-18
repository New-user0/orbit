export * as History from "./reminder-history.js"

import { Agent } from "@orbit/core/agent"
import { Model } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { SessionMessage } from "@orbit/core/session/message"
import { DateTime } from "effect"

// Builders for projected history, so a producer test drives the real producer over the shapes the projector writes.

const time = { created: DateTime.makeUnsafe(0) }
const modelRef = { providerID: Provider.ID.make("fake"), id: Model.ID.make("fake-model") }

export const user = (text: string) =>
  SessionMessage.User.make({ id: SessionMessage.ID.create(), type: "user", text, time })

export const synthetic = (text: string) =>
  SessionMessage.Synthetic.make({ id: SessionMessage.ID.create(), type: "synthetic", text, time })

export const switched = (agent: string, previous?: string) =>
  SessionMessage.AgentSelected.make({
    id: SessionMessage.ID.create(),
    type: "agent-switched",
    agent: Agent.ID.make(agent),
    ...(previous === undefined ? {} : { previous: Agent.ID.make(previous) }),
    time,
  })

export const checkpoint = () =>
  SessionMessage.CompactionCompleted.make({
    id: SessionMessage.ID.create(),
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "summary",
    recent: "",
    time,
  })

export const text = (value = "ok") => SessionMessage.AssistantText.make({ type: "text", text: value })

export const reasoning = (value = "hm") => SessionMessage.AssistantReasoning.make({ type: "reasoning", text: value })

type ToolState = "completed" | "error"

export const tool = (
  name: string,
  input: Record<string, unknown> = {},
  options: { readonly status?: ToolState; readonly metadata?: Record<string, never> | Record<string, unknown> } = {},
) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: `call_${SessionMessage.ID.create()}`,
    name,
    state:
      options.status === "error"
        ? { status: "error", input, error: { type: "unknown", message: "failed" } }
        : {
            status: "completed",
            input,
            content: [{ type: "text", text: "done" }],
            // The metadata record of a stored call holds JSON only.
            ...(options.metadata === undefined ? {} : { metadata: JSON.parse(JSON.stringify(options.metadata)) }),
          },
    time,
  })

export const todoWrite = (items: ReadonlyArray<readonly [string, string]>, name = "TodoWrite") =>
  tool(name, { todos: items.map(([content, status]) => ({ content, status })) })

export const taskUpdate = (
  status: string,
  items: ReadonlyArray<readonly [string, string]>,
  options: { readonly name?: string; readonly failed?: boolean } = {},
) =>
  tool(
    options.name ?? "TaskUpdate",
    { id: "1", status },
    {
      status: options.failed ? "error" : "completed",
      metadata: { todos: items.map(([content, status]) => ({ content, status })) },
    },
  )

export const assistant = (agent: string, ...content: SessionMessage.AssistantContent[]) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.ID.make(agent),
    model: modelRef,
    content,
    time,
  })
