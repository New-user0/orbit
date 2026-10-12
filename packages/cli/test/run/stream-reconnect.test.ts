import { describe, expect, test } from "bun:test"
import {
  asked,
  delivered,
  finished,
  harness,
  permission,
  replied,
  sessionID,
  succeeded,
} from "../fixture/stream-harness"

const requests = (lines: Array<Record<string, any>>) => lines.filter((line) => line.type === "permission_request")

describe("the event stream drops and comes back", () => {
  test("an ask that arose during the gap is shown once, and then the stream is reported as reconnected", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    h.state.permissions = [permission("per_gap")]
    h.drop()
    await h.until((line) => line.type === "system" && line.subtype === "reconnected")

    expect(requests(h.lines).map((line) => line.request.id)).toEqual(["per_gap"])
    expect(h.lines.findIndex((line) => line.type === "permission_request")).toBeLessThan(
      h.lines.findIndex((line) => line.type === "system"),
    )
    // The server sends it again as an event as well: the driver has shown it already.
    h.emit(asked(permission("per_gap")))
    await Bun.sleep(100)
    expect(requests(h.lines)).toHaveLength(1)

    h.state.messages = finished(h.state.admitted[0], "done")
    h.close()
    await Bun.sleep(100)
    h.emit(succeeded)
    h.idle()
    expect(await h.settle()).toBe(0)
    // The ask was still open when the input closed, so it was rejected with feedback.
    expect(h.state.replies).toEqual([expect.objectContaining({ requestID: "per_gap", decision: "reject" })])
  }, 30_000)

  test("an ask shown before the drop is not shown again, and one settled during the gap is withdrawn", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    h.emit(asked(permission("per_open")))
    h.emit(asked(permission("per_settled")))
    await h.until((line) => line.type === "permission_request" && line.request.id === "per_settled")
    h.state.permissions = [permission("per_open")]
    h.drop()
    await h.until((line) => line.type === "system")

    expect(requests(h.lines).map((line) => line.request.id)).toEqual(["per_open", "per_settled"])
    expect(h.lines.filter((line) => line.type === "request_cancelled")).toEqual([
      expect.objectContaining({ kind: "permission", id: "per_settled", sessionID }),
    ])

    h.state.messages = finished(h.state.admitted[0], "done")
    h.close()
    await Bun.sleep(100)
    h.emit(succeeded)
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)

  test("a busy period that ended during the gap still gets its result", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    // The run ends while the stream is down: no execution event will ever arrive.
    h.state.messages = finished(h.state.admitted[0], "finished in the gap")
    h.drop()
    await h.until((line) => line.type === "result")

    expect(h.lines.filter((line) => line.type === "result")).toEqual([
      expect.objectContaining({ result: "finished in the gap", outcome: "succeeded", is_error: false }),
    ])
    expect(h.lines.findIndex((line) => line.type === "result")).toBeLessThan(
      h.lines.findIndex((line) => line.type === "system"),
    )
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)

  test("a busy period that began and ended inside the gap gets its result at the reconnect, not a failure at the end", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    // Admitted, but neither its delivery nor anything after it reached the driver.
    while (h.state.admitted.length === 0) await Bun.sleep(10)
    h.state.messages = finished(h.state.admitted[0], "all inside the gap")
    h.drop()
    await h.until((line) => line.type === "system" && line.subtype === "reconnected")

    expect(h.lines.filter((line) => line.type === "result")).toEqual([
      expect.objectContaining({ result: "all inside the gap", outcome: "succeeded", is_error: false }),
    ])
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
    expect(h.lines.filter((line) => line.type === "result")).toHaveLength(1)
  }, 30_000)

  test("a message that was delivered during the gap and is still running gets no result yet", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    while (h.state.admitted.length === 0) await Bun.sleep(10)
    h.state.messages = finished(h.state.admitted[0], "partial").slice(1)
    h.drop()
    await h.until((line) => line.type === "system" && line.subtype === "reconnected")
    expect(h.lines.filter((line) => line.type === "result")).toHaveLength(0)

    h.emit(succeeded)
    await h.until((line) => line.type === "result")
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)

  test("a stream that goes silent is treated as dead and reopened", async () => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000, silenceMs: 150 } })
    // The fake reports no activity, which is a connection that sends nothing, not even keepalive comments.
    await h.until((line) => line.type === "system" && line.subtype === "reconnected")
    expect(h.state.subscriptions).toBeGreaterThanOrEqual(2)
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)

  test("a server that never comes back gives an error line, a failed result and exit 1", async () => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 150 } })
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.state.refuse = new Error("connection refused")
    h.drop()

    expect(await h.settle()).toBe(1)
    expect(h.lines.filter((line) => line.type === "error")).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ message: expect.stringContaining("did not come back") }),
      }),
    ])
    expect(h.lines.filter((line) => line.type === "result")).toEqual([
      expect.objectContaining({ is_error: true, outcome: "failed", reason: "error" }),
    ])
    expect(h.state.subscriptions).toBeGreaterThan(2)
  }, 30_000)

  test.each([401, 403, 404])(
    "a %i answer is permanent and is not retried",
    async (status) => {
      const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000 } })
      h.send({ type: "user", text: "go" })
      await Bun.sleep(100)
      h.state.refuse = Object.assign(new Error("Unexpected status"), { cause: { status } })
      h.drop()

      expect(await h.settle()).toBe(1)
      expect(h.state.subscriptions).toBe(2)
      expect(h.lines.filter((line) => line.type === "result")).toHaveLength(1)
    },
    30_000,
  )

  test("a status that may pass is retried", async () => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000 } })
    await Bun.sleep(100)
    h.state.refuse = Object.assign(new Error("Unexpected status"), { cause: { status: 503 } })
    h.drop()
    await Bun.sleep(200)
    expect(h.state.subscriptions).toBeGreaterThan(2)
    h.state.refuse = undefined
    await h.until((line) => line.type === "system")
    h.close()
    h.idle()
    expect(await h.settle()).toBe(0)
  }, 30_000)
})

describe("an interrupt while the server goes away", () => {
  test("a SIGINT with nothing sent writes no result", async () => {
    const h = harness()
    await Bun.sleep(100)
    process.emit("SIGINT")
    h.state.refuse = new Error("connection refused")
    h.drop()

    expect(await h.settle()).toBe(130)
    expect(h.lines.filter((line) => line.type === "result")).toEqual([])
  }, 30_000)

  test("a period whose interrupted result was written is not given a second one when the server goes away", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    await Bun.sleep(50)
    process.emit("SIGINT")
    h.emit({ id: "evt_int", created: 3, type: "session.execution.interrupted", data: { sessionID, reason: "user" } })
    await h.until((line) => line.type === "result")
    h.state.refuse = new Error("connection refused")
    h.drop()
    // After a SIGINT the driver does not resubscribe: it winds down at once.
    await Bun.sleep(300)
    h.idle()

    expect(await h.settle()).toBe(130)
    expect(h.lines.filter((line) => line.type === "result")).toHaveLength(1)
  }, 30_000)
})

describe("a standard output that nobody reads", () => {
  test("the first write error stops the run and interrupts the session it ran", async () => {
    const h = harness({ stdout: true })
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    const before = h.state.interrupts
    // The reader went away: the stream reports the error itself, nothing else interrupts the session.
    process.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
    await h.settle()
    expect(h.state.interrupts).toBeGreaterThan(before)
  }, 30_000)
})

describe("what a failure says reaches the controller as a line that holds no control character", () => {
  test("the message of a refused operation is written out", async () => {
    const h = harness()
    h.state.promptError = new Error("evil\u001b]0;pwned\u0007\u009b31m   ‮")
    h.send({ type: "user", text: "go" })
    await h.until((line) => line.type === "error")

    expect(h.lines.find((line) => line.type === "error")?.error).toMatchObject({ type: "input_failed", input: "user" })
    expect(h.lines.find((line) => line.type === "error")?.error.message).toContain("evil")
    h.raw.forEach((line) => expect(/[\p{C}\p{Zl}\p{Zp}]/u.test(line)).toBe(false))
    h.close()
    h.idle()
    await h.settle()
  }, 30_000)
})

describe("a command moved to the background", () => {
  test("keeps the run open until it has ended and its notice has been answered", async () => {
    const h = harness()
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.emit(delivered(h.state.admitted[0]))
    h.state.messages = finished(h.state.admitted[0], "done")
    h.state.shells = [{ id: "shl_bg", status: "running", metadata: { sessionID } }]
    h.close()
    await Bun.sleep(100)
    h.emit(succeeded)
    h.idle()
    let over = false
    void h.run.then(() => (over = true))
    await Bun.sleep(1200)
    expect(over).toBe(false)

    h.state.shells = []
    h.state.messages = [
      { id: "msg_notice", type: "synthetic", metadata: { source: "shell", shellID: "shl_bg", state: "completed" } },
      ...h.state.messages,
    ]
    expect(await h.settle()).toBe(0)
  }, 30_000)
})
