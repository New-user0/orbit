import { describe, expect, test } from "bun:test"
import { delivered, harness, sessionID } from "../fixture/stream-harness"

// The history as the server lists it: newest first. Each step is a user message, an answer or the end of a busy period.
type Step = { user: string } | { answer: string } | { idle: "succeeded" | "failed" | "interrupted" }

function history(steps: Step[]) {
  return steps
    .map((step, index) => {
      const time = { created: index + 1 }
      if ("user" in step) return { id: step.user, type: "user", text: "x", time }
      if ("answer" in step)
        return {
          id: `msg_a${index}`,
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: step.answer }],
          time,
        }
      return { id: `msg_i${index}`, type: "idle", outcome: step.idle, time }
    })
    .toReversed()
}

const sent = async (h: ReturnType<typeof harness>, count: number) => {
  while (h.state.admitted.length < count) await Bun.sleep(10)
}

// Every busy period that ran while the stream was down gets the result the live path would have written, and no
// message is left to be reported as a failure when the input closes.
describe("several busy periods inside one gap", () => {
  const rows: Array<{
    name: string
    delivery: "queue" | "steer"
    // Whether the first message's delivery reached the driver before the drop.
    seenFirst: boolean
    steps: (a: string, b: string) => Step[]
    results: Array<{ result: string; outcome: string }>
  }> = [
    {
      name: "a period that was open and a queued message that ran inside the gap",
      delivery: "queue",
      seenFirst: true,
      steps: (a, b) => [
        { user: a },
        { answer: "answer a" },
        { idle: "succeeded" },
        { user: b },
        { answer: "answer b" },
        { idle: "succeeded" },
      ],
      results: [
        { result: "answer a", outcome: "succeeded" },
        { result: "answer b", outcome: "succeeded" },
      ],
    },
    {
      name: "two messages that both ran inside the gap",
      delivery: "queue",
      seenFirst: false,
      steps: (a, b) => [
        { user: a },
        { answer: "answer a" },
        { user: b },
        { answer: "answer b" },
        { idle: "succeeded" },
      ],
      results: [
        { result: "answer a", outcome: "succeeded" },
        { result: "answer b", outcome: "succeeded" },
      ],
    },
    {
      name: "a period that went idle before a queued message ran",
      delivery: "queue",
      seenFirst: true,
      steps: (a, b) => [
        { user: a },
        { answer: "answer a" },
        { idle: "succeeded" },
        { user: b },
        { answer: "answer b" },
        { idle: "failed" },
      ],
      results: [
        { result: "answer a", outcome: "succeeded" },
        { result: "answer b", outcome: "failed" },
      ],
    },
    {
      name: "a period that went idle before a steered message ran",
      delivery: "steer",
      seenFirst: true,
      steps: (a, b) => [
        { user: a },
        { answer: "answer a" },
        { idle: "succeeded" },
        { user: b },
        { answer: "answer b" },
        { idle: "succeeded" },
      ],
      results: [
        { result: "answer a", outcome: "succeeded" },
        { result: "answer b", outcome: "succeeded" },
      ],
    },
  ]

  rows.forEach((row) =>
    test(
      row.name,
      async () => {
        const h = harness()
        h.send({ type: "user", text: "a" })
        await sent(h, 1)
        if (row.seenFirst) h.emit(delivered(h.state.admitted[0]))
        await Bun.sleep(50)
        h.send({ type: "user", text: "b", delivery: row.delivery })
        await sent(h, 2)
        h.state.messages = history(row.steps(h.state.admitted[0], h.state.admitted[1]))
        h.drop()
        await h.until((line) => line.type === "system" && line.subtype === "reconnected")
        h.close()
        h.idle()
        // The exit status follows the last result.
        expect(await h.settle()).toBe(row.results.at(-1)?.outcome === "succeeded" ? 0 : 1)
        expect(h.lines.filter((line) => line.type === "result")).toEqual(
          row.results.map((result) => expect.objectContaining({ ...result, is_error: result.outcome !== "succeeded" })),
        )
      },
      30_000,
    ),
  )

  test("a steered message that is still running after an earlier period ended gets no result yet", async () => {
    const h = harness()
    h.send({ type: "user", text: "a" })
    await sent(h, 1)
    h.emit(delivered(h.state.admitted[0]))
    await Bun.sleep(50)
    h.send({ type: "user", text: "b", delivery: "steer" })
    await sent(h, 2)
    h.state.messages = history([
      { user: h.state.admitted[0] },
      { answer: "answer a" },
      { idle: "succeeded" },
      { user: h.state.admitted[1] },
    ])
    h.drop()
    await h.until((line) => line.type === "system" && line.subtype === "reconnected")
    expect(h.lines.filter((line) => line.type === "result")).toEqual([expect.objectContaining({ result: "answer a" })])
    h.emit({ id: "evt_done", created: 3, type: "session.execution.succeeded", data: { sessionID } })
    await h.until((line) => line.type === "result" && line.result !== "answer a")
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)
})
