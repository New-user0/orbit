import { expect, test } from "bun:test"
import { delivered, finished, harness, sessionID, succeeded, type Event } from "../fixture/stream-harness"

// The cost limit of a stream run covers the whole process, as the budget of a long-lived session does: a message that
// is admitted later gets what the earlier ones left, and once nothing is left no message runs. The steps and tokens
// limits stay per message. The client answers from the test's state, so the arithmetic is the driver's own.
const stepStarted: Event = {
  id: "evt_step",
  created: 1,
  type: "session.step.started",
  data: { sessionID, assistantMessageID: "msg_assistant", agent: "build", model: { providerID: "p", id: "m" } },
}

const stepEnded = (cost: number): Event => ({
  id: "evt_step_end",
  created: 2,
  type: "session.step.ended",
  data: {
    sessionID,
    assistantMessageID: "msg_assistant",
    finish: "stop",
    cost,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  },
})

test("each message gets what the earlier ones left of the cost limit, and none runs once it is spent", async () => {
  const h = harness({ turn: { maxCost: 1, maxSteps: 5 } })
  const run = async (text: string, index: number, cost: number) => {
    h.send({ type: "user", text })
    while (h.state.admitted.length <= index) await Bun.sleep(10)
    const id = h.state.admitted[index]
    h.state.messages = finished(id, `answer ${index}`)
    h.emit(delivered(id))
    h.emit(stepStarted)
    h.emit(stepEnded(cost))
    h.emit(succeeded)
    await h.until((line) => line.type === "result" && line.result === `answer ${index}`)
  }

  await run("one", 0, 0.6)
  await run("two", 1, 0.5)
  // The third message finds the budget spent: it is answered with the limit result and never admitted.
  h.send({ type: "user", text: "three" })
  await h.until((line) => line.type === "result" && line.subtype === "error_max_cost")
  h.close()
  h.idle()
  const code = await h.settle()

  expect(h.state.prompts).toHaveLength(2)
  expect(h.state.prompts[0].turn).toEqual({ maxCost: 1, maxSteps: 5 })
  expect(h.state.prompts[1].turn?.maxCost).toBeCloseTo(0.4, 10)
  expect(h.state.prompts[1].turn?.maxSteps).toBe(5)
  // Control: a server that echoes the limits has nothing withdrawn.
  expect(h.state.calls.filter((call) => call.startsWith("cancel"))).toEqual([])
  const results = h.lines.filter((line) => line.type === "result")
  expect(results.map((line) => line.cost)).toEqual([0.6, 0.5, 0])
  expect(results[2]).toMatchObject({ is_error: true, subtype: "error_max_cost", outcome: "failed" })
  expect(code).toBe(1)
}, 30_000)

test("a server that drops the limits it was sent stops the run with a version error", async () => {
  const h = harness({ turn: { maxSteps: 3 } })
  // An older server ignores the fields it does not know, so its echo carries no limits.
  h.state.echo = false
  h.send({ type: "user", text: "one" })
  await h.until((line) => line.type === "error")

  expect(h.lines.find((line) => line.type === "error")?.error).toMatchObject({ type: "version-mismatch" })
  // The admitted prompt is withdrawn before the interrupt, which does nothing for a drain that has not started.
  expect(h.state.calls.slice(0, 2)).toEqual([`cancel:${h.state.admitted[0]}`, "interrupt"])
  expect(await h.settle()).toBe(1)
  expect(h.lines.filter((line) => line.type === "result")).toEqual([
    expect.objectContaining({ is_error: true, outcome: "failed" }),
  ])
}, 30_000)
