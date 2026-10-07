import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { classify, modelRef } from "../src/agent"
import { Store } from "../src/store"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-store-"))

afterAll(() => fs.rm(root, { recursive: true, force: true }))

// IDs in the shape that the runner makes.
const first = "run_20260101000001_a1b2c3"
const second = "run_20260101000002_d4e5f6"

test("node state is folded from the event log", () => {
  const store = Store.at(root)
  store.create({ id: first, workflow: "w", file: "w.ts", directory: root, input: { task: "t" } }, { base: "abc" })
  store.append(first, "a", "node.started", { key: "k1" })
  store.append(first, "a", "attempt.started", { attempt: 1 })
  store.append(first, "a", "attempt.started", { attempt: 2 })
  store.append(first, "a", "node.succeeded", { key: "k1", result: { text: "done" } })
  store.append(first, "b", "node.started", { key: "k2" })
  store.append(first, "b", "attempt.started", { attempt: 1 })
  store.append(first, "b", "node.failed", { error: { class: "invalid", message: "no" } })
  store.status(first, "failed", { error: "b failed" })

  const nodes = store.nodes(first)
  expect(nodes.get("a")).toMatchObject({ status: "succeeded", key: "k1", attempts: 2, result: { text: "done" } })
  expect(nodes.get("b")).toMatchObject({ status: "failed", key: "k2", attempts: 1, error: { class: "invalid" } })
  expect(store.run(first)).toMatchObject({ status: "failed", input: { task: "t" } })
  expect(store.events(first)[0]).toMatchObject({ type: "run.started", data: { base: "abc", workflow: "w" } })
  expect(store.runs().map((run) => run.id)).toEqual([first])
  store.close()
})

test("a recorded run survives reopening the store", () => {
  const store = Store.at(root)
  expect(store.nodes(first).get("a")?.status).toBe("succeeded")
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
  store.create({ id: second, workflow: "w", file: "w.ts", directory: root, input: {} })
  store.append(second, "ship", "gate.pending", { message: "Ship it?" })
  expect(store.nodes(second).get("ship")).toMatchObject({ status: "waiting", message: "Ship it?" })
  expect(store.decide(second, "missing", true)).toBe(`No gate missing in run ${second}`)

  expect(store.decide(second, "ship", false, "not yet")).toBeUndefined()

  expect(store.nodes(second).get("ship")).toMatchObject({
    status: "succeeded",
    result: { approved: false, note: "not yet" },
  })
  expect(store.decide(second, "ship", true)).toBe("ship is not waiting for a decision")
  store.close()
})

test("spend lists every attempt with its model, tokens and cost", () => {
  const store = Store.at(root)
  store.append(second, "a", "attempt.ended", { model: "ollama/x", cost: 0.5, input: 10, output: 2 })
  store.append(second, "a", "attempt.ended", { model: "tachyon/y", input: 4, output: 1, error: { class: "invalid" } })
  expect(store.spend(second)).toEqual([
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

// The run store is a file in the repository, so a clone brings its own, and what it holds is not to be trusted: an ID
// that leads out of the folder where worktrees live must never be taken for a run, whoever wrote it in the file.
test("a row whose ID is not one the runner makes is not a run", async () => {
  const directory = await fs.mkdtemp(path.join(root, "hostile-"))
  const valid = "run_20260101000003_0a1b2c"
  const hostile = [
    "../../../victim",
    "../..",
    "..",
    ".",
    "",
    "run_1",
    "run_20260101000003_0A1B2C",
    "run_20260101000003_0a1b2cd",
    "run_2026010100003_0a1b2c",
    "run_20260101000003_0a1b2c/../..",
    "run_20260101000003_0a1b2c\n",
    " run_20260101000003_0a1b2c",
  ]
  Store.at(directory).close()
  // Written as another tool would write them, and newer than the real run, so that they come first.
  const db = new Database(path.join(directory, ".orbit", "runs.db"))
  const insert = db.query(
    "INSERT INTO run (id, workflow, file, directory, input, status, created, updated) VALUES (?, 'w', 'w.ts', ?, '{}', 'succeeded', ?, ?)",
  )
  hostile.forEach((id, index) => insert.run(id, directory, 2_000_000_000_000 + index, 2_000_000_000_000 + index))
  insert.run(valid, directory, 1_000, 1_000)
  db.close()

  const store = Store.at(directory)

  // The limit counts runs, so rows that are not runs cannot push the real ones out of a listing.
  expect(store.runs(1).map((run) => run.id)).toEqual([valid])
  expect(store.runs().map((run) => run.id)).toEqual([valid])
  expect(store.run(valid)).toMatchObject({ id: valid })
  for (const id of hostile) expect(store.run(id)).toBeUndefined()
  store.close()
})
