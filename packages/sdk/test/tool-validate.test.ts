import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "../src"

const Input = Schema.Struct({ path: Schema.String })

test("exports the Promise form of validate and the codes that Orbit gives its own failures", () => {
  const tool: Tool.Info<typeof Input> = {
    name: "lookup",
    description: "Look up a record",
    input: Input,
    validate: async ({ path }, context) => {
      if (path === "")
        throw new Tool.Error({ message: `Call ${context.id} names no path`, code: Tool.ErrorCode.FileNotFound })
    },
    execute: async ({ path }) => ({ content: path }),
  }
  const sync: Tool.Info<typeof Input> = { ...tool, validate: () => {} }

  expect(tool.validate).toBeFunction()
  expect(sync.validate).toBeFunction()
  expect(Tool.ErrorCode.FileNotFound).toBe("file.not-found")
  expect(new Tool.Error({ message: "Missing", code: Tool.ErrorCode.EditNoMatch }).code).toBe("edit.no-match")
})

test("keeps Effect answers out of the Promise form of validate", () => {
  const tool: Tool.Info<typeof Input> = {
    name: "lookup",
    description: "Look up a record",
    input: Input,
    // @ts-expect-error A Promise plugin validates by throwing or by returning a Promise, not an Effect.
    validate: () => Effect.void,
    execute: async ({ path }) => ({ content: path }),
  }

  expect(tool).toBeDefined()
})
