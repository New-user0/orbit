import { describe, expect, test } from "bun:test"
import { asked, delivered, finished, harness, permission, replied, sessionID, succeeded } from "../fixture/stream-harness"

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

  test("a server that never comes back gives an error line, a failed result and exit 1", async () => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 150 } })
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.state.refuse = new Error("connection refused")
    h.drop()

    expect(await h.settle()).toBe(1)
    expect(h.lines.filter((line) => line.type === "error")).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining("did not come back") }) }),
    ])
    expect(h.lines.filter((line) => line.type === "result")).toEqual([
      expect.objectContaining({ is_error: true, outcome: "failed", reason: "error" }),
    ])
    expect(h.state.subscriptions).toBeGreaterThan(2)
  }, 30_000)

  test.each([401, 403, 404])("a %i answer is permanent and is not retried", async (status) => {
    const h = harness({ reconnect: { baseMs: 5, capMs: 10, giveUpMs: 60_000 } })
    h.send({ type: "user", text: "go" })
    await Bun.sleep(100)
    h.state.refuse = Object.assign(new Error("Unexpected status"), { cause: { status } })
    h.drop()

    expect(await h.settle()).toBe(1)
    expect(h.state.subscriptions).toBe(2)
    expect(h.lines.filter((line) => line.type === "result")).toHaveLength(1)
  }, 30_000)

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
