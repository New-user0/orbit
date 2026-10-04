import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { TodoTool } from "../src/tool/plugin/todo"

describe("todo tool", () => {
  test("accepts a plan and summarizes progress for the model", () => {
    const input = Schema.decodeUnknownSync(TodoTool.Input)({
      todos: [
        { content: "Find the caller", status: "completed" },
        { content: "Add a retry helper", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    })
    expect(TodoTool.toModelContent(input.todos)).toBe("Plan updated: 1 of 3 done.")
  })

  test("rejects an unknown status", () => {
    expect(() =>
      Schema.decodeUnknownSync(TodoTool.Input)({ todos: [{ content: "Ship it", status: "blocked" }] }),
    ).toThrow()
  })
})
