import type { SessionMessageAssistant, SessionMessageInfo } from "@orbit/client"

function step(id: string, patch: Partial<SessionMessageAssistant> = {}): SessionMessageAssistant {
  return {
    type: "assistant",
    id,
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [],
    time: { created: 2_000, streamed: 6_000, completed: 8_000 },
    tokens: { input: 100, output: 240, reasoning: 0, cache: { read: 0, write: 0 } },
    ...patch,
  }
}

const user: SessionMessageInfo = { type: "user", id: "user", text: "Question", time: { created: 1_000 } }
const failure: NonNullable<SessionMessageAssistant["error"]> = {
  type: "provider",
  message: "The provider closed the stream",
}

export type AssistantFooterFixture = {
  label: string
  /** The conversation the footer belongs to. */
  messages: SessionMessageInfo[]
  /** The assistant message whose footer is drawn. */
  target: string
}

/** Built on demand so the retry countdown starts when a fixture is selected, not when the storybook loads. */
export function assistantFooterFixtures(now = Date.now()): AssistantFooterFixture[] {
  return [
    { label: "plain", messages: [user, step("a", { finish: "stop" })], target: "a" },
    {
      label: "recovered error",
      messages: [user, step("a", { error: failure }), step("b", { finish: "stop" })],
      target: "a",
    },
    {
      label: "continued after output limit",
      messages: [
        user,
        step("a", { finish: "length" }),
        {
          type: "synthetic",
          id: "note",
          text: "Continue",
          metadata: { notice: "output-limit" },
          time: { created: 7_000 },
        },
        step("b", { finish: "stop" }),
      ],
      target: "a",
    },
    {
      label: "retried attempt",
      messages: [
        user,
        step("a", { finish: "length" }),
        {
          type: "synthetic",
          id: "note",
          text: "Retrying with a larger output limit",
          description: "Retrying with a larger output limit",
          metadata: { notice: "output-escalation", replaces: "a" },
          time: { created: 7_000 },
        },
        step("b", { finish: "stop" }),
      ],
      target: "a",
    },
    { label: "final truncation", messages: [user, step("a", { finish: "length" })], target: "a" },
    { label: "terminal error", messages: [user, step("a", { error: failure })], target: "a" },
    {
      label: "retrying",
      messages: [user, step("a", { error: failure, retry: { attempt: 2, at: now + 30_000, error: failure } })],
      target: "a",
    },
  ]
}
