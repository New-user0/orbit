import { expect, test } from "bun:test"
import { body, json, jsonLine, plain, progress } from "@orbit/util/plain"

test("the flow path re-exports the one escaper in util", async () => {
  const flow = await import("../src/plain")
  expect(flow.body).toBe(body)
  expect(flow.json).toBe(json)
  expect(flow.jsonLine).toBe(jsonLine)
  expect(flow.plain).toBe(plain)
  expect(flow.progress).toBe(progress)
})
