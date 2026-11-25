import { expect, test } from "bun:test"
import path from "node:path"
import { delivered, harness, sessionID } from "../fixture/stream-harness"

// `end` stops what is running and then finishes. The driver interrupted only once it had seen the first event of the
// message's busy period, so an `end` that came after the message was admitted, while the server was already asking the
// model but before that event reached the driver, stopped nothing: the model call ran to its end and the result said
// `succeeded` (FU-M3-364; `stream > end stops what is running and exits after the result` in docs/known-failures.md,
// which waits for the model to be asked and then sends `end`, so the event can still be in flight on a loaded machine).
test("end sent after a message was admitted, before any event of its busy period, still stops it", async () => {
  const h = harness()
  h.send({ type: "user", text: "go" })
  h.send({ type: "end" })
  // No event yet: the server has the message, and the stream has not told the driver about it.
  const deadline = Date.now() + 10_000
  while (h.state.admitted.length === 0 && Date.now() < deadline) await Bun.sleep(10)
  await Bun.sleep(300)

  expect(h.state.admitted).toHaveLength(1)
  expect(h.state.interrupts).toBeGreaterThanOrEqual(1)
  // A message the server may still hold in its queue is withdrawn first: an interrupt does nothing for a drain that has
  // not started.
  expect(h.state.calls.slice(0, 2)).toEqual([`cancel:${h.state.admitted[0]}`, "interrupt"])

  // The server answers the interrupt as it does: the busy period ends interrupted.
  h.emit(delivered(h.state.admitted[0]))
  h.emit({
    id: "evt_interrupted",
    created: 3,
    type: "session.execution.interrupted",
    data: { sessionID, reason: "user" },
  })
  h.idle()
  expect(await h.settle()).toBe(1)
  expect(h.lines.filter((line) => line.type === "result")).toEqual([expect.objectContaining({ outcome: "interrupted" })])
}, 30_000)

test("end after the busy period's first event stops it: the control for the row above", async () => {
  const h = harness()
  h.send({ type: "user", text: "go" })
  const deadline = Date.now() + 10_000
  while (h.state.admitted.length === 0 && Date.now() < deadline) await Bun.sleep(10)
  h.emit(delivered(h.state.admitted[0]))
  await Bun.sleep(100)
  h.send({ type: "end" })
  await Bun.sleep(300)

  expect(h.state.interrupts).toBeGreaterThanOrEqual(1)
  // The message was delivered, so it is no longer in the queue: it is interrupted, not withdrawn.
  expect(h.state.calls.filter((call) => call.startsWith("cancel:"))).toEqual([])
  h.emit({
    id: "evt_interrupted",
    created: 3,
    type: "session.execution.interrupted",
    data: { sessionID, reason: "user" },
  })
  h.idle()
  expect(await h.settle()).toBe(1)
}, 30_000)

// SIGINT winds the run down: the first fatal() waits for the server to take the interrupt. When the event stream broke
// in that wait, the event loop asked to reconnect, the reconnect returned at once because a fatal stop had begun, and the
// loop read the finished stream again, forever, in microtasks: the process spun at full CPU, never ran a timer or a
// second SIGINT again, and wrote no result (FU-M4-295; `stream > SIGINT gives an interrupted result and exit 130` in
// docs/known-failures.md, which hangs to the harness wait on Linux). The child runs the driver in this state; a timer
// that fires and a second SIGINT that exits it with 130 show that the process is still alive to them.
test("a stream that breaks while the SIGINT's interrupt is still waiting leaves the process answering timers and a second SIGINT", async () => {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "stream-sigint-child.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000)
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  clearTimeout(timer)

  expect({ code, stdout: stdout.trim() }).toEqual({ code: 130, stdout: "responsive" })
}, 30_000)
