import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { classify, modelRef } from "../src/agent"
import { Store } from "../src/store"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-store-"))

afterAll(() => fs.rm(root, { recursive: true, force: true }))

test("node state is folded from the event log", () => {
  const store = Store.at(root)
  store.create({ id: "run_1", workflow: "w", file: "w.ts", directory: root, input: { task: "t" } }, { base: "abc" })
  store.append("run_1", "a", "node.started", { key: "k1" })
  store.append("run_1", "a", "attempt.started", { attempt: 1 })
  store.append("run_1", "a", "attempt.started", { attempt: 2 })
  store.append("run_1", "a", "node.succeeded", { key: "k1", result: { text: "done" } })
  store.append("run_1", "b", "node.started", { key: "k2" })
  store.append("run_1", "b", "attempt.started", { attempt: 1 })
  store.append("run_1", "b", "node.failed", { error: { class: "invalid", message: "no" } })
  store.status("run_1", "failed", { error: "b failed" })

  const nodes = store.nodes("run_1")
  expect(nodes.get("a")).toMatchObject({ status: "succeeded", key: "k1", attempts: 2, result: { text: "done" } })
  expect(nodes.get("b")).toMatchObject({ status: "failed", key: "k2", attempts: 1, error: { class: "invalid" } })
  expect(store.run("run_1")).toMatchObject({ status: "failed", input: { task: "t" } })
  expect(store.events("run_1")[0]).toMatchObject({ type: "run.started", data: { base: "abc", workflow: "w" } })
  expect(store.runs().map((run) => run.id)).toEqual(["run_1"])
  store.close()
})

test("a recorded run survives reopening the store", () => {
  const store = Store.at(root)
  expect(store.nodes("run_1").get("a")?.status).toBe("succeeded")
  store.close()
})

test("session error types map onto retry classes", () => {
  expect(classify("provider.rate-limit")).toBe("rate-limit")
  expect(classify("provider.transport")).toBe("transient")
  expect(classify("provider.invalid-request")).toBe("invalid")
  expect(classify("provider.content-filter")).toBe("content")
  expect(classify("something.else")).toBe("unknown")
})

test("model references need a provider", () => {
  expect(modelRef("tachyon/claude-opus-4-5@20251101")).toEqual({
    providerID: "tachyon",
    id: "claude-opus-4-5@20251101",
  })
  expect(modelRef("ollama/qwen3:8b").id).toBe("qwen3:8b")
  expect(() => modelRef("gpt-5")).toThrow("provider/model")
})

test("a gate waits until decided, and can only be decided once", () => {
  const store = Store.at(root)
  store.create({ id: "run_2", workflow: "w", file: "w.ts", directory: root, input: {} })
  store.append("run_2", "ship", "gate.pending", { message: "Ship it?" })
  expect(store.nodes("run_2").get("ship")).toMatchObject({ status: "waiting", message: "Ship it?" })
  expect(store.decide("run_2", "missing", true)).toBe("No gate missing in run run_2")

  expect(store.decide("run_2", "ship", false, "not yet")).toBeUndefined()

  expect(store.nodes("run_2").get("ship")).toMatchObject({
    status: "succeeded",
    result: { approved: false, note: "not yet" },
  })
  expect(store.decide("run_2", "ship", true)).toBe("ship is not waiting for a decision")
  store.close()
})

test("spend lists every attempt with its model, tokens and cost", () => {
  const store = Store.at(root)
  store.append("run_2", "a", "attempt.ended", { model: "ollama/x", cost: 0.5, input: 10, output: 2 })
  store.append("run_2", "a", "attempt.ended", { model: "tachyon/y", input: 4, output: 1, error: { class: "invalid" } })
  expect(store.spend("run_2")).toEqual([
    { node: "a", model: "ollama/x", cost: 0.5, input: 10, output: 2 },
    { node: "a", model: "tachyon/y", cost: 0, input: 4, output: 1 },
  ])
  store.close()
})

test("a model's breaker opens after three recent passing failures in a row, across runs", () => {
  const store = Store.at(root)
  const failure = (run: string, model: string, kind: string) =>
    store.append(run, "n", "attempt.ended", { model, error: { class: kind } })
  failure("run_a", "ollama/x", "transient")
  failure("run_b", "ollama/x", "rate-limit")
  expect(store.breaker("ollama/x")).toBe(false)
  failure("run_c", "ollama/x", "timeout")
  expect(store.breaker("ollama/x")).toBe(true)
  expect(store.breaker("ollama/y")).toBe(false)
  // A success closes it; failures that retrying cannot fix never open it.
  store.append("run_c", "n", "attempt.ended", { model: "ollama/x" })
  expect(store.breaker("ollama/x")).toBe(false)
  for (const run of ["run_d", "run_e", "run_f"]) failure(run, "ollama/z", "invalid")
  expect(store.breaker("ollama/z")).toBe(false)
  // Failures older than the window do not count.
  for (const run of ["run_g", "run_h", "run_i"]) failure(run, "ollama/w", "transient")
  expect(store.breaker("ollama/w", 3, -1)).toBe(false)
  store.close()
})
