import { expect, test } from "bun:test"
import { delivered, finished, harness, sessionID, succeeded } from "../fixture/stream-harness"

// clients-ux-37: what the stream driver does with labels and suggestions while new input arrives or a request fails,
// against a client whose answers the test releases, so the order of an answer and an input line is decided by the test
// and not by timing.

const waitFor = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await Bun.sleep(10)
  }
}

const suggestions = (h: ReturnType<typeof harness>) =>
  h.lines.filter((line) => line.type === "prompt_suggestion").map((line) => line.suggestion)

// Admits a line, runs `meanwhile` while it is running, and ends its period with the given outcome.
async function period(
  h: ReturnType<typeof harness>,
  text: string,
  end: "succeeded" | "interrupted",
  meanwhile = async () => {},
) {
  h.send({ type: "user", text })
  const count = h.state.admitted.length + 1
  await waitFor(() => h.state.admitted.length === count)
  const id = h.state.admitted[count - 1]
  h.emit(delivered(id))
  await meanwhile()
  h.state.messages =
    end === "succeeded"
      ? finished(id, `answer ${text}`)
      : [
          { id: "msg_idle", type: "idle", outcome: "interrupted", time: { created: 5 } },
          { id, type: "user", text, time: { created: 3 } },
        ]
  h.emit(
    end === "succeeded"
      ? succeeded
      : {
          id: "evt_interrupted",
          created: 3,
          type: "session.execution.interrupted",
          data: { sessionID, reason: "user" },
        },
  )
  await waitFor(() => h.lines.filter((line) => line.type === "result").length === count)
}

async function finish(h: ReturnType<typeof harness>) {
  h.close()
  h.idle()
  await h.settle()
}

test("a suggestion answered after a new user line was read is not written, and the next result's is", async () => {
  const h = harness({ suggestions: true })
  await period(h, "one", "succeeded")
  await waitFor(() => h.state.suggestions.length === 1)

  // The first answer arrives only after the line that made it stale was read, while that line runs.
  await period(h, "two", "succeeded", async () => {
    h.state.suggestions[0].answer({ suggestion: "stale suggestion" })
    await Bun.sleep(50)
  })
  await waitFor(() => h.state.suggestions.length === 2)
  h.state.suggestions[1].answer({ suggestion: "fresh suggestion" })
  await h.until((line) => line.type === "prompt_suggestion")
  await finish(h)

  expect(suggestions(h)).toEqual(["fresh suggestion"])
})

test("an interrupt line aborts the suggestion in flight, and its answer is not written", async () => {
  const h = harness({ suggestions: true })
  await period(h, "one", "succeeded")
  await waitFor(() => h.state.suggestions.length === 1)

  h.send({ type: "interrupt" })
  await waitFor(() => h.state.interrupts === 1)
  expect(h.state.suggestions[0].signal?.aborted).toBe(true)
  h.state.suggestions[0].answer({ suggestion: "late suggestion" })
  await finish(h)

  expect(suggestions(h)).toEqual([])
})

test("a result the person interrupted asks for no suggestion; a finished one does (the control)", async () => {
  const h = harness({ suggestions: true })
  await period(h, "one", "interrupted")
  expect(h.state.suggestions).toHaveLength(0)

  await period(h, "two", "succeeded")
  await waitFor(() => h.state.suggestions.length === 1)
  h.state.suggestions[0].answer({ suggestion: null, reason: "early_conversation" })
  await finish(h)

  expect(suggestions(h)).toEqual([])
})

// One finished call of the root session: its call, its result and the end of its step.
const batch = (messageID: string, callID: string): Array<Record<string, unknown>> => [
  {
    id: `evt_called_${callID}`,
    created: 2,
    type: "session.tool.called",
    data: { sessionID, assistantMessageID: messageID, id: callID, input: {}, executed: false },
  },
  {
    id: `evt_success_${callID}`,
    created: 2,
    type: "session.tool.success",
    data: {
      sessionID,
      assistantMessageID: messageID,
      id: callID,
      content: [{ type: "text", text: "ok" }],
      metadata: {},
      executed: false,
    },
  },
  {
    id: `evt_ended_${messageID}`,
    created: 2,
    type: "session.step.ended",
    data: {
      sessionID,
      assistantMessageID: messageID,
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  },
]

test("a label or suggestion request that fails writes no line, and the run goes on to its result", async () => {
  const h = harness({ labels: true, suggestions: true })
  await period(h, "one", "succeeded", async () => {
    batch("msg_a", "call_1").forEach((event) => h.emit(event))
    await waitFor(() => h.state.labels.length === 1)
    h.state.labels[0].fail(new Error("label request failed"))
  })
  await waitFor(() => h.state.suggestions.length === 1)
  h.state.suggestions[0].fail(new Error("suggestion request failed"))
  await finish(h)

  expect(h.state.labels[0].input).toEqual({ sessionID, messageID: "msg_a", toolCallIDs: ["call_1"] })
  const written = h.lines.filter((line) => line.type === "tool_label" || line.type === "prompt_suggestion")
  expect(written).toEqual([])
  expect(h.lines.filter((line) => line.type === "result").map((line) => line.outcome)).toEqual(["succeeded"])
})
