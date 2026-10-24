import { expect, spyOn, test } from "bun:test"
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

// The driver's warnings go to standard error; this keeps what it writes there while `run` runs.
async function warnings(run: () => Promise<void>) {
  const written: string[] = []
  const write = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  try {
    await run()
  } finally {
    write.mockRestore()
  }
  return written.join("")
}

// What the client's request rejects with once the driver aborted it.
const abortError = (what: string) => Object.assign(new Error(`${what} request aborted`), { name: "AbortError" })

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

test("a label or suggestion request that fails writes no line but a warning, and the run goes on to its result", async () => {
  const h = harness({ labels: true, suggestions: true })
  const warned = await warnings(async () => {
    await period(h, "one", "succeeded", async () => {
      batch("msg_a", "call_1").forEach((event) => h.emit(event))
      await waitFor(() => h.state.labels.length === 1)
      h.state.labels[0].fail(new Error("label request failed"))
    })
    await waitFor(() => h.state.suggestions.length === 1)
    h.state.suggestions[0].fail(new Error("suggestion request failed"))
    await finish(h)
  })

  expect(warned).toContain("label request failed")
  expect(warned).toContain("suggestion request failed")
  expect(h.state.labels[0].input).toEqual({ sessionID, messageID: "msg_a", toolCallIDs: ["call_1"] })
  const written = h.lines.filter((line) => line.type === "tool_label" || line.type === "prompt_suggestion")
  expect(written).toEqual([])
  expect(h.lines.filter((line) => line.type === "result").map((line) => line.outcome)).toEqual(["succeeded"])
})

const called = (messageID: string, callID: string) => batch(messageID, callID)[0]
const success = (messageID: string, callID: string) => batch(messageID, callID)[1]
const ended = (messageID: string) => batch(messageID, "unused")[2]
const failed = (messageID: string, callID: string): Record<string, unknown> => ({
  id: `evt_failed_${callID}`,
  created: 2,
  type: "session.tool.failed",
  data: {
    sessionID,
    assistantMessageID: messageID,
    id: callID,
    error: { type: "unknown", message: "no such file" },
    executed: false,
  },
})
const labels = (h: ReturnType<typeof harness>) => h.lines.filter((line) => line.type === "tool_label")

test("a batch is asked about once its step ended and every call settled, a failed call too, and its label comes before the result", async () => {
  const h = harness({ labels: true })
  await period(h, "one", "succeeded", async () => {
    ;[called("msg_a", "call_1"), called("msg_a", "call_2"), success("msg_a", "call_1"), ended("msg_a")].forEach(
      (event) => h.emit(event),
    )
    await Bun.sleep(100)
    // call_2 has not settled, so nothing is asked yet.
    expect(h.state.labels).toHaveLength(0)
    h.emit(failed("msg_a", "call_2"))
    await waitFor(() => h.state.labels.length === 1)
    h.state.labels[0].answer({ label: "Read one file" })
    // A second batch whose answer has no label writes nothing.
    batch("msg_b", "call_3").forEach((event) => h.emit(event))
    await waitFor(() => h.state.labels.length === 2)
    h.state.labels[1].answer({ label: null, reason: "empty" })
  })
  await finish(h)

  expect(h.state.labels.map((request) => request.input)).toEqual([
    { sessionID, messageID: "msg_a", toolCallIDs: ["call_1", "call_2"] },
    { sessionID, messageID: "msg_b", toolCallIDs: ["call_3"] },
  ])
  expect(labels(h)).toEqual([
    {
      type: "tool_label",
      timestamp: expect.any(Number),
      sessionID,
      messageID: "msg_a",
      toolIDs: ["call_1", "call_2"],
      label: "Read one file",
    },
  ])
  const at = (type: string) => h.lines.findIndex((line) => line.type === type)
  expect(at("tool_label")).toBeLessThan(at("result"))
})

test("a label answered after its period ended is still written before that period's result", async () => {
  const h = harness({ labels: true })
  await period(h, "one", "succeeded", async () => {
    batch("msg_a", "call_1").forEach((event) => h.emit(event))
    await waitFor(() => h.state.labels.length === 1)
    // The answer arrives only after the period's end has been read, so the result has to wait for it.
    void Bun.sleep(300).then(() => h.state.labels[0].answer({ label: "Read late" }))
  })
  await finish(h)

  const at = (type: string) => h.lines.findIndex((line) => line.type === type)
  expect(labels(h).map((line) => line.label)).toEqual(["Read late"])
  expect(at("tool_label")).toBeLessThan(at("result"))
})

test("an interrupted period drops the label it asked for, and the next period's label is written", async () => {
  const h = harness({ labels: true })
  await period(h, "one", "interrupted", async () => {
    batch("msg_a", "call_1").forEach((event) => h.emit(event))
    await waitFor(() => h.state.labels.length === 1)
    // The answer arrives only after the interruption aborted its request.
    void waitFor(() => h.state.labels[0].signal?.aborted === true).then(() =>
      h.state.labels[0].answer({ label: "late label" }),
    )
  })
  expect(h.state.labels[0].signal?.aborted).toBe(true)

  await period(h, "two", "succeeded", async () => {
    batch("msg_b", "call_2").forEach((event) => h.emit(event))
    await waitFor(() => h.state.labels.length === 2)
    expect(h.state.labels[1].signal?.aborted).toBe(false)
    h.state.labels[1].answer({ label: "Read notes" })
  })
  await finish(h)

  expect(labels(h).map((line) => line.label)).toEqual(["Read notes"])
})

test("a label request an interruption aborted and a suggestion an interrupt line aborted write no warning when they reject", async () => {
  const h = harness({ labels: true, suggestions: true })
  const warned = await warnings(async () => {
    await period(h, "one", "interrupted", async () => {
      batch("msg_a", "call_1").forEach((event) => h.emit(event))
      await waitFor(() => h.state.labels.length === 1)
      void waitFor(() => h.state.labels[0].signal?.aborted === true).then(() =>
        h.state.labels[0].fail(abortError("label")),
      )
    })
    await period(h, "two", "succeeded")
    await waitFor(() => h.state.suggestions.length === 1)
    h.send({ type: "interrupt" })
    await waitFor(() => h.state.interrupts === 1)
    expect(h.state.suggestions[0].signal?.aborted).toBe(true)
    h.state.suggestions[0].fail(abortError("suggestion"))
    await finish(h)
  })

  expect(h.state.labels[0].signal?.aborted).toBe(true)
  expect(warned).not.toContain("request aborted")
  expect(h.lines.filter((line) => line.type === "tool_label" || line.type === "prompt_suggestion")).toEqual([])
})

// An event stream that answers 403 cannot be reopened, which is a fatal stop of the run.
const refuseStream = (h: ReturnType<typeof harness>) => {
  h.state.refuse = Object.assign(new Error("Unexpected status"), { cause: { status: 403 } })
  h.drop()
}

// What stops the run while a suggestion is being written: an end line, a signal and a fatal stop abort the request at
// once, so its answer is not written. Standard input closing is the control: the run waits for that answer.
test.each([
  { stop: "standard input closing", aborted: false },
  { stop: "an end line", aborted: true },
  { stop: "SIGINT", aborted: true },
  { stop: "a fatal stop", aborted: true },
])("$stop with a suggestion in flight: aborted $aborted", async (row) => {
  const h = harness({ suggestions: true })
  await period(h, "one", "succeeded")
  await waitFor(() => h.state.suggestions.length === 1)
  const request = h.state.suggestions[0]

  if (row.stop === "standard input closing") h.close()
  if (row.stop === "an end line") h.send({ type: "end" })
  if (row.stop === "SIGINT") process.emit("SIGINT")
  if (row.stop === "a fatal stop") refuseStream(h)
  // Well under the 5 s the run gives a suggestion before it aborts it on the way out.
  await waitFor(() => request.signal?.aborted === true, 2_000).catch(() => {})
  expect(request.signal?.aborted).toBe(row.aborted)
  request.answer({ suggestion: "late suggestion" })
  h.close()
  h.idle()
  await h.settle()

  expect(suggestions(h)).toEqual(row.aborted ? [] : ["late suggestion"])
})

test("a fatal stop aborts the label in flight, and its answer is not written", async () => {
  const h = harness({ labels: true })
  h.send({ type: "user", text: "one" })
  await waitFor(() => h.state.admitted.length === 1)
  h.emit(delivered(h.state.admitted[0]))
  batch("msg_a", "call_1").forEach((event) => h.emit(event))
  await waitFor(() => h.state.labels.length === 1)

  refuseStream(h)
  await h.until((line) => line.type === "result")
  expect(h.state.labels[0].signal?.aborted).toBe(true)
  h.state.labels[0].answer({ label: "late label" })
  h.close()
  h.idle()

  expect(await h.settle()).toBe(1)
  expect(labels(h)).toEqual([])
  expect(h.lines.filter((line) => line.type === "result")).toEqual([
    expect.objectContaining({ outcome: "failed", reason: "error" }),
  ])
})
